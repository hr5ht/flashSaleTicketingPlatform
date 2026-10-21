import jwt
import pytest
from httpx import AsyncClient

from src.auth.security import ALGORITHM, UNKNOWN_USER_HASH
from src.config import get_settings


async def test_login_returns_token_pair(registered_attendee: dict[str, str], client: AsyncClient) -> None:
    response = await client.post(
        "/auth/login",
        json={
            "email": registered_attendee["email"],
            "password": registered_attendee["password"],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["refresh_token"]


async def test_login_tokens_carry_expected_claims(
    registered_attendee: dict[str, str], client: AsyncClient
) -> None:
    response = await client.post(
        "/auth/login",
        json={
            "email": registered_attendee["email"],
            "password": registered_attendee["password"],
        },
    )
    settings = get_settings()
    body = response.json()

    access = jwt.decode(
        body["access_token"], settings.jwt_secret_key, algorithms=[ALGORITHM]
    )
    refresh = jwt.decode(
        body["refresh_token"], settings.jwt_secret_key, algorithms=[ALGORITHM]
    )

    assert access["type"] == "access"
    assert refresh["type"] == "refresh"
    assert access["sub"] == refresh["sub"] == registered_attendee["id"]
    assert "role" not in access
    assert refresh["exp"] > access["exp"]


async def test_login_rejects_wrong_password(
    registered_attendee: dict[str, str], client: AsyncClient
) -> None:
    response = await client.post(
        "/auth/login",
        json={"email": registered_attendee["email"], "password": "wrong password"},
    )

    assert response.status_code == 401


async def test_login_rejects_unknown_email_with_same_response_as_wrong_password(
    registered_attendee: dict[str, str], client: AsyncClient
) -> None:
    unknown = await client.post(
        "/auth/login",
        json={"email": "nobody@example.com", "password": "correct horse"},
    )
    wrong_password = await client.post(
        "/auth/login",
        json={"email": registered_attendee["email"], "password": "wrong password"},
    )

    assert unknown.status_code == wrong_password.status_code == 401
    assert unknown.json() == wrong_password.json()


async def test_login_hashes_the_password_even_for_unknown_email(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    checked: list[str] = []

    def record(password: str, hashed: str) -> bool:
        checked.append(hashed)
        return False

    monkeypatch.setattr("src.auth.service.verify_password", record)
    response = await client.post(
        "/auth/login",
        json={"email": "nobody@example.com", "password": "correct horse"},
    )

    assert response.status_code == 401
    assert checked == [UNKNOWN_USER_HASH]


async def test_login_accepts_email_in_any_case(
    registered_attendee: dict[str, str], client: AsyncClient
) -> None:
    response = await client.post(
        "/auth/login",
        json={
            "email": registered_attendee["email"].upper(),
            "password": registered_attendee["password"],
        },
    )

    assert response.status_code == 200
