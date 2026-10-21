from collections.abc import AsyncIterator

import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient

from src.main import app
from src.middleware import MAX_BODY_BYTES


@pytest.fixture
async def failing_route() -> AsyncIterator[str]:
    async def explode() -> None:
        raise RuntimeError("password=hunter2 in /srv/app/service.py")

    route = APIRoute("/explode", explode)
    app.router.routes.insert(0, route)
    yield "/explode"
    app.router.routes.remove(route)


async def test_unexpected_error_returns_json_without_details(failing_route: str) -> None:
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(failing_route)

    assert response.status_code == 500
    assert response.json() == {"detail": "internal error"}
    assert "hunter2" not in response.text


async def test_responses_carry_security_headers(client: AsyncClient) -> None:
    api = await client.get("/health")
    page = await client.get("/", headers={"Accept": "text/html"})

    for response in (api, page):
        assert response.headers["x-content-type-options"] == "nosniff"
        assert response.headers["x-frame-options"] == "DENY"
        assert response.headers["referrer-policy"] == "strict-origin-when-cross-origin"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


async def test_docs_page_has_no_content_security_policy(client: AsyncClient) -> None:
    response = await client.get("/docs")

    assert response.status_code == 200
    assert "content-security-policy" not in response.headers


async def test_oversized_body_is_rejected(client: AsyncClient) -> None:
    response = await client.post(
        "/auth/login",
        content=b"x" * (MAX_BODY_BYTES + 1),
        headers={"Content-Type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "request body too large"}


async def test_other_origins_get_no_cors_headers(client: AsyncClient) -> None:
    simple = await client.get("/events", headers={"Origin": "https://evil.example"})
    preflight = await client.options(
        "/auth/login",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert "access-control-allow-origin" not in simple.headers
    assert "access-control-allow-origin" not in preflight.headers
