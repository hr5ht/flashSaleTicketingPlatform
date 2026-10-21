import argparse
import os
import random
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

DEMO_PASSWORD = "demo-password"
DEMO_EMAILS = ("adam@example.com", "ben@example.com")
SEED_BUYERS = 14


def rows(labels: str, seat_count: int, tier: str) -> list[dict[str, Any]]:
    return [{"label": label, "seat_count": seat_count, "price_tier": tier} for label in labels]


EVENTS: list[dict[str, Any]] = [
    {
        "title": "Monsoon Strings: Classical Fusion Night",
        "description": "Sitar, violin and a twelve-piece string ensemble reworking ragas for a monsoon evening under the open sky.",
        "category": "concert",
        "city": "Bengaluru",
        "venue": "Riverside Amphitheatre",
        "starts_in_days": 9,
        "sale_opened_days_ago": 3,
        "booked_share": 0.3,
        "price_tiers": [("Platinum", 4999), ("Gold", 2999), ("Silver", 1499)],
        "sections": [
            ("Front Stalls", rows("ABC", 12, "Platinum")),
            ("Middle Stalls", rows("DEFG", 14, "Gold")),
            ("Balcony", rows("HIJ", 16, "Silver")),
        ],
    },
    {
        "title": "Harbour Hawks vs Deccan Comets: T20 Final",
        "description": "The league final under lights. Twenty overs a side, one trophy, and a sold-out harbour crowd.",
        "category": "sports",
        "city": "Mumbai",
        "venue": "Harbour Cricket Ground",
        "starts_in_days": 16,
        "sale_opened_days_ago": 5,
        "booked_share": 0.4,
        "price_tiers": [("Pavilion", 6500), ("North Stand", 2200), ("East Stand", 900)],
        "sections": [
            ("Pavilion", rows("ABC", 10, "Pavilion")),
            ("North Stand", rows("ABCDE", 14, "North Stand")),
            ("East Stand", rows("ABCDE", 16, "East Stand")),
        ],
    },
    {
        "title": "The Last Monsoon",
        "description": "A two-act drama about three sisters, one crumbling house in Old Delhi and the rain that never stops.",
        "category": "theatre",
        "city": "Delhi",
        "venue": "Old Quarter Black Box",
        "starts_in_days": 23,
        "sale_opened_days_ago": 2,
        "booked_share": 0.25,
        "price_tiers": [("Front", 1800), ("Rear", 1100)],
        "sections": [
            ("Stalls", rows("ABC", 12, "Front") + rows("DEFGH", 12, "Rear")),
        ],
    },
    {
        "title": "Backend at Scale Summit",
        "description": "A day of talks on databases under load, queues, caching and the incidents that taught us all three.",
        "category": "conference",
        "city": "Pune",
        "venue": "Riverfront Convention Centre",
        "starts_in_days": 34,
        "sale_opened_days_ago": 10,
        "booked_share": 0.2,
        "price_tiers": [("Conference Pass", 7999), ("Student Pass", 2499)],
        "sections": [
            ("Hall A", rows("ABCDE", 14, "Conference Pass") + rows("F", 14, "Student Pass")),
        ],
    },
    {
        "title": "Coastline Music Festival",
        "description": "Three stages on the sand, sunset to sunrise. Tickets go on sale soon.",
        "category": "festival",
        "city": "Goa",
        "venue": "Northshore Beach Grounds",
        "starts_in_days": 52,
        "sale_opened_days_ago": -4,
        "booked_share": 0,
        "price_tiers": [("VIP Deck", 9999), ("General", 3499)],
        "sections": [
            ("VIP Deck", rows("AB", 10, "VIP Deck")),
            ("Fan Pit", rows("ABCD", 18, "General")),
        ],
    },
    {
        "title": "Flash Sale Arena",
        "description": "A small venue that is always on sale. The rules lab runs its checks here, and you can grab seats too.",
        "category": "sports",
        "city": "Hyderabad",
        "venue": "Demo Arena",
        "starts_in_days": 60,
        "sale_opened_days_ago": 1,
        "booked_share": 0,
        "price_tiers": [("Arena", 999)],
        "sections": [("Arena Floor", rows("ABCD", 10, "Arena"))],
    },
    {
        "title": "Arena Encore",
        "description": "Next season's opener. The sale opens in a year, so seats can be seen but not held yet.",
        "category": "concert",
        "city": "Hyderabad",
        "venue": "Demo Arena",
        "starts_in_days": 400,
        "sale_opened_days_ago": -365,
        "booked_share": 0,
        "price_tiers": [("Arena", 999)],
        "sections": [("Arena Floor", rows("AB", 10, "Arena"))],
    },
]


