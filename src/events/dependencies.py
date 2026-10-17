from typing import Annotated

from fastapi import Depends, Path

from src.auth.dependencies import CurrentUser, OptionalUser
from src.database import SessionDep
from src.events.exceptions import NotEventOwner
from src.events.models import Event
from src.events.service import get_event, get_visible_event, is_event_manager


async def managed_event(
    event_id: Annotated[int, Path()], user: CurrentUser, session: SessionDep
) -> Event:
    event = await get_event(session, event_id)
    if not is_event_manager(event, user):
        raise NotEventOwner
    return event


async def visible_event(
    event_id: Annotated[int, Path()], viewer: OptionalUser, session: SessionDep
) -> Event:
    return await get_visible_event(session, event_id, viewer)


ManagedEvent = Annotated[Event, Depends(managed_event)]
VisibleEvent = Annotated[Event, Depends(visible_event)]
