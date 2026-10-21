from fastapi import Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

RETRYABLE_SQLSTATES = {"40001", "40P01"}


class AppError(Exception):
    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    detail: str = "internal error"


class RetryableTransaction(AppError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    detail = "the transaction conflicted and can be retried"


def translate(error: DBAPIError) -> Exception:
    if getattr(error.orig, "sqlstate", None) in RETRYABLE_SQLSTATES:
        return RetryableTransaction()
    return error


async def app_error_handler(request: Request, error: AppError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


async def unexpected_error_handler(request: Request, error: Exception) -> JSONResponse:
    return JSONResponse(status_code=AppError.status_code, content={"detail": AppError.detail})
