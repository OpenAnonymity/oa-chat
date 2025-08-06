"""
Provider information API endpoints.
"""

from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException, status
from loguru import logger

from ..core.dependencies import get_initializer
from ..models.responses import ProvidersResponse
from ..core.initializer import Initializer


router = APIRouter(
    tags=["providers"]
)


@router.get("/providers", response_model=ProvidersResponse)
async def get_providers(
    initializer: Annotated[Initializer, Depends(get_initializer)]
):
    """Get available providers and their models."""
    try:
        # Get providers directly from initializer configuration
        providers = initializer.get_provider_models()
        
        return ProvidersResponse(providers=providers)
        
    except Exception as e:
        logger.error(f"Error getting providers: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )
