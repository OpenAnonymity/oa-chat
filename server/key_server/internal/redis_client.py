"""
Redis Client for Key Server - manages key allocation state.
"""

import redis.asyncio as redis
from typing import Optional, List, Set, Dict
from loguru import logger
import time


class RedisClient:
    """
    Manages Redis operations for key allocation and session tracking.
    """
    
    def __init__(self, redis_instance: redis.Redis):
        self.redis = redis_instance
        logger.info("RedisClient initialized")
    
    async def get_key_weight(self, session_id: str, key_id: str) -> float:
        try:
            result = await self.redis.get(f"session_key_weight:{session_id}:{key_id}")
            return float(result.decode()) if result else 100.0  # Default high weight
        except Exception as e:
            logger.error(f"Error getting key weight for {session_id}:{key_id}: {str(e)}")
            return 100.0  # Default high weight on error
    
    async def set_key_weight(self, session_id: str, key_id: str, weight: float, ttl: int = 3600) -> None:
        try:
            await self.redis.setex(f"session_key_weight:{session_id}:{key_id}", ttl, str(weight))
        except Exception as e:
            logger.error(f"Error setting key weight: {str(e)}")
            raise
    
    async def disable_key_for_session(self, session_id: str, key_id: str, ttl: int = 3600) -> None:
        try:
            await self.set_key_weight(session_id, key_id, 0.0, ttl)
        except Exception as e:
            logger.error(f"Error disabling key for session: {str(e)}")
            raise
    
    async def disable_key_globally(self, key_id: str, ttl: int = 3600) -> None:
        """Disable a key for all sessions (useful when key runs out of credits)."""
        try:
            # Get all active sessions
            sessions = await self.get_active_sessions()
            
            # Set weight to 0 for this key across all sessions
            for session_id in sessions:
                await self.set_key_weight(session_id, key_id, 0.0, ttl)
            
            logger.info(f"Disabled key {key_id} globally for {len(sessions)} sessions")
        except Exception as e:
            logger.error(f"Error disabling key globally: {str(e)}")
            raise
    
    async def reset_key_weights_for_session(self, session_id: str, ttl: int = 3600) -> None:
        """Reset all key weights for a session to default high values."""
        try:
            # Get all weight keys for this session
            weight_keys = await self.redis.keys(f"session_key_weight:{session_id}:*")
            
            for weight_key in weight_keys:
                key_str = weight_key.decode() if isinstance(weight_key, bytes) else weight_key
                # Extract key_id from "session_key_weight:{session_id}:{key_id}"
                parts = key_str.split(":")
                if len(parts) >= 3:
                    key_id = parts[2]  # key_id is at index 2
                    await self.set_key_weight(session_id, key_id, 100.0, ttl)
            
            logger.info(f"Reset key weights for session {session_id}")
        except Exception as e:
            logger.error(f"Error resetting key weights for session: {str(e)}")
            raise

    # Token usage tracking methods
    async def track_key_usage(self, key_id: str, tokens_used: int) -> None:
        """Track token usage for a specific key."""
        try:
            current_time = int(time.time())
            
            # Update total tokens used in the past hour
            usage_key = f"key_usage_hour:{key_id}"
            await self.redis.incrby(usage_key, tokens_used)
            await self.redis.expire(usage_key, 3600)  # 1 hour TTL
            
            # Update cumulative total tokens used (all-time)
            total_usage_key = f"key_usage_total:{key_id}"
            await self.redis.incrby(total_usage_key, tokens_used)
            await self.redis.expire(total_usage_key, 2592000)  # 30 days TTL for total
            
            # Update last used timestamp
            last_used_key = f"key_last_used:{key_id}"
            await self.redis.set(last_used_key, current_time)
            await self.redis.expire(last_used_key, 86400)  # 24 hour TTL
            
            logger.debug(f"Tracked {tokens_used} tokens for key {key_id} (hour + total)")
        except Exception as e:
            logger.error(f"Error tracking key usage: {str(e)}")
            raise

    async def get_key_usage_stats(self, key_id: str) -> Dict[str, any]:
        """Get usage statistics for a specific key."""
        try:
            # Get tokens used in past hour
            usage_key = f"key_usage_hour:{key_id}"
            tokens_hour = await self.redis.get(usage_key)
            tokens_hour = int(tokens_hour.decode()) if tokens_hour else 0
            
            # Get cumulative total tokens used
            total_usage_key = f"key_usage_total:{key_id}"
            tokens_total = await self.redis.get(total_usage_key)
            tokens_total = int(tokens_total.decode()) if tokens_total else 0
            
            # Get last used timestamp
            last_used_key = f"key_last_used:{key_id}"
            last_used = await self.redis.get(last_used_key)
            last_used = int(last_used.decode()) if last_used else None
            
            return {
                "tokens_hour": tokens_hour,
                "tokens_total": tokens_total,
                "last_used": last_used
            }
        except Exception as e:
            logger.error(f"Error getting key usage stats: {str(e)}")
            return {"tokens_hour": 0, "tokens_total": 0, "last_used": None}

    async def get_all_active_keys(self, provider: str, model: str) -> List[str]:
        """Get all active keys for a provider:model combination."""
        try:
            pool_key = f"keys:{provider}:{model}"
            logger.debug(f"🔍 RedisClient.get_all_active_keys() - checking pool: {pool_key}")
            
            # Get all members from the set
            keys = await self.redis.smembers(pool_key)
            
            # Convert bytes to strings if needed
            key_list = [key.decode() if isinstance(key, bytes) else key for key in keys]
            
            logger.info(f"📊 Pool {pool_key} contains {len(key_list)} keys")
            if key_list:
                logger.debug(f"🔑 Keys in pool: {key_list}")
            else:
                logger.warning(f"⚠️  Pool {pool_key} is empty!")
                
                # Let's also check if the key exists at all
                exists = await self.redis.exists(pool_key)
                logger.debug(f"🔍 Pool key exists in Redis: {exists}")
                
                # Check what keys are actually in Redis for debugging
                all_keys = await self.redis.keys("keys:*")
                logger.debug(f"🗂️  All pool keys in Redis: {[k.decode() if isinstance(k, bytes) else k for k in all_keys]}")
            
            return key_list
            
        except Exception as e:
            logger.error(f"❌ Error getting active keys for {provider}:{model}: {str(e)}")
            return []
    
    async def get_active_sessions(self) -> Set[str]:
        try:
            keys = await self.redis.keys("session_key_weight:*")
            sessions = set()
            for key in keys:
                key_str = key.decode() if isinstance(key, bytes) else key
                # Extract session_id from "session_key_weight:{session_id}:{key_id}"
                parts = key_str.split(":")
                if len(parts) >= 3:
                    sessions.add(parts[1])  # session_id is at index 1
            return sessions
        except Exception as e:
            logger.error(f"Error getting active sessions: {str(e)}")
            return set()
    
    async def add_key_to_pool(self, provider: str, model: str, key_id: str) -> None:
        try:
            await self.redis.sadd(f"keys:{provider}:{model}", key_id)
        except Exception as e:
            logger.error(f"Error adding key to pool: {str(e)}")
            raise
    
    async def remove_key_from_pool(self, provider: str, model: str, key_id: str) -> None:
        try:
            await self.redis.srem(f"keys:{provider}:{model}", key_id)
        except Exception as e:
            logger.error(f"Error removing key from pool: {str(e)}")
            raise
    
    async def clear_key_pool(self, provider: str, model: str) -> None:
        try:
            await self.redis.delete(f"keys:{provider}:{model}")
        except Exception as e:
            logger.error(f"Error clearing key pool: {str(e)}")
            raise
    
