import asyncio
from collections.abc import Iterator

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from src.bookings.acquisition import STRATEGIES
from src.bookings.models import SeatClaim
from src.config import get_settings
from tests.bookings.conftest import count_rows, open_event, register_buyers

BUYERS = 20


@pytest.fixture(params=list(STRATEGIES))
def strategy(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    monkeypatch.setenv("SEAT_ACQUISITION_STRATEGY", request.param)
    get_settings.cache_clear()
    yield request.param
    monkeypatch.undo()
    get_settings.cache_clear()


async def test_every_strategy_admits_exactly_one_winner(
    strategy: str, committed_client: AsyncClient, engine: AsyncEngine
) -> None:
    assert get_settings().seat_acquisition_strategy == strategy
    event_id, seat_ids = await open_event(committed_client, seat_count=1)
    buyers = await register_buyers(committed_client, BUYERS)

    responses = await asyncio.gather(
        *(
            committed_client.post(
                f"/events/{event_id}/holds",
                json={"seat_ids": seat_ids},
                headers=headers,
            )
            for headers in buyers
        )
    )

    statuses = [response.status_code for response in responses]
    assert statuses.count(201) == 1
    assert set(statuses) <= {201, 409}
    assert await count_rows(engine, SeatClaim) == 1


async def test_every_strategy_holds_all_or_nothing_under_contention(
    strategy: str, committed_client: AsyncClient, engine: AsyncEngine
) -> None:
    event_id, seat_ids = await open_event(committed_client, seat_count=4)
    buyers = await register_buyers(committed_client, BUYERS)

    responses = await asyncio.gather(
        *(
            committed_client.post(
                f"/events/{event_id}/holds",
                json={"seat_ids": seat_ids},
                headers=headers,
            )
            for headers in buyers
        )
    )

    statuses = [response.status_code for response in responses]
    assert statuses.count(201) == 1
    assert await count_rows(engine, SeatClaim) == 4


async def test_every_strategy_allows_disjoint_seats_in_parallel(
    strategy: str, committed_client: AsyncClient, engine: AsyncEngine
) -> None:
    event_id, seat_ids = await open_event(committed_client, seat_count=BUYERS)
    buyers = await register_buyers(committed_client, BUYERS)

    responses = await asyncio.gather(
        *(
            committed_client.post(
                f"/events/{event_id}/holds",
                json={"seat_ids": [seat_id]},
                headers=headers,
            )
            for seat_id, headers in zip(seat_ids, buyers)
        )
    )

    assert [response.status_code for response in responses] == [201] * BUYERS
    assert await count_rows(engine, SeatClaim) == BUYERS


async def test_every_strategy_reclaims_an_expired_hold(
    strategy: str, committed_client: AsyncClient, engine: AsyncEngine
) -> None:
    event_id, seat_ids = await open_event(committed_client, seat_count=1)
    buyers = await register_buyers(committed_client, 2)

    first = await committed_client.post(
        f"/events/{event_id}/holds",
        json={"seat_ids": seat_ids},
        headers=buyers[0],
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await session.execute(
            text("UPDATE holds SET expires_at = now() - interval '1 second'")
        )
        await session.commit()

    second = await committed_client.post(
        f"/events/{event_id}/holds",
        json={"seat_ids": seat_ids},
        headers=buyers[1],
    )

    assert first.status_code == 201
    assert second.status_code == 201
    assert await count_rows(engine, SeatClaim) == 1


async def test_every_strategy_keeps_a_live_hold_while_another_has_expired(
    strategy: str, committed_client: AsyncClient, engine: AsyncEngine
) -> None:
    event_id, seat_ids = await open_event(committed_client, seat_count=2)
    buyers = await register_buyers(committed_client, 3)

    expired = await committed_client.post(
        f"/events/{event_id}/holds",
        json={"seat_ids": [seat_ids[0]]},
        headers=buyers[0],
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        await session.execute(
            text("UPDATE holds SET expires_at = now() - interval '1 second'")
        )
        await session.commit()

    live = await committed_client.post(
        f"/events/{event_id}/holds",
        json={"seat_ids": [seat_ids[1]]},
        headers=buyers[1],
    )
    rival = await committed_client.post(
        f"/events/{event_id}/holds",
        json={"seat_ids": [seat_ids[1]]},
        headers=buyers[2],
    )

    async with factory() as session:
        claimed_by = await session.scalar(
            select(SeatClaim.hold_id).where(SeatClaim.seat_id == seat_ids[1])
        )
    assert expired.status_code == live.status_code == 201
    assert rival.status_code == 409
    assert claimed_by == live.json()["id"]
