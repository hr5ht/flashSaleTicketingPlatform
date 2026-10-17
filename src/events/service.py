from sqlalchemy import ColumnElement, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.auth.models import Role, User
from src.bookings.schemas import SeatAvailability
from src.bookings.service import seat_availability
from src.events.exceptions import (
    EventAlreadyPublished,
    EventNotEditable,
    EventNotFound,
    InvalidEventSchedule,
)
from src.events.models import Event, EventStatus, PriceTier, Seat, Section
from src.events.schemas import (
    EventCreate,
    EventQuery,
    EventSummary,
    EventUpdate,
    PriceTierRead,
    SeatMapRead,
    SeatRead,
    SeatRowRead,
    SeatSectionRead,
)
from src.pagination import Page


def min_price_for_event() -> ColumnElement[int]:
    return (
        select(func.min(PriceTier.price_cents))
        .where(PriceTier.event_id == Event.id)
        .scalar_subquery()
    )


async def create_event(
    session: AsyncSession, organizer: User, payload: EventCreate
) -> Event:
    event = Event(
        organizer_id=organizer.id,
        title=payload.title,
        description=payload.description,
        category=payload.category,
        city=payload.city,
        venue=payload.venue,
        starts_at=payload.starts_at,
        sale_starts_at=payload.sale_starts_at,
        status=EventStatus.draft,
    )
    session.add(event)
    await session.flush()

    tiers = {
        tier.name: PriceTier(
            event_id=event.id, name=tier.name, price_cents=tier.price_cents
        )
        for tier in payload.price_tiers
    }
    sections = {
        section.name: Section(event_id=event.id, name=section.name)
        for section in payload.sections
    }
    session.add_all([*tiers.values(), *sections.values()])
    await session.flush()

    seats = [
        {
            "event_id": event.id,
            "section_id": sections[section.name].id,
            "price_tier_id": tiers[row.price_tier].id,
            "row_label": row.label,
            "seat_number": number,
        }
        for section in payload.sections
        for row in section.rows
        for number in range(1, row.seat_count + 1)
    ]
    await session.execute(insert(Seat), seats)
    await session.refresh(event, ["price_tiers"])
    return event


async def get_event(session: AsyncSession, event_id: int) -> Event:
    event = await session.get(Event, event_id, options=[selectinload(Event.price_tiers)])
    if event is None:
        raise EventNotFound
    return event


async def get_visible_event(
    session: AsyncSession, event_id: int, viewer: User | None
) -> Event:
    event = await get_event(session, event_id)
    if event.status is EventStatus.published:
        return event
    if viewer is not None and is_event_manager(event, viewer):
        return event
    raise EventNotFound


def is_event_manager(event: Event, user: User) -> bool:
    return event.organizer_id == user.id or user.role is Role.admin


async def update_event(
    session: AsyncSession, event: Event, payload: EventUpdate
) -> Event:
    if event.status is EventStatus.published:
        raise EventNotEditable

    changes = payload.model_dump(exclude_unset=True)
    starts_at = changes.get("starts_at", event.starts_at)
    sale_starts_at = changes.get("sale_starts_at", event.sale_starts_at)
    if sale_starts_at > starts_at:
        raise InvalidEventSchedule

    for field, value in changes.items():
        setattr(event, field, value)
    await session.flush()
    return event


async def publish_event(session: AsyncSession, event: Event) -> Event:
    if event.status is EventStatus.published:
        raise EventAlreadyPublished
    event.status = EventStatus.published
    await session.flush()
    return event


def build_filter_conditions(query: EventQuery) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if query.city is not None:
        conditions.append(func.lower(Event.city) == query.city.lower())
    if query.category is not None:
        conditions.append(Event.category == query.category)
    if query.starts_after is not None:
        conditions.append(Event.starts_at >= query.starts_after)
    if query.starts_before is not None:
        conditions.append(Event.starts_at <= query.starts_before)
    return conditions


async def list_events(
    session: AsyncSession,
    query: EventQuery,
    status: EventStatus | None = None,
    organizer: User | None = None,
) -> Page[EventSummary]:
    conditions = build_filter_conditions(query)
    if status is not None:
        conditions.append(Event.status == status)
    if organizer is not None:
        conditions.append(Event.organizer_id == organizer.id)

    total = await session.scalar(
        select(func.count()).select_from(Event).where(*conditions)
    )

    rows = await session.execute(
        select(Event, min_price_for_event().label("min_price_cents"))
        .where(*conditions)
        .order_by(Event.starts_at, Event.id)
        .limit(query.limit)
        .offset(query.offset)
    )

    items = [
        EventSummary(
            id=event.id,
            title=event.title,
            category=event.category,
            city=event.city,
            venue=event.venue,
            starts_at=event.starts_at,
            sale_starts_at=event.sale_starts_at,
            status=event.status,
            min_price_cents=min_price_cents,
        )
        for event, min_price_cents in rows.all()
    ]
    return Page(items=items, total=total or 0, limit=query.limit, offset=query.offset)


async def get_seat_map(session: AsyncSession, event: Event) -> SeatMapRead:
    availability = await seat_availability(session, event.id)
    rows = await session.execute(
        select(Section.id, Section.name, Seat)
        .join(Section, Section.id == Seat.section_id)
        .where(Seat.event_id == event.id)
        .order_by(Section.id, Seat.row_label, Seat.seat_number)
    )

    sections: dict[int, SeatSectionRead] = {}
    row_index: dict[tuple[int, str], SeatRowRead] = {}
    for section_id, section_name, seat in rows.all():
        section = sections.get(section_id)
        if section is None:
            section = SeatSectionRead(id=section_id, name=section_name, rows=[])
            sections[section_id] = section
        seat_row = row_index.get((section_id, seat.row_label))
        if seat_row is None:
            seat_row = SeatRowRead(label=seat.row_label, seats=[])
            row_index[(section_id, seat.row_label)] = seat_row
            section.rows.append(seat_row)
        seat_row.seats.append(
            SeatRead(
                id=seat.id,
                number=seat.seat_number,
                price_tier_id=seat.price_tier_id,
                status=availability.get(seat.id, SeatAvailability.available),
            )
        )

    return SeatMapRead(
        event_id=event.id,
        price_tiers=[PriceTierRead.model_validate(tier) for tier in event.price_tiers],
        sections=list(sections.values()),
    )
