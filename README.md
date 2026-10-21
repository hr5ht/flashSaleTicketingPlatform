# Flash-Sale Ticketing

Backend for selling event tickets when a lot of people try to buy the same seats at the same time. The main rule is that a seat can never be sold twice.

FastAPI, PostgreSQL, SQLAlchemy (async), Alembic.

Live: https://flashsaleticketing.vercel.app. API docs are at `/docs` when running locally.

## Try it

Sign in as Adam or Ben from the sign-in page (password `demo-password`), and open the other one in a private window to watch seat changes arrive live. The Requests button shows every call the page makes.

## How it works

- Each held or booked seat is a row in `seat_claims`, and `seat_id` is the primary key, so Postgres rejects a second claim on the same seat.
- A hold is all-or-nothing: all seats are inserted together inside a savepoint, so if one is taken none are held.
- Holds expire after 2 minutes. Expiry is checked against the database clock whenever seats are read or claimed, so there is no background job.
- Holding and confirming accept an `Idempotency-Key` header, so a retried request returns the first result.
- There are four ways of claiming seats (`unique_insert`, `for_update`, `skip_locked`, `upsert`), picked with `SEAT_ACQUISITION_STRATEGY`. `scripts/flash_sale.py` runs many buyers against each one and checks for oversells.

## Running locally

Needs Python 3.11+ and PostgreSQL.

```bash
createdb flash_sale
createdb flash_sale_test
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env    # then set JWT_SECRET_KEY
alembic upgrade head
uvicorn src.main:app --reload
```

To add the demo events and the two demo buyers:

```bash
SEED_PASSWORD=<any password> python scripts/seed_demo.py
```

Sign-up is closed in production. Admins can create and publish events from the Manage page, book like any buyer, and run the rules lab, which checks every backend rule against the API. To make an admin account (it asks for the password):

```bash
python scripts/create_admin.py <email>
```

## Tests

```bash
pytest
```

The tests use `TEST_DATABASE_URL`.

## Deployment

Runs on Vercel with a Neon Postgres database. Migrations are run by hand with Neon's direct (non-pooled) connection string before deploying.

## Project structure

```
src/
  auth/        users, roles, password hashing, tokens
  events/      events, sections, seats, listing, seat map
  bookings/    holds, bookings, seat claiming strategies, sales
  seatmap/     live seat map over WebSocket
  config.py    settings from environment variables
  database.py  engine and sessions
  exceptions.py
  middleware.py
  pagination.py
  main.py      app setup, routers, health check
alembic/       migrations
frontend/      HTML, CSS and JS client
scripts/       benchmark and demo data
tests/
.github/       CI workflow
```
