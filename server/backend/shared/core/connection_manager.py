"""
Connection management.
"""
import redis.asyncio as redis
from typing import Optional, Dict, Any
import httpx
from loguru import logger

from .config import Settings


class ConnectionManager:
    """
    Centralized connection management without global state.
    This is initialized once in app lifespan and passed via app.state.
    
    Key features:
    - Redis connection pooling with health checks
    - HTTP client with connection pooling and HTTP/2 support
    - Proper cleanup on shutdown
    - No global state - everything is instance-based
    """
    
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._pools: Dict[str, Any] = {}
        self._initialized = False
        
    async def initialize(self) -> None:
        """Initialize all connection pools at startup."""
        if self._initialized:
            logger.warning("ConnectionManager already initialized, skipping")
            return
            
        logger.info("Initializing connection pools...")
        
        # Redis connection pool for Web Server (DB 0)
        self._pools['redis_web'] = redis.ConnectionPool.from_url(
            self.settings.redis_url,
            max_connections=1000,  # High concurrency support
            decode_responses=True,
            socket_keepalive=True,
            # socket_keepalive_options removed - causes issues on macOS
            retry_on_timeout=True,
            health_check_interval=30,
        )
        
        # Test Redis connection
        try:
            test_redis = redis.Redis(connection_pool=self._pools['redis_web'])
            await test_redis.ping()
            logger.info("Redis connection pool initialized and tested successfully")
        except Exception as e:
            logger.error(f"Failed to connect to Redis: {e}")
            raise
        
        # HTTP client pool for external APIs
        self._pools['http'] = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0),
            limits=httpx.Limits(
                max_connections=100,
                max_keepalive_connections=50
            ),
            http2=True,  # Better performance with HTTP/2
            follow_redirects=True,
        )
        
        self._initialized = True
        logger.info("Connection pools initialized successfully")
        
    async def get_redis(self) -> redis.Redis:
        """
        Get Redis connection from pool.
        Returns a Redis instance that uses the shared connection pool.
        """
        if not self._initialized:
            raise RuntimeError("ConnectionManager not initialized. Call initialize() first.")
            
        # Return a Redis instance using the shared pool
        # Each instance is lightweight - it just references the pool
        return redis.Redis(connection_pool=self._pools['redis_web'])
        
    async def get_http_client(self) -> httpx.AsyncClient:
        """Get shared HTTP client."""
        if not self._initialized:
            raise RuntimeError("ConnectionManager not initialized. Call initialize() first.")
            
        return self._pools['http']
        
    async def close(self) -> None:
        """Cleanup all connections gracefully."""
        logger.info("Closing connection pools...")
        
        # Close Redis pool
        if 'redis_web' in self._pools:
            try:
                await self._pools['redis_web'].disconnect()
                logger.info("Redis connection pool closed")
            except Exception as e:
                logger.error(f"Error closing Redis pool: {e}")
        
        # Close HTTP client
        if 'http' in self._pools:
            try:
                await self._pools['http'].aclose()
                logger.info("HTTP client closed")
            except Exception as e:
                logger.error(f"Error closing HTTP client: {e}")
                
        self._initialized = False
        logger.info("All connection pools closed")
        
    def is_initialized(self) -> bool:
        """Check if connection manager is initialized."""
        return self._initialized
        
    async def health_check(self) -> Dict[str, bool]:
        """
        Perform health checks on all connections.
        Returns a dict with the health status of each connection type.
        """
        health_status = {}
        
        # Check Redis
        try:
            redis_conn = await self.get_redis()
            await redis_conn.ping()
            health_status['redis'] = True
        except Exception as e:
            logger.error(f"Redis health check failed: {e}")
            health_status['redis'] = False
            
        # HTTP client is always healthy if initialized
        health_status['http'] = 'http' in self._pools
        
        return health_status 