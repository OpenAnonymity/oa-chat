"""
Direct API Router - Routes for programmatic access.
"""

from fastapi import APIRouter
from . import direct_api

router = APIRouter(prefix="/v1")

# Include direct API routes
router.include_router(direct_api.router, tags=["direct-api-v1"]) 