def event_payload(spec: dict[str, Any], now: datetime) -> dict[str, Any]:
    starts_at = (now + timedelta(days=spec["starts_in_days"])).replace(
        hour=14, minute=0, second=0, microsecond=0
    )
    return {
        "title": spec["title"],
        "description": spec["description"],
        "category": spec["category"],
        "city": spec["city"],
        "venue": spec["venue"],
        "starts_at": starts_at.isoformat(),
        "sale_starts_at": (now - timedelta(days=spec["sale_opened_days_ago"])).isoformat(),
        "price_tiers": [
            {"name": name, "price_cents": rupees * 100} for name, rupees in spec["price_tiers"]
        ],
        "sections": [{"name": name, "rows": section_rows} for name, section_rows in spec["sections"]],
    }


def ensure_account(client: httpx.Client, email: str, password: str, role: str) -> dict[str, str]:
    registered = client.post(
        "/auth/register", json={"email": email, "password": password, "role": role}
    )
    if registered.status_code not in (201, 403, 409):
        registered.raise_for_status()
    login = client.post("/auth/login", json={"email": email, "password": password})
    login.raise_for_status()
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def book_seats(
    client: httpx.Client,
    event_id: int,
    buyers: list[dict[str, str]],
    share: float,
    rng: random.Random,
) -> int:
    seat_map = client.get(f"/events/{event_id}/seatmap").json()
    seat_rows = [
        [seat["id"] for seat in row["seats"]]
        for section in seat_map["sections"]
        for row in section["rows"]
    ]
    target = int(sum(len(row) for row in seat_rows) * share)
    taken: set[int] = set()
    for headers in buyers:
        if len(taken) >= target:
            break
        row = rng.choice(seat_rows)
        size = rng.randint(2, 5)
        start = rng.randrange(0, max(1, len(row) - size + 1))
        block = [seat_id for seat_id in row[start : start + size] if seat_id not in taken]
        if not block:
            continue
        hold = client.post(f"/events/{event_id}/holds", json={"seat_ids": block}, headers=headers)
        if hold.status_code != 201:
            continue
        client.post(f"/holds/{hold.json()['id']}/confirm", headers=headers).raise_for_status()
        taken.update(block)
    return len(taken)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create demo events through the public API")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--organizer-email", default="organizer@example.com")
    parser.add_argument("--password", default=os.environ.get("SEED_PASSWORD"))
    args = parser.parse_args()
    if not args.password:
        parser.error("pass --password or set SEED_PASSWORD (used for the organizer and seed buyers)")
    return args


def main() -> None:
    args = parse_args()
    now = datetime.now(UTC)
    rng = random.Random(7)
    with httpx.Client(base_url=args.base_url, timeout=60) as client:
        organizer = ensure_account(client, args.organizer_email, args.password, "organizer")
        for email in DEMO_EMAILS:
            ensure_account(client, email, DEMO_PASSWORD, "attendee")
        published = client.get("/events", params={"limit": 100}).json()
        mine = client.get("/events/mine", params={"limit": 100}, headers=organizer).json()
        existing = {event["title"] for event in published["items"] + mine["items"]}
        missing = [spec for spec in EVENTS if spec["title"] not in existing]
        buyers = []
        if any(spec["booked_share"] for spec in missing):
            buyers = [
                ensure_account(client, f"buyer{index}@example.com", args.password, "attendee")
                for index in range(SEED_BUYERS)
            ]

        for spec in EVENTS:
            if spec not in missing:
                print(f"skipped   {spec['title']} (already exists)")
                continue
            created = client.post("/events", json=event_payload(spec, now), headers=organizer)
            created.raise_for_status()
            event_id = created.json()["id"]
            client.post(f"/events/{event_id}/publish", headers=organizer).raise_for_status()
            booked = 0
            if spec["sale_opened_days_ago"] > 0 and spec["booked_share"]:
                booked = book_seats(client, event_id, buyers, spec["booked_share"], rng)
            print(f"created   {spec['title']} (event {event_id}, {booked} seats booked)")


if __name__ == "__main__":
    main()
