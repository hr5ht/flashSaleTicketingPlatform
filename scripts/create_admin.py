import argparse
import asyncio
import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy.dialects.postgresql import insert

from src.auth.models import Role, User
from src.auth.security import hash_password
from src.auth.service import normalize_email
from src.database import engine, session_factory


async def main() -> None:
    parser = argparse.ArgumentParser(
        description="Create an admin account, or make an existing account admin with a new password"
    )
    parser.add_argument("email")
    email = normalize_email(parser.parse_args().email)
    password = getpass.getpass(f"Password for {email}: ")
    if len(password) < 8:
        parser.error("the password needs at least 8 characters")
    statement = insert(User).values(email=email, password_hash=hash_password(password), role=Role.admin)
    async with session_factory() as session:
        await session.execute(
            statement.on_conflict_do_update(
                index_elements=[User.email],
                set_={"password_hash": statement.excluded.password_hash, "role": Role.admin},
            )
        )
        await session.commit()
    await engine.dispose()
    print(f"{email} is an admin")


if __name__ == "__main__":
    asyncio.run(main())
