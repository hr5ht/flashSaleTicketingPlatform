from httpx import AsyncClient


async def test_root_serves_the_frontend(client: AsyncClient) -> None:
    response = await client.get("/", headers={"Accept": "text/html"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert '<main id="view">' in response.text


async def test_frontend_assets_are_served(client: AsyncClient) -> None:
    script = await client.get("/app.js")
    styles = await client.get("/styles.css")

    assert script.status_code == 200
    assert "javascript" in script.headers["content-type"]
    assert styles.status_code == 200


async def test_api_routes_take_priority_over_the_frontend(client: AsyncClient) -> None:
    health = await client.get("/health", headers={"Accept": "text/html"})
    events = await client.get("/events", headers={"Accept": "text/html"})
    missing_event = await client.get("/events/987654")

    assert health.json() == {"status": "ok", "database": "ok"}
    assert events.json()["items"] == []
    assert missing_event.status_code == 404
    assert missing_event.json() == {"detail": "event not found"}


async def test_page_paths_serve_the_frontend(client: AsyncClient) -> None:
    for path in ("/event/1", "/my-bookings", "/manage", "/lab", "/login"):
        response = await client.get(path, headers={"Accept": "text/html"})

        assert response.status_code == 200
        assert '<main id="view">' in response.text
