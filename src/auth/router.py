from fastapi import APIRouter, status

from src.auth.dependencies import CurrentUser
from src.auth.exceptions import RegistrationClosed
from src.auth.schemas import (
    AccessToken,
    LoginRequest,
    RefreshRequest,
    TokenPair,
    UserRead,
    UserRegister,
)
from src.auth.service import (
    authenticate_user,
    issue_token_pair,
    refresh_access_token,
    register_user,
)
from src.config import get_settings
from src.database import SessionDep

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
async def register(payload: UserRegister, session: SessionDep) -> UserRead:
    if get_settings().vercel_env == "production":
        raise RegistrationClosed
    user = await register_user(session, payload.email, payload.password, payload.role)
    return UserRead.model_validate(user)


@router.post("/login", response_model=TokenPair)
async def login(payload: LoginRequest, session: SessionDep) -> TokenPair:
    user = await authenticate_user(session, payload.email, payload.password)
    return issue_token_pair(user)


@router.post("/refresh", response_model=AccessToken)
async def refresh(payload: RefreshRequest, session: SessionDep) -> AccessToken:
    return await refresh_access_token(session, payload.refresh_token)


@router.get("/me", response_model=UserRead)
async def me(user: CurrentUser) -> UserRead:
    return UserRead.model_validate(user)
