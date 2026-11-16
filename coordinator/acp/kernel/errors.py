from __future__ import annotations


class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


def not_found(what: str = "资源") -> ApiError:
    return ApiError("not_found", f"{what}不存在", 404)


def forbidden(message: str = "没有权限执行这个操作") -> ApiError:
    return ApiError("forbidden", message, 403)


def invalid_state(message: str) -> ApiError:
    return ApiError("invalid_state", message, 409)


def validation(message: str) -> ApiError:
    return ApiError("validation_error", message, 422)
