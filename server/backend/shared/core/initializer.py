"""
Web Server Initializer - sets up provider configurations and connections.
"""

import os
import yaml
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import redis.asyncio as redis
from loguru import logger
import aiofiles

from ..clients.key_client import KeyClient
from ..clients.redis import RedisClient


class Initializer:
    """
    Initializes Web Server with provider configurations and external connections.
    """
    
    def __init__(self, provider_file_path: str = None, key_server_socket_path: str = None, redis_url: str = None, redis_instance: Optional[redis.Redis] = None):
        """
        Initialize with configuration paths and socket paths.
        
        Args:
            provider_file_path: Path to providers.yaml file (defaults to env var PROVIDER_FILE)
            key_server_socket_path: Key Server socket path (defaults to env var KEY_SERVER_SOCKET)
            redis_url: Redis connection URL (defaults to env var WEB_SERVER_REDIS_URL)
            redis_instance: Optional Redis instance to use (from connection pool)
        """
        self.provider_file_path = provider_file_path or os.getenv("PROVIDER_FILE", "providers.yaml")
        self.key_server_socket_path = key_server_socket_path or os.getenv("KEY_SERVER_SOCKET", "/tmp/keyserver.sock")
        self.redis_url = redis_url or os.getenv("WEB_SERVER_REDIS_URL", "redis://localhost:6379/0")
        
        # Public attributes
        self.provider_models: Dict[str, List[str]] = {}  # provider -> list of model tags
        self.redis_client: Optional[RedisClient] = None
        
        # Private attributes
        self._provider_meta_raw: Optional[dict] = None
        self._redis_instance: Optional[redis.Redis] = redis_instance  # Use provided instance
        self._key_client: Optional[KeyClient] = None
        
        logger.info(f"Initializer configured with provider file: {self.provider_file_path}")
        logger.info(f"Key Server Socket: {self.key_server_socket_path}")
        logger.info(f"Redis URL: {self.redis_url}")
    
    async def initialize(self) -> None:
        try:
            # Load provider configuration
            await self._load_provider_config()
            
            # Initialize Redis connection (only if not already provided)
            if not self.redis_client:
                await self._initialize_redis()
            
            # Initialize Key Server client (only if not already provided)
            if not self._key_client:
                self._initialize_key_client()
            
            logger.info("Web Server Initializer startup complete")
            
        except Exception as e:
            logger.error(f"Web Server initialization failed: {str(e)}")
            raise
    
    async def _load_provider_config(self) -> None:
        """Load provider configuration from YAML file."""
        try:
            config_file = os.getenv("PROVIDER_CONFIG_FILE", "providers.yaml")
            
            if not os.path.exists(config_file):
                logger.warning(f"Provider config file not found: {config_file}")
                # Use default configuration with model tags only
                self.provider_models = {
                    "OpenAI": ["gpt-4o", "gpt-4o-mini"],
                    "Anthropic": ["claude-3-haiku-20240307"],
                    "DeepSeek": ["deepseek-reasoner", "deepseek-chat", "deepseek-coder"],
                    "XAI": ["grok-3-beta"],
                    "Together": ["meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"]
                }
                logger.info("Using default provider configuration with model tags")
                return
            
            async with aiofiles.open(config_file, 'r') as file:
                content = await file.read()
                self._provider_meta_raw = yaml.safe_load(content)
            
            # Transform to provider -> model tags mapping (simplified)
            self.provider_models = {}
            
            for provider, models in self._provider_meta_raw.items():
                model_tags = []
                for model in models:
                    if isinstance(model, dict):
                        # Extract only the api_tag, ignore display name
                        api_tag = model["tag"]
                        model_tags.append(api_tag)
                    else:
                        # Fallback for simple string models
                        model_tags.append(str(model))
                
                self.provider_models[provider] = model_tags
            
            logger.info(f"Loaded provider configuration: {self.provider_models}")
            
        except Exception as e:
            logger.error(f"Error loading provider config: {str(e)}")
            raise
    
    async def _initialize_redis(self) -> None:
        """Initialize Redis connection."""
        try:
            self._redis_instance = redis.from_url(self.redis_url)
            
            # Test connection
            await self._redis_instance.ping()
            
            # Create RedisClient wrapper
            self.redis_client = RedisClient(self._redis_instance)
            
            logger.info("Redis connection established successfully")
            
        except Exception as e:
            logger.error(f"Redis initialization failed: {str(e)}")
            raise
    
    def _initialize_key_client(self) -> None:
        """Initialize Key Server client."""
        try:
            # Key Server only supports Unix Domain Sockets
            self._key_client = KeyClient(self.key_server_socket_path)
            logger.info(f"Key Server client initialized for socket: {self.key_server_socket_path}")
            
        except Exception as e:
            logger.error(f"Key client initialization failed: {str(e)}")
            raise
    
    
    def get_provider_models(self) -> Dict[str, List[str]]:
        return self.provider_models.copy()
    
    def get_redis_client(self) -> RedisClient:
        if not self.redis_client:
            raise RuntimeError("Redis client not initialized. Call initialize() first.")
        return self.redis_client
    
    def get_key_server_socket_path(self) -> str:
        return self.key_server_socket_path
    
    def get_key_client(self) -> KeyClient:
        if not self._key_client:
            raise RuntimeError("Key client not initialized. Call initialize() first.")
        return self._key_client
    

    
    async def close(self) -> None:
        """Close connections."""
        if self._redis_instance:
            await self._redis_instance.close()
            logger.info("Redis connection closed")
        
        if self._key_client:
            await self._key_client.close()
            logger.info("Key client closed")
        
        logger.info("Web Server Initializer cleanup complete") 