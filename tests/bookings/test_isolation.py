import asyncio
from collections.abc import AsyncIterator

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import create_async_engine

from src.config import get_settings
from tests.bookings.conftest import open_event, register_buyers
from tests.conftest import committing_client

BUYERS = 20
ISOLATION_LEVELS = ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"]


@pytest.fixture(params=ISOLATION_LEVELS)
async def isolated_client(
    request: pytest.FixtureRequest,
) -> AsyncIterator[tuple[AsyncClient, str]]:
    engine = create_async_engine(
        get_settings().test_database_url,
        isolation_level=request.param,
        pool_size=30,
        max_overflow=10,
    )
    async with committing_client(engine) as client:
        yield client, request.param
    await engine.dispose()


async def test_no_oversell_at_any_isolation_level(
    isolated_client: tuple[AsyncClient, str],
) -> None:
    client, level = isolated_client
    event_id, seat_ids = await open_event(client, seat_count=1)
    buyers = await register_buyers(client, BUYERS)

    responses = await asyncio.gather(
        *(
            client.post(
                f"/events/{event_id}/holds",
                json={"seat_ids": seat_ids},
                headers=headers,
            )
            for headers in buyers
        ),
        return_exceptions=True,
    )

    statuses = [
        response.status_code
        for response in responses
        if not isinstance(response, BaseException)
    ]
    assert statuses.count(201) == 1, f"{level} admitted {statuses.count(201)} winners"
    assert set(statuses) <= {201, 409, 503}


async def test_disjoint_seats_still_succeed_at_any_isolation_level(
    isolated_client: tuple[AsyncClient, str],
) -> None:
    client, level = isolated_client
    event_id, seat_ids = await open_event(client, seat_count=BUYERS)
    buyers = await register_buyers(client, BUYERS)

    responses = await asyncio.gather(
        *(
            client.post(
                f"/events/{event_id}/holds",
                json={"seat_ids": [seat_id]},
                headers=headers,
            )
            for seat_id, headers in zip(seat_ids, buyers)
        ),
        return_exceptions=True,
    )

    statuses = [
        response.status_code
        for response in responses
        if not isinstance(response, BaseException)
    ]
    assert 409 not in statuses, f"{level} reported a false conflict on disjoint seats"
    assert statuses.count(201) + statuses.count(503) == BUYERS
    if level != "SERIALIZABLE":
        assert statuses.count(201) == BUYERS
