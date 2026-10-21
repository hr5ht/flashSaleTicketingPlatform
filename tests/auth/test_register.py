import pytest
from httpx import AsyncClient

from src.config import get_settings


async def test_register_creates_attendee_by_default(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/register",
        json={"email": "ada@example.com", "password": "correct horse"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "ada@example.com"
    assert body["role"] == "attendee"
    assert "password" not in body
    assert "password_hash" not in body


async def test_register_normalizes_email_case(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/register",
        json={"email": "Ada.Lovelace@Example.COM", "password": "correct horse"},
    )

    assert response.status_code == 201
    assert response.json()["email"] == "ada.lovelace@example.com"


async def test_register_rejects_duplicate_email(client: AsyncClient) -> None:
    payload = {"email": "ada@example.com", "password": "correct horse"}
    await client.post("/auth/register", json=payload)

    response = await client.post("/auth/register", json=payload)

    assert response.status_code == 409


async def test_register_rejects_duplicate_email_differing_only_in_case(
    client: AsyncClient,
) -> None:
    await client.post(
        "/auth/register",
        json={"email": "ada@example.com", "password": "correct horse"},
    )

    response = await client.post(
        "/auth/register",
        json={"email": "ADA@EXAMPLE.COM", "password": "correct horse"},
    )

    assert response.status_code == 409


async def test_register_rejects_admin_role(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/register",
        json={"email": "root@example.com", "password": "correct horse", "role": "admin"},
    )

    assert response.status_code == 422


async def test_register_accepts_organizer_role(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/register",
        json={
            "email": "organizer@example.com",
            "password": "correct horse",
            "role": "organizer",
        },
    )

    assert response.status_code == 201
    assert response.json()["role"] == "organizer"


async def test_register_rejects_short_password(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/register",
        json={"email": "ada@example.com", "password": "short"},
    )

    assert response.status_code == 422


async def test_register_rejects_malformed_email(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/register",
        json={"email": "not-an-email", "password": "correct horse"},
    )

    assert response.status_code == 422


async def test_register_is_closed_in_production(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VERCEL_ENV", "production")
    get_settings.cache_clear()
    try:
        response = await client.post(
            "/auth/register",
            json={"email": "ada@example.com", "password": "correct horse"},
        )
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()

    assert response.status_code == 403
    assert response.json()["detail"] == "registration is closed"
