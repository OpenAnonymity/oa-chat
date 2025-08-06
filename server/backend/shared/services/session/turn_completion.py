"""
Turn Completion Service - Handles single-turn mode completion workflow.
"""

from typing import Dict, List, Optional, Any
from loguru import logger

from .session_manager import SessionManager
from ..query.routing import QueryRouter


class TurnCompletionService:
    """
    Handles the complete workflow for single-turn mode completion:
    - Endpoint invalidation and cleanup
    - Session state reset
    - New endpoint generation  
    - Auto-selection for seamless continuation
    """
    
    def __init__(self, session_manager: SessionManager, query_router: QueryRouter):
        self.session_manager = session_manager
        self.query_router = query_router
        logger.info("TurnCompletionService initialized")
    
    async def complete_single_turn(self, session_id: str) -> Dict[str, Any]:
        """
        Complete single-turn workflow with automatic endpoint regeneration and selection.
        
        Args:
            session_id: Session identifier
            
        Returns:
            Dictionary containing:
            - success: bool
            - new_endpoints: List of regenerated endpoints
            - auto_selected: Dict with auto-selected endpoint info (if available)
            - message: Status message
            - error: Error message (if failed)
        """
        try:
            logger.info(f"Starting single-turn completion for session {session_id}")
            
            # Get session state before cleanup
            session_state = await self.session_manager.get_session(session_id)
            if not session_state:
                return {
                    "success": False,
                    "error": f"Session {session_id} not found",
                    "new_endpoints": [],
                    "auto_selected": None,
                    "message": "Session not found"
                }
            
            current_models = session_state.selected_models or []
            
            # Step 1: Invalidate all current endpoints
            await self._invalidate_session_endpoints(session_id)
            
            # Step 2: Clear session state
            await self._clear_session_state(session_state)
            
            # Step 3: Regenerate endpoints if models are selected
            if not current_models:
                return {
                    "success": True,
                    "new_endpoints": [],
                    "auto_selected": None,
                    "message": "Single-turn completed. No models selected for regeneration."
                }
            
            # Regenerate endpoints
            new_endpoints = await self._regenerate_endpoints(session_id, current_models)
            
            # Step 4: Auto-select random endpoint for seamless continuation
            auto_selected = await self._auto_select_endpoint(session_id, new_endpoints)
            
            success_message = f"Single-turn completed. {len(new_endpoints)} new endpoints available."
            if auto_selected:
                success_message += f" Auto-connected to {auto_selected['provider']}:{auto_selected['model']}."
            
            logger.info(f"Single-turn completion successful for session {session_id}: {len(new_endpoints)} endpoints, auto-selected: {bool(auto_selected)}")
            
            return {
                "success": True,
                "new_endpoints": new_endpoints,
                "auto_selected": auto_selected,
                "message": success_message,
                "error": None
            }
            
        except Exception as e:
            logger.error(f"Single-turn completion failed for session {session_id}: {str(e)}")
            return {
                "success": False,
                "new_endpoints": [],
                "auto_selected": None,
                "message": f"Single-turn completion failed: {str(e)}",
                "error": str(e)
            }
    
    async def _invalidate_session_endpoints(self, session_id: str) -> None:
        """Invalidate all endpoints associated with the session."""
        try:
            session_endpoints = await self.session_manager.get_session_endpoints(session_id)
            for endpoint in session_endpoints:
                # Delete endpoint data from Redis
                await self.query_router.redis.delete(f"endpoint:{endpoint['id']}")
            
            # Clear session endpoints list
            await self.query_router.redis.delete(f"session_endpoints:{session_id}")
            
            logger.debug(f"Invalidated {len(session_endpoints)} endpoints for session {session_id}")
        except Exception as e:
            logger.error(f"Failed to invalidate endpoints for session {session_id}: {str(e)}")
            raise
    
    async def _clear_session_state(self, session_state) -> None:
        """Clear session's current endpoint binding."""
        try:
            session_state.endpoint_id = None
            session_state.current_provider = ""
            session_state.current_model = ""
            session_state.api_key_hash = None
            await self.session_manager._store_session_state(session_state)
            
            logger.debug(f"Cleared session state for {session_state.session_id}")
        except Exception as e:
            logger.error(f"Failed to clear session state: {str(e)}")
            raise
    
    async def _regenerate_endpoints(self, session_id: str, models: List[str]) -> List[Dict]:
        """Regenerate endpoints for the given models."""
        try:
            logger.info(f"Regenerating endpoints for {len(models)} models in session {session_id}")
            
            # Use session manager to regenerate endpoints
            needs_disconnection, regen_message = await self.session_manager.update_session_models(
                session_id, models
            )
            
            # Get new endpoint list
            new_endpoints = await self.session_manager.get_session_endpoints(session_id)
            
            logger.info(f"Regenerated {len(new_endpoints)} endpoints for session {session_id}")
            return new_endpoints
            
        except Exception as e:
            logger.error(f"Failed to regenerate endpoints for session {session_id}: {str(e)}")
            raise
    
    async def _auto_select_endpoint(self, session_id: str, endpoints: List[Dict]) -> Optional[Dict]:
        """Automatically select a random endpoint for seamless continuation."""
        if not endpoints:
            return None
        
        try:
            provider, model, chosen_endpoint_id, api_key_hash = await self.session_manager.choose_session_endpoint(
                session_id, None  # Random selection
            )
            
            auto_selected = {
                "provider": provider,
                "model": model,
                "endpoint_id": chosen_endpoint_id,
                "api_key_hash": api_key_hash
            }
            
            logger.info(f"Auto-selected endpoint {chosen_endpoint_id} for session {session_id}")
            return auto_selected
            
        except Exception as e:
            logger.warning(f"Failed to auto-select endpoint for session {session_id}: {str(e)}")
            return None 