from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.auth.exceptions import EmailAlreadyRegistered, InvalidCredentials, InvalidToken
from src.auth.models import Role, User
from src.auth.schemas import AccessToken, TokenPair
from src.auth.security import (
    UNKNOWN_USER_HASH,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)


def normalize_email(email: str) -> str:
    return email.strip().lower()


async def register_user(
    session: AsyncSession, email: str, password: str, role: Role
) -> User:
    user = User(
        email=normalize_email(email),
        password_hash=hash_password(password),
        role=role,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise EmailAlreadyRegistered
    await session.refresh(user)
    return user


async def authenticate_user(
    session: AsyncSession, email: str, password: str
) -> User:
    result = await session.execute(
        select(User).where(User.email == normalize_email(email))
    )
    user = result.scalar_one_or_none()
    if user is None:
        verify_password(password, UNKNOWN_USER_HASH)
        raise InvalidCredentials
    if not verify_password(password, user.password_hash):
        raise InvalidCredentials
    return user


def issue_token_pair(user: User) -> TokenPair:
    return TokenPair(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id),
    )


async def user_from_access_token(session: AsyncSession, token: str) -> User:
    user = await session.get(User, decode_token(token, "access"))
    if user is None:
        raise InvalidToken
    return user


async def refresh_access_token(session: AsyncSession, refresh_token: str) -> AccessToken:
    user_id = decode_token(refresh_token, "refresh")
    user = await session.get(User, user_id)
    if user is None:
        raise InvalidToken
    return AccessToken(access_token=create_access_token(user.id))
