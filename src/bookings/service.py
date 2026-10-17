from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import (
    ColumnElement,
    and_,
    cast,
    delete,
    func,
    literal,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import INTERVAL
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.auth.models import User
from src.bookings.acquisition import acquire_seats, live_claim_condition
from src.bookings.exceptions import (
    BookingNotFound,
    EventNotOnSale,
    HoldNotActive,
    HoldNotFound,
    SaleNotStarted,
    SeatLimitExceeded,
    SeatsNotInEvent,
    SeatsUnavailable,
)
from src.bookings.models import Booking, Hold, HoldStatus, SeatClaim
from src.bookings.schemas import (
    BookingRead,
    HoldRead,
    HoldState,
    SalesSummary,
    SeatAvailability,
)
from src.config import get_settings
from src.events.models import Event, EventStatus, PriceTier, Seat
from src.exceptions import translate
from src.pagination import Page, PageParams
from src.seatmap.connections import send_seat_update


def hold_expiry_expression() -> ColumnElement[datetime]:
    seconds = get_settings().hold_duration_seconds
    return func.now() + cast(literal(f"{seconds} seconds"), INTERVAL)


async def find_hold_by_key(
    session: AsyncSession, user: User, idempotency_key: str
) -> Hold | None:
    return await session.scalar(
        select(Hold).where(
            Hold.user_id == user.id, Hold.idempotency_key == idempotency_key
        )
    )


async def find_booking_by_key(
    session: AsyncSession, user: User, idempotency_key: str
) -> Booking | None:
    return await session.scalar(
        select(Booking).where(
            Booking.user_id == user.id, Booking.idempotency_key == idempotency_key
        )
    )


async def seat_ids_for_hold(session: AsyncSession, hold_id: int) -> list[int]:
    seat_ids = await session.scalars(
        select(SeatClaim.seat_id)
        .where(SeatClaim.hold_id == hold_id)
        .order_by(SeatClaim.seat_id)
    )
    return list(seat_ids)


async def hold_state(session: AsyncSession, hold: Hold) -> HoldState:
    if hold.status is HoldStatus.confirmed:
        return HoldState.confirmed
    if hold.status is HoldStatus.released:
        return HoldState.released
    is_live = await session.scalar(
        select(Hold.expires_at > func.now()).where(Hold.id == hold.id)
    )
    return HoldState.active if is_live else HoldState.expired


async def to_hold_read(session: AsyncSession, hold: Hold) -> HoldRead:
    return HoldRead(
        id=hold.id,
        event_id=hold.event_id,
        seat_ids=await seat_ids_for_hold(session, hold.id),
        state=await hold_state(session, hold),
        expires_at=hold.expires_at,
        created_at=hold.created_at,
    )


def booking_read(booking: Booking, seat_ids: list[int]) -> BookingRead:
    return BookingRead(
        id=booking.id,
        event_id=booking.event_id,
        hold_id=booking.hold_id,
        seat_ids=seat_ids,
        total_cents=booking.total_cents,
        created_at=booking.created_at,
    )


async def to_booking_read(session: AsyncSession, booking: Booking) -> BookingRead:
    return booking_read(booking, await seat_ids_for_hold(session, booking.hold_id))


async def assert_event_on_sale(session: AsyncSession, event: Event) -> None:
    if event.status is not EventStatus.published:
        raise EventNotOnSale
    sale_started = await session.scalar(
        select(Event.sale_starts_at <= func.now()).where(Event.id == event.id)
    )
    if not sale_started:
        raise SaleNotStarted


async def assert_seats_belong_to_event(
    session: AsyncSession, event: Event, seat_ids: Sequence[int]
) -> None:
    found = await session.scalars(
        select(Seat.id).where(Seat.id.in_(seat_ids), Seat.event_id == event.id)
    )
    if set(found) != set(seat_ids):
        raise SeatsNotInEvent


async def count_live_seats_for_user(
    session: AsyncSession, user: User, event: Event
) -> int:
    count = await session.scalar(
        select(func.count())
        .select_from(SeatClaim)
        .join(Hold, Hold.id == SeatClaim.hold_id)
        .where(
            Hold.user_id == user.id,
            Hold.event_id == event.id,
            live_claim_condition(),
        )
    )
    return count or 0


async def create_hold(
    session: AsyncSession,
    user: User,
    event: Event,
    seat_ids: Sequence[int],
    idempotency_key: str | None,
) -> HoldRead:
    if idempotency_key is not None:
        existing = await find_hold_by_key(session, user, idempotency_key)
        if existing is not None:
            return await to_hold_read(session, existing)

    requested = sorted(set(seat_ids))
    await assert_event_on_sale(session, event)
    await assert_seats_belong_to_event(session, event, requested)

    limit = get_settings().max_seats_per_user_per_event
    already_held = await count_live_seats_for_user(session, user, event)
    if already_held + len(requested) > limit:
        raise SeatLimitExceeded

    hold = Hold(
        event_id=event.id,
        user_id=user.id,
        status=HoldStatus.active,
        expires_at=hold_expiry_expression(),
        idempotency_key=idempotency_key,
    )
    try:
        async with session.begin_nested():
            session.add(hold)
            await session.flush()
            await acquire_seats(session, hold.id, requested)
        await session.commit()
    except IntegrityError:
        if idempotency_key is not None:
            concurrent = await find_hold_by_key(session, user, idempotency_key)
            if concurrent is not None:
                return await to_hold_read(session, concurrent)
        raise SeatsUnavailable
    except DBAPIError as error:
        raise translate(error)

    await session.refresh(hold)
    await send_seat_update(
        event.id,
        requested,
        SeatAvailability.held,
        expires_in=get_settings().hold_duration_seconds,
    )
    return await to_hold_read(session, hold)


async def load_owned_hold(session: AsyncSession, user: User, hold_id: int) -> Hold:
    hold = await session.scalar(
        select(Hold).where(Hold.id == hold_id).with_for_update()
    )
    if hold is None or hold.user_id != user.id:
        raise HoldNotFound
    return hold


async def release_hold(session: AsyncSession, user: User, hold_id: int) -> None:
    hold = await load_owned_hold(session, user, hold_id)
    if hold.status is not HoldStatus.active:
        raise HoldNotActive
    seat_ids = await seat_ids_for_hold(session, hold.id)
    await session.execute(delete(SeatClaim).where(SeatClaim.hold_id == hold.id))
    hold.status = HoldStatus.released
    try:
        await session.commit()
    except DBAPIError as error:
        raise translate(error)
    await send_seat_update(hold.event_id, seat_ids, SeatAvailability.available)


async def confirm_hold(
    session: AsyncSession, user: User, hold_id: int, idempotency_key: str | None
) -> BookingRead:
    if idempotency_key is not None:
        existing = await find_booking_by_key(session, user, idempotency_key)
        if existing is not None:
            return await to_booking_read(session, existing)

    hold = await load_owned_hold(session, user, hold_id)
    if hold.status is not HoldStatus.active:
        raise HoldNotActive

    still_live = await session.scalar(
        select(Hold.expires_at > func.now()).where(Hold.id == hold.id)
    )
    if not still_live:
        raise HoldNotActive

    total_cents = await session.scalar(
        select(func.sum(PriceTier.price_cents))
        .select_from(SeatClaim)
        .join(Seat, Seat.id == SeatClaim.seat_id)
        .join(PriceTier, PriceTier.id == Seat.price_tier_id)
        .where(SeatClaim.hold_id == hold.id)
    )
    if not total_cents:
        raise HoldNotActive

    booking = Booking(
        event_id=hold.event_id,
        user_id=user.id,
        hold_id=hold.id,
        total_cents=total_cents,
        idempotency_key=idempotency_key,
    )
    try:
        async with session.begin_nested():
            session.add(booking)
            hold.status = HoldStatus.confirmed
            await session.flush()
        await session.commit()
    except IntegrityError:
        if idempotency_key is not None:
            concurrent = await find_booking_by_key(session, user, idempotency_key)
            if concurrent is not None:
                return await to_booking_read(session, concurrent)
        raise HoldNotActive
    except DBAPIError as error:
        raise translate(error)

    await session.refresh(booking)
    confirmed = await to_booking_read(session, booking)
    await send_seat_update(
        booking.event_id, confirmed.seat_ids, SeatAvailability.booked
    )
    return confirmed


async def list_bookings(
    session: AsyncSession, user: User, page: PageParams
) -> Page[BookingRead]:
    total = await session.scalar(
        select(func.count()).select_from(Booking).where(Booking.user_id == user.id)
    )
    bookings = list(
        await session.scalars(
            select(Booking)
            .where(Booking.user_id == user.id)
            .order_by(Booking.created_at.desc(), Booking.id.desc())
            .limit(page.limit)
            .offset(page.offset)
        )
    )

    hold_ids = [booking.hold_id for booking in bookings]
    claims = await session.execute(
        select(SeatClaim.hold_id, SeatClaim.seat_id)
        .where(SeatClaim.hold_id.in_(hold_ids))
        .order_by(SeatClaim.seat_id)
    )
    seats_by_hold: dict[int, list[int]] = {hold_id: [] for hold_id in hold_ids}
    for hold_id, seat_id in claims.all():
        seats_by_hold[hold_id].append(seat_id)

    items = [booking_read(booking, seats_by_hold[booking.hold_id]) for booking in bookings]
    return Page(items=items, total=total or 0, limit=page.limit, offset=page.offset)


async def get_booking(session: AsyncSession, user: User, booking_id: int) -> BookingRead:
    booking = await session.get(Booking, booking_id)
    if booking is None or booking.user_id != user.id:
        raise BookingNotFound
    return await to_booking_read(session, booking)


async def cancel_booking(session: AsyncSession, user: User, booking_id: int) -> None:
    booking = await session.scalar(
        select(Booking).where(Booking.id == booking_id).with_for_update()
    )
    if booking is None or booking.user_id != user.id:
        raise BookingNotFound
    seat_ids = await seat_ids_for_hold(session, booking.hold_id)
    await session.execute(delete(SeatClaim).where(SeatClaim.hold_id == booking.hold_id))
    await session.execute(
        update(Hold).where(Hold.id == booking.hold_id).values(status=HoldStatus.released)
    )
    await session.delete(booking)
    try:
        await session.commit()
    except DBAPIError as error:
        raise translate(error)
    await send_seat_update(booking.event_id, seat_ids, SeatAvailability.available)


async def seat_availability(
    session: AsyncSession, event_id: int
) -> dict[int, SeatAvailability]:
    rows = await session.execute(
        select(SeatClaim.seat_id, Hold.status)
        .join(Hold, Hold.id == SeatClaim.hold_id)
        .join(Seat, Seat.id == SeatClaim.seat_id)
        .where(Seat.event_id == event_id, live_claim_condition())
    )
    return {
        seat_id: (
            SeatAvailability.booked
            if status is HoldStatus.confirmed
            else SeatAvailability.held
        )
        for seat_id, status in rows.all()
    }


async def sales_summary(session: AsyncSession, event: Event) -> SalesSummary:
    seats_total = (
        select(func.count()).select_from(Seat).where(Seat.event_id == event.id)
    ).scalar_subquery()

    def claimed_seats(condition: ColumnElement[bool]) -> ColumnElement[int]:
        return (
            select(func.count())
            .select_from(SeatClaim)
            .join(Hold, Hold.id == SeatClaim.hold_id)
            .where(Hold.event_id == event.id, condition)
        ).scalar_subquery()

    seats_booked = claimed_seats(Hold.status == HoldStatus.confirmed)
    seats_held = claimed_seats(
        and_(Hold.status == HoldStatus.active, Hold.expires_at > func.now())
    )
    bookings_made = (
        select(func.count()).select_from(Booking).where(Booking.event_id == event.id)
    ).scalar_subquery()
    gross_cents = (
        select(func.coalesce(func.sum(Booking.total_cents), 0)).where(
            Booking.event_id == event.id
        )
    ).scalar_subquery()

    row = (
        await session.execute(
            select(
                seats_total.label("seats_total"),
                seats_booked.label("seats_booked"),
                seats_held.label("seats_held"),
                bookings_made.label("bookings"),
                gross_cents.label("gross_cents"),
            )
        )
    ).one()

    return SalesSummary(
        event_id=event.id,
        seats_total=row.seats_total,
        seats_booked=row.seats_booked,
        seats_held=row.seats_held,
        seats_available=row.seats_total - row.seats_booked - row.seats_held,
        bookings=row.bookings,
        gross_cents=row.gross_cents,
    )
