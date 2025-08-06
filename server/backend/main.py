"""
Web Server FastAPI Application

Main web server for handling user requests, session management, and LLM routing.
Uses modular router architecture.
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from loguru import logger

from .shared.core.config import Settings
from .shared.core.connection_manager import ConnectionManager
from .shared.core.initializer import Initializer
from .shared.middleware import add_monitoring_middleware
from .web_api.web_api import sessions as web_sessions, chat as web_chat
from .shared.api import providers, health
from .direct_api.v1 import direct_api


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.
    Initialize resources at startup, cleanup at shutdown.
    
    Key principles:
    - Expensive resources (connection pools) created once at startup
    - Stored in app.state for access by dependencies
    - Proper cleanup on shutdown
    - No global state anywhere
    """
    # Startup
    logger.info("Starting OpenAnonymity Web Server...")
    
    # Initialize settings
    settings = Settings()
    app.state.settings = settings
    
    # Initialize connection manager with all shared resources
    conn_manager = ConnectionManager(settings)
    await conn_manager.initialize()
    app.state.connection_manager = conn_manager
    
    # Initialize provider configuration
    redis_client = await conn_manager.get_redis()
    initializer = Initializer(redis_instance=redis_client)
    await initializer.initialize()
    app.state.initializer = initializer
    
    logger.info("Web Server started successfully")
    logger.info(f"Redis pool: max_connections=1000, keepalive=True")
    logger.info(f"HTTP client: max_connections=100, http2=True")
    
    yield
    
    # Shutdown
    logger.info("Shutting down Web Server...")
    
    # Close initializer first
    if hasattr(app.state, 'initializer'):
        await app.state.initializer.close()
        logger.info("Initializer closed")
    
    # Close connection manager (handles all connection pools)
    if hasattr(app.state, 'connection_manager'):
        await app.state.connection_manager.close()
        logger.info("Connection manager closed")
        
    logger.info("Web Server shut down gracefully")


# Create FastAPI app
app = FastAPI(
    title="OpenAnonymity",
    description="Privacy-focused LLM routing service",
    version="2.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# Add monitoring middleware
add_monitoring_middleware(app)

# Add CORS middleware with production configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),  # Configure in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],  # For request tracking
)

# Include Web API routes (for React webapp)
app.include_router(web_sessions.router, prefix="/api/web", tags=["web-sessions"])
app.include_router(web_chat.router, prefix="/api/web", tags=["web-chat"])

# Include shared utilities (used by both webapp and direct API clients)
app.include_router(providers.router, prefix="/api", tags=["providers"])
app.include_router(health.router, prefix="/api", tags=["health"])

# Include new v1 Direct API routers
app.include_router(direct_api.router, prefix="/api", tags=["direct-api-v1"])


@app.get("/")
async def root():
    """Root endpoint with enhanced service information."""
    return {
        "service": "OpenAnonymity",
        "version": "2.0.0",
        "status": "operational",
        "architecture": "scalable",
        "features": {
            "connection_pooling": True,
            "horizontal_scaling": True,
            "async_processing": True,
            "thread_safe": True,
            "zero_global_state": True,
        },
        "performance": {
            "redis_max_connections": 1000,
            "http_max_connections": 100,
            "http2_enabled": True,
            "pattern": "connection_pooling"
        },
        "endpoints": {
            "web_api": {
                "base": "/api/web/*",
                "description": "Web application endpoints (React webapp)",
                "endpoints": [
                    "/api/web/initialize-session",
                    "/api/web/session/models", 
                    "/api/web/session/{id}/endpoints",
                    "/api/web/session/{id}/choose-endpoint",
                    "/api/web/session/{id}",
                    "/api/web/end-session",
                    "/api/web/connect",
                    "/api/web/generate"
                ],
            },
            "shared_utilities": {
                "base": "/api/*",
                "description": "Shared endpoints (webapp + direct API)",
                "endpoints": ["/api/providers", "/api/health"]
            },
            "direct_api_v1": {
                "base": "/api/v1/*",
                "description": "Direct API with privacy features (Bearer auth required)",
                "endpoints": [
                    "/api/v1/create-session",
                    "/api/v1/stateless-query",
                    "/api/v1/stateful-query"
                ]
            },
            "docs": "/docs",
            "redoc": "/redoc",
            "openapi": "/openapi.json"
        }
    }


def main():
    """
    Main entry point for running the web server.
    For production, use gunicorn with uvicorn workers for better performance.
    """
    port = int(os.getenv("WEB_SERVER_PORT", "8000"))
    host = os.getenv("WEB_SERVER_HOST", "0.0.0.0")
    workers = int(os.getenv("WORKERS", "1"))  # Single worker for development
    reload = os.getenv("WEB_SERVER_RELOAD", "false").lower() == "true"
    
    logger.info(f"Starting Web Server on {host}:{port}")
    logger.info(f"Environment: {os.getenv('ENVIRONMENT', 'production')}")
    logger.info(f"Workers: {workers} (use WORKERS env var to change)")
    logger.info(f"Reload: {reload}")
    
    # For production, run with:
    # gunicorn backend.main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
    
    # For development:
    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        reload=reload,
        log_level="info",
        access_log=True,
        loop="asyncio",  # Explicitly use asyncio loop
    )


if __name__ == "__main__":
    main() 