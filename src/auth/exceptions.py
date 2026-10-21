from fastapi import status

from src.exceptions import AppError


class EmailAlreadyRegistered(AppError):
    status_code = status.HTTP_409_CONFLICT
    detail = "email already registered"


class InvalidCredentials(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    detail = "invalid email or password"


class InvalidToken(AppError):
    status_code = status.HTTP_401_UNAUTHORIZED
    detail = "invalid or expired token"


class RegistrationClosed(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    detail = "registration is closed"


class InsufficientRole(AppError):
    status_code = status.HTTP_403_FORBIDDEN
    detail = "insufficient role"
