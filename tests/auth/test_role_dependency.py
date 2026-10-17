from typing import Annotated

import pytest
from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from src.auth.dependencies import require_organizer
from src.auth.models import Role, User
from src.auth.service import register_user
from src.database import get_session
from src.exceptions import AppError, app_error_handler


@pytest.fixture
def guarded_app(session) -> FastAPI:
    guarded = FastAPI()
    guarded.add_exception_handler(AppError, app_error_handler)
    guarded.dependency_overrides[get_session] = lambda: session

    @guarded.get("/organizer-only")
    async def organizer_only(
        user: Annotated[User, Depends(require_organizer)],
    ) -> dict[str, str]:
        return {"email": user.email}

    return guarded


@pytest.fixture
async def guarded_client(guarded_app: FastAPI) -> AsyncClient:
    transport = ASGITransport(app=guarded_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def login(client: AsyncClient, email: str, password: str) -> str:
    response = await client.post(
        "/auth/login", json={"email": email, "password": password}
    )
    return response.json()["access_token"]


async def test_organizer_passes_organizer_guard(
    registered_organizer: dict[str, str],
    client: AsyncClient,
    guarded_client: AsyncClient,
) -> None:
    token = await login(
        client, registered_organizer["email"], registered_organizer["password"]
    )

    response = await guarded_client.get(
        "/organizer-only", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200
    assert response.json()["email"] == registered_organizer["email"]


async def test_attendee_is_refused_by_organizer_guard(
    registered_attendee: dict[str, str],
    client: AsyncClient,
    guarded_client: AsyncClient,
) -> None:
    token = await login(
        client, registered_attendee["email"], registered_attendee["password"]
    )

    response = await guarded_client.get(
        "/organizer-only", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 403


async def test_admin_passes_every_guard(
    session, client: AsyncClient, guarded_client: AsyncClient
) -> None:
    await register_user(session, "admin@example.com", "correct horse", Role.admin)
    token = await login(client, "admin@example.com", "correct horse")

    response = await guarded_client.get(
        "/organizer-only", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200


async def test_guard_refuses_anonymous_request(guarded_client: AsyncClient) -> None:
    response = await guarded_client.get("/organizer-only")

    assert response.status_code == 401
