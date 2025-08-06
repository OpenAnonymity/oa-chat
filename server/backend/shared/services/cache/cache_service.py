"""
Multi-layer caching service for performance.
"""
import hashlib
import json
import pickle
from typing import Any, Callable, Optional, Union, TypeVar, Generic
import redis.asyncio as redis
from loguru import logger
from datetime import datetime
import asyncio


T = TypeVar('T')


class CacheService(Generic[T]):
    """
    Caching service with multiple strategies.
    Used for caching expensive computations, API responses, and database queries.
    
    Features:
    - Multiple serialization strategies (JSON, pickle)
    - TTL-based expiration
    - Cache warming capabilities
    - Batch operations
    - Cache invalidation patterns
    """
    
    def __init__(self, redis_client: redis.Redis, default_ttl: int = 300):
        """
        Initialize cache service.
        
        Args:
            redis_client: Redis client from connection pool
            default_ttl: Default TTL in seconds (5 minutes)
        """
        self.redis = redis_client
        self.default_ttl = default_ttl
        self._stats = {
            "hits": 0,
            "misses": 0,
            "errors": 0
        }
    
    async def get_or_compute(
        self,
        key: str,
        compute_fn: Callable[[], Union[T, Callable[[], T]]],
        ttl: Optional[int] = None,
        namespace: str = "cache",
        use_pickle: bool = False
    ) -> T:
        """
        Get from cache or compute and store.
        
        Args:
            key: Cache key
            compute_fn: Function to compute value if not cached
            ttl: Time to live in seconds (None uses default)
            namespace: Cache namespace for organization
            use_pickle: Use pickle for complex objects (default: JSON)
            
        Returns:
            Cached or computed value
        """
        full_key = f"{namespace}:{key}"
        
        # Try cache first
        try:
            cached = await self.redis.get(full_key)
            if cached:
                self._stats["hits"] += 1
                logger.debug(f"Cache hit: {full_key}")
                
                if use_pickle:
                    return pickle.loads(cached.encode('latin-1') if isinstance(cached, str) else cached)
                else:
                    return json.loads(cached)
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"Cache read error for {full_key}: {e}")
        
        # Compute if not cached
        self._stats["misses"] += 1
        logger.debug(f"Cache miss: {full_key}")
        
        # Handle both sync and async compute functions
        if asyncio.iscoroutinefunction(compute_fn):
            result = await compute_fn()
        else:
            result = compute_fn()
        
        # Store in cache
        try:
            if use_pickle:
                serialized = pickle.dumps(result)
            else:
                serialized = json.dumps(result)
            
            ttl_seconds = ttl or self.default_ttl
            await self.redis.setex(full_key, ttl_seconds, serialized)
            logger.debug(f"Cached {full_key} for {ttl_seconds}s")
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"Cache write error for {full_key}: {e}")
        
        return result
    
    async def get(
        self,
        key: str,
        namespace: str = "cache",
        use_pickle: bool = False
    ) -> Optional[T]:
        """
        Get value from cache without computing.
        
        Returns:
            Cached value or None if not found
        """
        full_key = f"{namespace}:{key}"
        
        try:
            cached = await self.redis.get(full_key)
            if cached:
                self._stats["hits"] += 1
                if use_pickle:
                    return pickle.loads(cached.encode('latin-1') if isinstance(cached, str) else cached)
                else:
                    return json.loads(cached)
            else:
                self._stats["misses"] += 1
                return None
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"Cache get error for {full_key}: {e}")
            return None
    
    async def set(
        self,
        key: str,
        value: T,
        ttl: Optional[int] = None,
        namespace: str = "cache",
        use_pickle: bool = False
    ) -> bool:
        """
        Set value in cache.
        
        Returns:
            True if successful, False otherwise
        """
        full_key = f"{namespace}:{key}"
        
        try:
            if use_pickle:
                serialized = pickle.dumps(value)
            else:
                serialized = json.dumps(value)
            
            ttl_seconds = ttl or self.default_ttl
            await self.redis.setex(full_key, ttl_seconds, serialized)
            logger.debug(f"Set cache {full_key} for {ttl_seconds}s")
            return True
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"Cache set error for {full_key}: {e}")
            return False
    
    async def delete(self, key: str, namespace: str = "cache") -> bool:
        """Delete a single cache entry."""
        full_key = f"{namespace}:{key}"
        try:
            result = await self.redis.delete(full_key)
            logger.debug(f"Deleted cache key: {full_key}")
            return bool(result)
        except Exception as e:
            logger.warning(f"Cache delete error for {full_key}: {e}")
            return False
    
    async def invalidate(self, pattern: str, namespace: Optional[str] = None):
        """
        Invalidate cache entries matching pattern.
        
        Args:
            pattern: Redis pattern (e.g., "user:*" or "*:session:*")
            namespace: Optional namespace to prepend
        """
        if namespace:
            pattern = f"{namespace}:{pattern}"
            
        cursor = 0
        deleted_count = 0
        
        while True:
            cursor, keys = await self.redis.scan(
                cursor, match=pattern, count=100
            )
            if keys:
                deleted_count += await self.redis.delete(*keys)
            if cursor == 0:
                break
        
        logger.info(f"Invalidated {deleted_count} cache entries matching {pattern}")
    
    def make_cache_key(self, prefix: str, **kwargs) -> str:
        """
        Generate consistent cache keys from parameters.
        Sorts kwargs for consistent hashing.
        
        Example:
            key = cache.make_cache_key("user", id=123, role="admin")
            # Returns: "user:a3f8b2..."
        """
        # Sort kwargs for consistent hashing
        key_data = json.dumps(kwargs, sort_keys=True)
        hash_val = hashlib.sha256(key_data.encode()).hexdigest()[:16]
        return f"{prefix}:{hash_val}"
    
    async def get_many(
        self,
        keys: list[str],
        namespace: str = "cache",
        use_pickle: bool = False
    ) -> dict[str, Optional[T]]:
        """
        Get multiple values from cache in one operation.
        More efficient than multiple get() calls.
        """
        full_keys = [f"{namespace}:{key}" for key in keys]
        
        try:
            values = await self.redis.mget(full_keys)
            results = {}
            
            for key, value in zip(keys, values):
                if value:
                    self._stats["hits"] += 1
                    try:
                        if use_pickle:
                            results[key] = pickle.loads(value.encode('latin-1') if isinstance(value, str) else value)
                        else:
                            results[key] = json.loads(value)
                    except Exception as e:
                        logger.warning(f"Failed to deserialize {key}: {e}")
                        results[key] = None
                else:
                    self._stats["misses"] += 1
                    results[key] = None
                    
            return results
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"Cache get_many error: {e}")
            return {key: None for key in keys}
    
    async def set_many(
        self,
        items: dict[str, T],
        ttl: Optional[int] = None,
        namespace: str = "cache",
        use_pickle: bool = False
    ) -> bool:
        """
        Set multiple values in cache using a pipeline for efficiency.
        """
        ttl_seconds = ttl or self.default_ttl
        
        try:
            async with self.redis.pipeline() as pipe:
                for key, value in items.items():
                    full_key = f"{namespace}:{key}"
                    
                    if use_pickle:
                        serialized = pickle.dumps(value)
                    else:
                        serialized = json.dumps(value)
                    
                    pipe.setex(full_key, ttl_seconds, serialized)
                
                await pipe.execute()
                logger.debug(f"Set {len(items)} cache entries")
                return True
        except Exception as e:
            self._stats["errors"] += 1
            logger.warning(f"Cache set_many error: {e}")
            return False
    
    def get_stats(self) -> dict[str, int]:
        """Get cache statistics."""
        total = self._stats["hits"] + self._stats["misses"]
        hit_rate = self._stats["hits"] / total if total > 0 else 0
        
        return {
            "hits": self._stats["hits"],
            "misses": self._stats["misses"],
            "errors": self._stats["errors"],
            "total_requests": total,
            "hit_rate": round(hit_rate, 4)
        }
    
    async def warm_cache(
        self,
        items: dict[str, Callable[[], Any]],
        ttl: Optional[int] = None,
        namespace: str = "cache",
        use_pickle: bool = False
    ):
        """
        Warm cache with precomputed values.
        Useful for startup or scheduled cache warming.
        
        Args:
            items: Dict of key -> compute function
        """
        logger.info(f"Warming cache with {len(items)} items")
        
        for key, compute_fn in items.items():
            try:
                # Compute value
                if asyncio.iscoroutinefunction(compute_fn):
                    value = await compute_fn()
                else:
                    value = compute_fn()
                
                # Store in cache
                await self.set(key, value, ttl, namespace, use_pickle)
            except Exception as e:
                logger.error(f"Failed to warm cache for {key}: {e}")
        
        logger.info("Cache warming completed") 