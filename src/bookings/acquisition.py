from collections.abc import Awaitable, Callable, Sequence
from functools import partial

from sqlalchemy import ColumnElement, and_, delete, exists, func, insert, or_, select
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.bookings.exceptions import SeatsUnavailable
from src.bookings.models import Hold, HoldStatus, SeatClaim
from src.config import get_settings
from src.events.models import Seat


def live_claim_condition() -> ColumnElement[bool]:
    return or_(
        Hold.status == HoldStatus.confirmed,
        and_(Hold.status == HoldStatus.active, Hold.expires_at > func.now()),
    )


def dead_claim_condition() -> ColumnElement[bool]:
    return and_(Hold.status == HoldStatus.active, Hold.expires_at <= func.now())


def claim_rows(hold_id: int, seat_ids: Sequence[int]) -> list[dict[str, int]]:
    return [{"seat_id": seat_id, "hold_id": hold_id} for seat_id in seat_ids]


async def drop_dead_claims(session: AsyncSession, seat_ids: Sequence[int]) -> None:
    dead_holds = select(Hold.id).where(dead_claim_condition())
    await session.execute(
        delete(SeatClaim).where(
            SeatClaim.seat_id.in_(seat_ids), SeatClaim.hold_id.in_(dead_holds)
        )
    )


async def acquire_unique_insert(
    session: AsyncSession, hold_id: int, seat_ids: Sequence[int]
) -> None:
    await drop_dead_claims(session, seat_ids)
    await session.execute(insert(SeatClaim), claim_rows(hold_id, seat_ids))


async def lock_seats(
    session: AsyncSession, seat_ids: Sequence[int], skip_locked: bool
) -> None:
    locked = await session.scalars(
        select(Seat.id)
        .where(Seat.id.in_(seat_ids))
        .order_by(Seat.id)
        .with_for_update(skip_locked=skip_locked)
    )
    if set(locked) != set(seat_ids):
        raise SeatsUnavailable


async def acquire_with_lock(
    session: AsyncSession,
    hold_id: int,
    seat_ids: Sequence[int],
    skip_locked: bool,
) -> None:
    await lock_seats(session, seat_ids, skip_locked)

    taken = await session.scalars(
        select(SeatClaim.seat_id)
        .join(Hold, Hold.id == SeatClaim.hold_id)
        .where(SeatClaim.seat_id.in_(seat_ids), live_claim_condition())
    )
    if set(taken):
        raise SeatsUnavailable

    await session.execute(delete(SeatClaim).where(SeatClaim.seat_id.in_(seat_ids)))
    await session.execute(insert(SeatClaim), claim_rows(hold_id, seat_ids))


async def acquire_upsert(
    session: AsyncSession, hold_id: int, seat_ids: Sequence[int]
) -> None:
    statement = postgres_insert(SeatClaim).values(claim_rows(hold_id, seat_ids))
    existing_claim_is_dead = exists(
        select(Hold.id).where(Hold.id == SeatClaim.hold_id, dead_claim_condition())
    )
    acquired = await session.scalars(
        statement.on_conflict_do_update(
            index_elements=[SeatClaim.seat_id],
            set_={"hold_id": statement.excluded.hold_id},
            where=existing_claim_is_dead,
        ).returning(SeatClaim.seat_id)
    )
    if len(set(acquired)) != len(seat_ids):
        raise SeatsUnavailable


Acquire = Callable[[AsyncSession, int, Sequence[int]], Awaitable[None]]

STRATEGIES: dict[str, Acquire] = {
    "unique_insert": acquire_unique_insert,
    "for_update": partial(acquire_with_lock, skip_locked=False),
    "skip_locked": partial(acquire_with_lock, skip_locked=True),
    "upsert": acquire_upsert,
}


async def acquire_seats(
    session: AsyncSession, hold_id: int, seat_ids: Sequence[int]
) -> None:
    strategy = STRATEGIES[get_settings().seat_acquisition_strategy]
    await strategy(session, hold_id, seat_ids)
