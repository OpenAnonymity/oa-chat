"""
Health check and statistics API endpoints.
"""

import time
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from loguru import logger

from ..core.dependencies import get_session_manager, get_key_client, get_settings
from ..core.config import Settings
from ..models.responses import HealthResponse, StatsResponse
from ..services.session.session_manager import SessionManager
from ..clients import KeyClient


router = APIRouter(
    tags=["health"]
)

# Track server start time
_start_time = time.time()


@router.get("/health", response_model=HealthResponse)
async def health_check(
    key_client: Annotated[KeyClient, Depends(get_key_client)],
    settings: Annotated[Settings, Depends(get_settings)]
):
    """Health check endpoint."""
    try:
        # Check key server connection
        key_server_healthy = await key_client.health_check()
        
        uptime = time.time() - _start_time
        
        return HealthResponse(
            status="healthy" if key_server_healthy else "degraded",
            version=settings.version,
            uptime=uptime
        )
        
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return HealthResponse(
            status="unhealthy",
            version=settings.version,
            uptime=time.time() - _start_time
        )


@router.get("/stats", response_model=StatsResponse)
async def get_stats(
    session_manager: Annotated[SessionManager, Depends(get_session_manager)],
    key_client: Annotated[KeyClient, Depends(get_key_client)]
):
    """Get server statistics."""
    try:
        # Get session stats
        active_sessions = await session_manager.get_active_sessions_count()
        
        # Get key server stats
        key_stats = await key_client.get_stats()
        
        providers_stats = {}
        if key_stats.get("success"):
            # Convert pool stats to provider stats
            for pool_key, stats in key_stats.get("pool_stats", {}).items():
                if ":" in pool_key:
                    provider, model = pool_key.split(":", 1)
                    if provider not in providers_stats:
                        providers_stats[provider] = {}
                    providers_stats[provider][model] = stats
        
        return StatsResponse(
            total_sessions=active_sessions,
            active_sessions=active_sessions,
            total_requests=key_stats.get("runtime_stats", {}).get("total_requests", 0),
            providers_stats=providers_stats
        )
        
    except Exception as e:
        logger.error(f"Error getting stats: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to get stats") 