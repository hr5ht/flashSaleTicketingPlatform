from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from src.auth.router import router as auth_router
from src.bookings.router import router as bookings_router
from src.database import SessionDep, engine
from src.events.router import router as events_router
from src.exceptions import AppError, app_error_handler
from src.seatmap.router import router as seatmap_router


class HealthStatus(BaseModel):
    status: str
    database: str


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await engine.dispose()


app = FastAPI(title="Flash Sale Ticketing", lifespan=lifespan)
app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
app.include_router(auth_router)
app.include_router(events_router)
app.include_router(bookings_router)
app.include_router(seatmap_router)
app.frontend("/", directory=Path(__file__).resolve().parent.parent / "frontend")


@app.get("/health", response_model=HealthStatus)
async def health(session: SessionDep) -> HealthStatus:
    try:
        await session.execute(text("SELECT 1"))
    except (SQLAlchemyError, OSError):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="database unavailable",
        )
    return HealthStatus(status="ok", database="ok")
