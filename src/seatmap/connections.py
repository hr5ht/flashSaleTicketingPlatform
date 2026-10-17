import asyncio
from collections.abc import Sequence

from fastapi import WebSocket

connections: dict[int, set[WebSocket]] = {}


def add(event_id: int, websocket: WebSocket) -> None:
    connections.setdefault(event_id, set()).add(websocket)


def remove(event_id: int, websocket: WebSocket) -> None:
    sockets = connections.get(event_id)
    if sockets is None:
        return
    sockets.discard(websocket)
    if not sockets:
        del connections[event_id]


async def send_seat_update(
    event_id: int,
    seat_ids: Sequence[int],
    status: str,
    expires_in: int | None = None,
) -> None:
    sockets = list(connections.get(event_id, ()))
    message: dict[str, object] = {"status": status, "seat_ids": list(seat_ids)}
    if expires_in is not None:
        message["expires_in"] = expires_in
    results = await asyncio.gather(
        *(websocket.send_json(message) for websocket in sockets),
        return_exceptions=True,
    )
    for websocket, result in zip(sockets, results):
        if isinstance(result, Exception):
            remove(event_id, websocket)
