import pytest

from src.config import asyncpg_url


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (
            (
                "postgresql://app:s3cr%40t@ep-x-pooler.aws.neon.tech/neondb"
                "?sslmode=require&channel_binding=require"
            ),
            "postgresql+asyncpg://app:s3cr%40t@ep-x-pooler.aws.neon.tech/neondb?ssl=require",
        ),
        ("postgres://u:p@h/db", "postgresql+asyncpg://u:p@h/db"),
        (
            "postgresql+asyncpg://u@localhost:5432/db",
            "postgresql+asyncpg://u@localhost:5432/db",
        ),
        (
            "postgresql://u@h/db?sslmode=verify-full",
            "postgresql+asyncpg://u@h/db?ssl=verify-full",
        ),
    ],
)
def test_libpq_urls_are_rewritten_for_asyncpg(raw: str, expected: str) -> None:
    assert asyncpg_url(raw) == expected
