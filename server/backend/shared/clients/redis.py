"""
Redis Client for Web Server - manages caching and data persistence.
Simplified after SessionManager introduction.
"""

import redis.asyncio as redis
from typing import Optional, Dict, List
from loguru import logger
import json
from datetime import datetime


class RedisClient:
    """
    Manages Redis operations for the web server.
    Simplified to handle only endpoint storage and basic operations.
    """
    
    def __init__(self, redis_instance: redis.Redis):
        self.redis = redis_instance
        logger.info("RedisClient initialized")
    
    async def get(self, key: str) -> Optional[bytes]:
        """Get value by key."""
        try:
            return await self.redis.get(key)
        except Exception as e:
            logger.error(f"Error getting key {key}: {str(e)}")
            return None
    
    async def set(self, key: str, value: str, ttl: int = 3600) -> None:
        """Set key-value with TTL."""
        try:
            await self.redis.setex(key, ttl, value)
        except Exception as e:
            logger.error(f"Error setting key {key}: {str(e)}")
            raise
    
    async def delete(self, key: str) -> None:
        """Delete key."""
        try:
            await self.redis.delete(key)
        except Exception as e:
            logger.error(f"Error deleting key {key}: {str(e)}")
            raise

    async def get_endpoint(self, endpoint_id: str) -> Optional[Dict]:
        """."""
        try:
            key = f"endpoint:{endpoint_id}"
            result = await self.redis.get(key)
            if result:
                # Redis returns string when decode_responses=True, no need to decode
                return json.loads(result)
            return None
        except Exception as e:
            logger.error(f"Error getting endpoint {endpoint_id}: {str(e)}")
            return None

    async def set_endpoint(self, endpoint_id: str, endpoint_data: Dict, ttl: int = 3600) -> None:
        """Store endpoint data in Redis."""
        try:
            key = f"endpoint:{endpoint_id}"
            await self.redis.setex(key, ttl, json.dumps(endpoint_data))
            logger.debug(f"Set endpoint data for {endpoint_id}")
        except Exception as e:
            logger.error(f"Error setting endpoint data: {str(e)}")
            raise

    async def set_session_endpoints(self, session_id: str, endpoints: List[Dict], ttl: int = 3600) -> None:
        """Store session endpoints list in Redis."""
        try:
            key = f"session_endpoints:{session_id}"
            await self.redis.setex(key, ttl, json.dumps(endpoints))
            logger.debug(f"Set session endpoints for {session_id}")
        except Exception as e:
            logger.error(f"Error setting session endpoints: {str(e)}")
            raise

    async def get_session_endpoints(self, session_id: str) -> Optional[List[Dict]]:
        """Get session endpoints list from Redis."""
        try:
            key = f"session_endpoints:{session_id}"
            result = await self.redis.get(key)
            if result:
                # Redis returns string when decode_responses=True, no need to decode
                return json.loads(result)
            return None
        except Exception as e:
            logger.error(f"Error getting session endpoints {session_id}: {str(e)}")
            return None

    async def delete_session_endpoints(self, session_id: str) -> None:
        """Delete session endpoints from Redis."""
        try:
            key = f"session_endpoints:{session_id}"
            await self.redis.delete(key)
            logger.debug(f"Deleted session endpoints for {session_id}")
        except Exception as e:
            logger.error(f"Error deleting session endpoints: {str(e)}")
            raise
