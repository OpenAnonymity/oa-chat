"""
Key Server Initializer - sets up Vault and Redis connections.
"""

import os
import hvac
import redis.asyncio as redis
from typing import Optional
from loguru import logger


class Initializer:
    def __init__(self, vault_addr: str = None, vault_token: str = None, redis_url: str = None):
        """
        Initialize with Vault and Redis configuration.
        
        Args:
            vault_addr: Vault server address (defaults to env var VAULT_ADDR)
            vault_token: Vault authentication token (defaults to env var VAULT_TOKEN)  
            redis_url: Redis connection URL (defaults to env var REDIS_URL)
        """
        self.vault_addr = vault_addr or os.getenv("VAULT_ADDR", "http://localhost:8200")
        self.vault_token = vault_token or os.getenv("VAULT_TOKEN")
        self.redis_url = redis_url or os.getenv("KEY_SERVER_REDIS_URL", "redis://localhost:6379/1")
        
        self._vault_client: Optional[hvac.Client] = None
        self._redis: Optional[redis.Redis] = None
        
        logger.info(f"Initializer configured with Vault: {self.vault_addr}, Redis: {self.redis_url}")
    
    async def initialize(self) -> None:
        """Initialize connections to Vault and Redis."""
        try:
            # Initialize Vault client
            self._vault_client = hvac.Client(
                url=self.vault_addr,
                token=self.vault_token
            )
            
            # Verify Vault connection
            if not self._vault_client.is_authenticated():
                raise Exception("Vault authentication failed")
            
            logger.info("Vault connection established successfully")
            
            # Initialize Redis connection
            self._redis = redis.from_url(self.redis_url)
            
            # Test Redis connection
            await self._redis.ping()
            logger.info("Redis connection established successfully")
            
        except Exception as e:
            logger.error(f"Initialization failed: {str(e)}")
            raise
    
    @property
    def vault_client(self) -> hvac.Client:
        """Get the Vault client instance."""
        if self._vault_client is None:
            raise RuntimeError("Vault client not initialized. Call initialize() first.")
        return self._vault_client
    
    @property
    def redis(self) -> redis.Redis:
        """Get the Redis client instance."""
        if self._redis is None:
            raise RuntimeError("Redis client not initialized. Call initialize() first.")
        return self._redis
    
    async def close(self) -> None:
        """Close connections."""
        if self._redis:
            await self._redis.close()
            logger.info("Redis connection closed")
        
        # Vault client doesn't need explicit closing
        logger.info("Initializer cleanup complete") 