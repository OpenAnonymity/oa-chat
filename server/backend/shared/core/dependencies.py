"""
Dependency injection for FastAPI without global state.
"""
from typing import Annotated, AsyncGenerator
from fastapi import Depends, Request
from functools import lru_cache
import redis.asyncio as redis
from loguru import logger

from .config import Settings
from .connection_manager import ConnectionManager
from ..clients import KeyClient, RedisClient
from ..services.session.session_manager import SessionManager
from ..services.session.turn_completion import TurnCompletionService
from ..services.endpoint.factory import EndpointFactory
from ..services.query.routing import QueryRouter
from ..services.privacy.privacy import PrivacyProcessor
from ..services.PI_removal.pii_removal import PIIRemovalService
from ..services.obfuscation.obfuscation import ObfuscationService
from ..services.decoy.decoy import DecoyService
from ..services.cache import CacheService
from .initializer import Initializer
import httpx


# Configuration (cached at module level for efficiency)
@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Connection Dependencies (from app.state - shared resources)
async def get_connection_manager(request: Request) -> ConnectionManager:
    """
    Get connection manager from app state.
    This is the ONLY place where we access app.state.
    The ConnectionManager holds all shared expensive resources.
    """
    if not hasattr(request.app.state, 'connection_manager'):
        raise RuntimeError("ConnectionManager not found in app.state. Is the app properly initialized?")
    return request.app.state.connection_manager


async def get_redis(
    conn_manager: Annotated[ConnectionManager, Depends(get_connection_manager)]
) -> redis.Redis:
    """
    Get Redis connection from pool.
    Each request gets its own Redis instance, but they all share the same connection pool.
    """
    return await conn_manager.get_redis()


async def get_http_client(
    conn_manager: Annotated[ConnectionManager, Depends(get_connection_manager)]
) -> httpx.AsyncClient:
    """Get HTTP client from shared pool."""
    return await conn_manager.get_http_client()


# Service Dependencies (created per request for thread safety)
async def get_key_client(
    settings: Annotated[Settings, Depends(get_settings)]
) -> KeyClient:
    """
    Create KeyClient per request.
    KeyClient is lightweight and doesn't maintain connections, so it's safe to create per request.
    """
    return KeyClient(settings.key_server_socket)


async def get_redis_client(
    redis_conn: Annotated[redis.Redis, Depends(get_redis)]
) -> RedisClient:
    """
    Create RedisClient wrapper per request.
    The wrapper is lightweight - it just holds a reference to the Redis connection from the pool.
    """
    return RedisClient(redis_conn)


async def get_endpoint_factory() -> EndpointFactory:
    """
    Create endpoint factory per request.
    The factory is lightweight and stateless, so creating new instances is efficient.
    """
    return EndpointFactory()


async def get_session_manager(
    redis_client: Annotated[RedisClient, Depends(get_redis_client)],
    key_client: Annotated[KeyClient, Depends(get_key_client)],
    endpoint_factory: Annotated[EndpointFactory, Depends(get_endpoint_factory)]
) -> SessionManager:
    """
    Create SessionManager per request.
    This ensures thread safety - each request gets its own instance.
    """
    return SessionManager(redis_client, key_client, endpoint_factory)


async def get_query_router(
    key_client: Annotated[KeyClient, Depends(get_key_client)],
    redis_client: Annotated[RedisClient, Depends(get_redis_client)],
    endpoint_factory: Annotated[EndpointFactory, Depends(get_endpoint_factory)]
) -> QueryRouter:
    """
    Create QueryRouter per request.
    THE central component for routing queries to LLMs.
    """
    return QueryRouter(key_client, redis_client, endpoint_factory)


async def get_turn_completion_service(
    session_manager: Annotated[SessionManager, Depends(get_session_manager)],
    query_router: Annotated[QueryRouter, Depends(get_query_router)]
) -> TurnCompletionService:
    """Create TurnCompletionService per request."""
    return TurnCompletionService(session_manager, query_router)


async def get_initializer(
    request: Request
) -> Initializer:
    """
    Get Initializer from app state.
    The Initializer holds provider configuration and is created once at startup.
    """
    if hasattr(request.app.state, 'initializer'):
        return request.app.state.initializer
    
    # Fallback: create a new initializer if not in app.state
    # This supports the old initialization pattern during migration
    initializer = Initializer()
    await initializer.initialize()
    return initializer


# Privacy Service Dependencies (lightweight, created per request)
async def get_pii_removal_service() -> PIIRemovalService:
    """Create PII removal service per request."""
    return PIIRemovalService()


async def get_obfuscation_service() -> ObfuscationService:
    """Create obfuscation service per request."""
    return ObfuscationService()


async def get_decoy_service() -> DecoyService:
    """Create decoy service per request."""
    return DecoyService()


async def get_privacy_processor(
    pii_service: Annotated[PIIRemovalService, Depends(get_pii_removal_service)],
    obfuscation_service: Annotated[ObfuscationService, Depends(get_obfuscation_service)],
    decoy_service: Annotated[DecoyService, Depends(get_decoy_service)]
) -> PrivacyProcessor:
    """Create privacy processor with dependencies per request."""
    return PrivacyProcessor(
        pii_service=pii_service,
        obfuscation_service=obfuscation_service,
        decoy_service=decoy_service
    )


# Cache service dependency
async def get_cache_service(
    redis_conn: Annotated[redis.Redis, Depends(get_redis)]
) -> CacheService:
    """Create cache service per request with Redis from pool."""
    return CacheService(redis_conn)


# Type aliases for cleaner code in route handlers
RedisConnection = Annotated[redis.Redis, Depends(get_redis)]
HttpClient = Annotated[httpx.AsyncClient, Depends(get_http_client)]
SessionManagerDep = Annotated[SessionManager, Depends(get_session_manager)]
QueryRouterDep = Annotated[QueryRouter, Depends(get_query_router)]
PrivacyProcessorDep = Annotated[PrivacyProcessor, Depends(get_privacy_processor)]
CacheServiceDep = Annotated[CacheService, Depends(get_cache_service)]


# Cleanup function for legacy code migration support
async def cleanup_resources() -> None:
    """
    Legacy cleanup function - kept for backward compatibility.
    Cleanup is now handled in the lifespan context manager.
    """
    logger.warning("cleanup_resources() called - this is deprecated. Cleanup should be handled in lifespan context.")
    pass 