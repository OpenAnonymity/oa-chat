"""
Configuration management for the web server.
"""

import os
from typing import Optional, Any
from functools import lru_cache

try:
    from pydantic_settings import BaseSettings
    from pydantic import Field
except ImportError:
    # Fallback for older pydantic versions
    from pydantic import BaseSettings, Field


class Settings(BaseSettings):
    """
    Application settings with environment variable support.
    Uses pydantic-settings for automatic env var loading and validation.
    """
    
    # Application
    app_name: str = "OpenAnonymity"
    environment: str = "production"
    debug: bool = False
    version: str = "2.0.0"
    
    # Server settings
    host: str = "0.0.0.0"
    port: int = 8000
    workers: int = 1  # For development; use 4+ in production
    
    # Redis settings
    redis_url: str = Field(default="redis://localhost:6379/0", validation_alias="WEB_SERVER_REDIS_URL")
    redis_max_connections: int = 1000
    redis_socket_keepalive: bool = True
    redis_health_check_interval: int = 30
    redis_decode_responses: bool = True
    redis_retry_on_timeout: bool = True
    
    # Key Server settings
    key_server_socket: str = Field(default="/tmp/keyserver.sock", validation_alias="KEY_SERVER_SOCKET")
    
    # Provider configuration
    provider_config_file: str = "providers.yaml"
    
    # API settings
    api_prefix: str = "/api"
    max_request_size: int = 10 * 1024 * 1024  # 10MB
    request_timeout: int = 30
    
    # Session settings
    session_ttl: int = 3600  # 1 hour
    max_sessions_per_user: int = 10
    
    # Logging settings
    log_level: str = "INFO"
    log_file: Optional[str] = None
    log_format: str = "json"  # json or text
    
    # CORS settings
    cors_origins: str = "*"  # Comma-separated list
    cors_allow_credentials: bool = True
    cors_max_age: int = 600
    
    # Health check settings
    health_check_timeout: int = 30
    
    # JWT Authentication settings
    jwt_secret: str = Field(default="your-secret-key-change-in-production", validation_alias="WEB_SERVER_JWT_SECRET")
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440  # 24 hours
    
    # Privacy settings
    enable_pii_removal: bool = True
    enable_query_obfuscation: bool = True
    enable_decoy_generation: bool = True
    
    # Performance settings
    connection_pool_size: int = 100
    http_max_connections: int = 100
    http_keepalive_connections: int = 50
    enable_http2: bool = True
    
    # Rate limiting
    rate_limit_enabled: bool = True
    rate_limit_per_minute: int = 100
    rate_limit_burst: int = 200
    
    # Monitoring
    enable_metrics: bool = True
    enable_tracing: bool = True
    metrics_port: int = 9090
    
    class Config:
        """Pydantic config."""
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        
        # Allow env vars to override with prefixes
        # e.g., WEB_SERVER_HOST overrides host
        env_prefix = "WEB_SERVER_"
    
    @classmethod
    def from_env(cls) -> 'Settings':
        """Create settings from environment variables."""
        return cls()
    
    def get_redis_url(self) -> str:
        """Get Redis URL with proper formatting."""
        return self.redis_url
    
    def get_cors_origins(self) -> list[str]:
        """Get CORS origins as a list."""
        if self.cors_origins == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",")]
    
    def is_production(self) -> bool:
        """Check if running in production."""
        return self.environment.lower() == "production"
    
    def is_development(self) -> bool:
        """Check if running in development."""
        return self.environment.lower() in ("development", "dev")
    
    def to_dict(self) -> dict[str, Any]:
        """Convert settings to dictionary (excluding sensitive data)."""
        data = self.dict()
        # Remove sensitive fields
        sensitive_fields = {"jwt_secret", "redis_url"}
        for field in sensitive_fields:
            if field in data:
                data[field] = "***hidden***"
        return data


# Note: The global settings instance is removed in favor of dependency injection
# Use get_settings() from dependencies.py instead 