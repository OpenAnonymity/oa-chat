"""
Custom exceptions for the web server.
"""

from typing import Optional, Dict, Any
from fastapi import HTTPException, status


class APIError(HTTPException):
    """Base API error class."""
    
    def __init__(
        self,
        status_code: int,
        detail: str,
        headers: Optional[Dict[str, Any]] = None
    ):
        super().__init__(status_code=status_code, detail=detail, headers=headers)


class SessionNotFoundError(APIError):
    """Raised when a session is not found."""
    
    def __init__(self, session_id: str):
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Session {session_id} not found"
        )


class EndpointNotFoundError(APIError):
    """Raised when an endpoint is not found."""
    
    def __init__(self, endpoint_id: str):
        super().__init__(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Endpoint {endpoint_id} not found"
        )


class InvalidModelError(APIError):
    """Raised when an invalid model is requested."""
    
    def __init__(self, provider: str, model: str):
        super().__init__(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid model: {provider}:{model}"
        )


class ServiceUnavailableError(APIError):
    """Raised when a required service is unavailable."""
    
    def __init__(self, service_name: str):
        super().__init__(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{service_name} service is unavailable"
        )


class RateLimitError(APIError):
    """Raised when rate limit is exceeded."""
    
    def __init__(self, message: str = "Rate limit exceeded"):
        super().__init__(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=message
        )


class AuthenticationError(APIError):
    """Raised when authentication fails."""
    
    def __init__(self, message: str = "Authentication failed"):
        super().__init__(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=message,
            headers={"WWW-Authenticate": "Bearer"}
        )


class EndpointExpiredError(APIError):
    """Raised when an endpoint has expired (session expired)."""
    
    def __init__(self, endpoint_id: str):
        super().__init__(
            status_code=status.HTTP_410_GONE,
            detail={
                "error": "session_expired",
                "message": "Session has expired. Please create a new session for better privacy.",
                "action": "create_new_session"
            }
        ) 