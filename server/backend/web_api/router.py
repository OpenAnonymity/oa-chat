"""
Web API Router - Routes for React webapp interface.
"""

from fastapi import APIRouter
from . import sessions, chat

router = APIRouter()

# Include web API sub-routers
router.include_router(sessions.router, tags=["web-sessions"])
router.include_router(chat.router, tags=["web-chat"]) 