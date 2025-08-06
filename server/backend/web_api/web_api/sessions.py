"""
Session management API endpoints.
"""

from typing import Annotated, Optional, Dict, List
from fastapi import APIRouter, Depends, HTTPException, status, Request
from loguru import logger

from ...shared.core.dependencies import get_session_manager
from ...shared.models.requests import EndSessionRequest, UpdateSessionModelsRequest, InitializeSessionRequest, SessionRequest
from ...shared.models.responses import SessionInfoResponse, UpdateSessionModelsResponse, ProxyEndpointsResponse, InitializeSessionResponse
from ...shared.services.session.session_manager import SessionManager


router = APIRouter(
    tags=["sessions"]
)


async def _check_session_or_raise(session_id: str, session_manager: SessionManager) -> SessionManager:
    """Check if session exists and handle expired sessions."""
    session_state = await session_manager.get_session(session_id)
    if not session_state:
        # Session not found - most likely expired due to TTL
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={
                "error": "session_expired", 
                "message": "Session has expired. Please create a new session for better privacy.",
                "action": "create_new_session"
            }
        )
    return session_state


@router.post("/initialize-session", response_model=InitializeSessionResponse)
async def initialize_session(
    request: InitializeSessionRequest,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)]
):
    """
    Initialize a new session for a user without any model selection.
    
    This should be called when the user first loads the website.
    
    Args:
        request: InitializeSessionRequest with user_id
        
    Returns:
        InitializeSessionResponse with session_id
    """
    try:
        logger.info(f"Initializing session for user {request.user_id}")
        
        # Create empty session
        session_id = await session_manager.initialize_session(request.user_id)
        
        return InitializeSessionResponse(
            session_id=session_id,
            message="Session initialized successfully"
        )
        
    except Exception as e:
        logger.error(f"initialize session: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, 
            detail="Internal server error"
        )


@router.get("/session/{session_id}/endpoints")
async def get_session_endpoints(
    session_id: str,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)]
):
    """Get session-specific endpoint list."""
    try:
        logger.debug(f"Getting endpoints for session {session_id}")
        
        # Check session exists first
        session_state = await _check_session_or_raise(session_id, session_manager)
        
        # Get session-specific endpoint list
        endpoints = await session_manager.get_session_endpoints(session_id)
        
        if not endpoints:
            # Session exists but no endpoints available
            return ProxyEndpointsResponse(endpoints=[], total_count=0, active_count=0)
        
        total_count = len(endpoints)
        active_count = sum(1 for ep in endpoints if ep.get("status") in ["Available", "Standby", "Active"])
        
        return ProxyEndpointsResponse(
            endpoints=endpoints,
            total_count=total_count,
            active_count=active_count
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"get session {session_id} endpoints: {str(e)}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.post("/session/{session_id}/choose-endpoint")
async def choose_session_endpoint(
    session_id: str,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)],
    request: Dict = None
):
    """
    Choose an endpoint for the session (random or specific).
    
    Body can contain:
    - {} or null for random selection
    - {"endpoint_id": "specific_id"} for specific selection
    """
    try:
        # Check session exists first
        session_state = await _check_session_or_raise(session_id, session_manager)
        
        # Parse request body
        endpoint_id = None
        if request and isinstance(request, dict):
            endpoint_id = request.get("endpoint_id")
        
        logger.info(f"Choosing endpoint for session {session_id}: {'random' if not endpoint_id else endpoint_id}")
        
        # Choose endpoint
        provider, model, chosen_endpoint_id, api_key_hash = await session_manager.choose_session_endpoint(session_id, endpoint_id)
        
        return {
            "session_id": session_id,
            "selected_provider": provider,
            "selected_model": model,
            "endpoint_id": chosen_endpoint_id,
            "api_key_hash": api_key_hash,
            "message": f"Selected {provider}:{model}" + (" (random)" if not endpoint_id else " (specific)")
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"choose endpoint for session {session_id}: {str(e)}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.put("/session/models", response_model=UpdateSessionModelsResponse)
async def update_session_models(
    request: UpdateSessionModelsRequest,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)]
):
    """
    Update the selected models for an existing session.
    
    This will regenerate the session's endpoint list and handle disconnection 
    if the current endpoint is no longer available.
    """
    try:
        if not request.selected_models:
            raise ValueError("At least one model must be selected")
        
        # Check session exists first
        session_state = await _check_session_or_raise(request.session_id, session_manager)
        
        logger.info(f"Updating models for session {request.session_id} with {len(request.selected_models)} models")
        
        # Models are now already in string format
        needs_disconnection, message = await session_manager.update_session_models(
            request.session_id, request.selected_models
        )
        
        # Get updated endpoint count
        updated_endpoints = await session_manager.get_session_endpoints(request.session_id)
        endpoint_count = len(updated_endpoints) if updated_endpoints else 0
        
        return UpdateSessionModelsResponse(
            session_id=request.session_id,
            needs_disconnection=needs_disconnection,
            message=message,
            available_endpoints=endpoint_count
        )
        
    except HTTPException:
        raise
    except Exception as e:
        if isinstance(e, ValueError):
            logger.warning(f"update models for session {request.session_id}: {str(e)}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        else:
            logger.error(f"update models for session {request.session_id}: {str(e)}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


@router.post("/end-session", status_code=status.HTTP_204_NO_CONTENT)
async def end_session(
    request: EndSessionRequest,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)]
):
    """End a session and clean up resources."""
    try:
        logger.info(f"Ending session: {request.session_id}")
        await session_manager.end_session(request.session_id)
        
    except Exception as e:
        logger.error(f"Error ending session: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )


@router.get("/session/{session_id}", response_model=SessionInfoResponse)
async def get_session_info(
    session_id: str,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)]
):
    """Get information about a session including its bound endpoint."""
    try:
        session_state = await _check_session_or_raise(session_id, session_manager)
        
        # Get endpoint information if available
        endpoint_info = None
        if session_state.endpoint_id:
            endpoint_data = await session_manager.redis.get_endpoint(session_state.endpoint_id)
            if endpoint_data:
                endpoint_info = {
                    "endpoint_id": session_state.endpoint_id,
                    "api_key_hash": session_state.api_key_hash,
                    "status": endpoint_data.get("status"),
                    "usage_load": endpoint_data.get("usage_load")
                }
        
        return SessionInfoResponse(
            session_id=session_id,
            provider=session_state.current_provider,
            model=session_state.current_model,
            endpoint_info=endpoint_info
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting session info: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )


@router.post("/connect")
async def connect_random_endpoint(
    request: SessionRequest,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)]
):
    """
    Randomly connect to an available endpoint for the session.
    This is used when user clicks "connect" without choosing a specific endpoint.
    """
    try:
        # Check session exists first
        session_state = await _check_session_or_raise(request.session_id, session_manager)
        
        logger.info(f"Random endpoint connection for session {request.session_id}")
        
        # Choose random endpoint (None means random selection)
        provider, model, endpoint_id, api_key_hash = await session_manager.choose_session_endpoint(
            session_id=request.session_id,
            endpoint_id=None  # Random selection
        )
        
        return {
            "session_id": request.session_id,
            "connected": True,
            "endpoint_id": endpoint_id,
            "provider": provider,
            "model": model,
            "api_key_hash": api_key_hash,
            "message": f"Connected to random endpoint: {provider}/{model}"
        }
        
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        elif isinstance(e, ValueError):
            logger.warning(f"connect_random_endpoint request: {str(e)}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        else:
            logger.error(f"connect_random_endpoint request: {str(e)}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error") 