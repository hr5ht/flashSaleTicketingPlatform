from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

SeatAcquisitionStrategy = Literal["unique_insert", "for_update", "skip_locked", "upsert"]


def asyncpg_url(raw: str) -> str:
    url = make_url(raw)
    query = dict(url.query)
    sslmode = query.pop("sslmode", None)
    query.pop("channel_binding", None)
    if sslmode is not None:
        query["ssl"] = sslmode
    return url.set(drivername="postgresql+asyncpg", query=query).render_as_string(
        hide_password=False
    )


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    test_database_url: str | None = None
    jwt_secret_key: str
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7
    hold_duration_seconds: int = 300
    max_seats_per_user_per_event: int = 6
    seat_acquisition_strategy: SeatAcquisitionStrategy = "upsert"
    vercel_env: str | None = None

    @field_validator("database_url", "test_database_url")
    @classmethod
    def use_asyncpg(cls, value: str | None) -> str | None:
        return None if value is None else asyncpg_url(value)


@lru_cache
def get_settings() -> Settings:
    return Settings()
