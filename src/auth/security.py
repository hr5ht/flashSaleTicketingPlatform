from datetime import UTC, datetime, timedelta
from uuid import UUID

import jwt
from pwdlib import PasswordHash
from pwdlib.exceptions import PwdlibError
from pwdlib.hashers.argon2 import Argon2Hasher

from src.auth.exceptions import InvalidToken
from src.config import get_settings

ALGORITHM = "HS256"

password_hash = PasswordHash((Argon2Hasher(),))


def hash_password(password: str) -> str:
    return password_hash.hash(password)


UNKNOWN_USER_HASH = hash_password("no account has this password")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return password_hash.verify(password, hashed)
    except PwdlibError:
        return False


def create_token(user_id: UUID, token_type: str, lifetime: timedelta) -> str:
    settings = get_settings()
    issued_at = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "type": token_type,
        "iat": issued_at,
        "exp": issued_at + lifetime,
    }
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=ALGORITHM)


def create_access_token(user_id: UUID) -> str:
    lifetime = timedelta(minutes=get_settings().access_token_expire_minutes)
    return create_token(user_id, "access", lifetime)


def create_refresh_token(user_id: UUID) -> str:
    lifetime = timedelta(days=get_settings().refresh_token_expire_days)
    return create_token(user_id, "refresh", lifetime)


def decode_token(token: str, expected_type: str) -> UUID:
    settings = get_settings()
    try:
        payload = jwt.decode(
            token, settings.jwt_secret_key, algorithms=[ALGORITHM]
        )
    except jwt.PyJWTError:
        raise InvalidToken
    if payload.get("type") != expected_type:
        raise InvalidToken
    try:
        return UUID(payload["sub"])
    except (KeyError, TypeError, ValueError):
        raise InvalidToken
