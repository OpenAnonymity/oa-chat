"""
Session Manager - Centralized session state management.
"""

import uuid
import json
from datetime import datetime
from typing import Optional, List, Dict, Tuple
from loguru import logger

from ...models.internal import SessionState
from ...clients.redis import RedisClient
from ...clients.key_client import KeyClient
from ...utils.utils import parse_model_list, format_model_list
from ...utils.hashing import generate_endpoint_id
from ...utils.async_time import get_utc_now, get_hour_bucket, get_iso_timestamp


class SessionManager:
    """Centralized session management."""
    
    def __init__(self, redis_client: RedisClient, key_client: KeyClient, endpoint_factory):
        """
        Initialize SessionManager with dependencies.
        
        Args:
            redis_client: RedisClient instance for data storage
            key_client: KeyClient instance for key management
            endpoint_factory: EndpointFactory instance for creating endpoints
        """
        self.redis = redis_client
        self.key_client = key_client
        self.endpoint_factory = endpoint_factory
        logger.info("SessionManager initialized")
    
    async def _track_user_session(self, user_id: int, session_id: str) -> None:
        """Track session ID for a user in Redis set."""
        try:
            key = f"user_sessions:{user_id}"
            await self.redis.redis.sadd(key, session_id)
            # Set TTL to 7 days to keep session history longer than session TTL
            await self.redis.redis.expire(key, 604800)  # 7 days
            logger.debug(f"Tracked session {session_id} for user {user_id}")
        except Exception as e:
            logger.error(f"Error tracking user session: {str(e)}")
            # Don't raise - this is tracking, not critical
    
    async def _was_user_session(self, user_id: int, session_id: str) -> bool:
        """Check if session ID was ever created for this user."""
        try:
            key = f"user_sessions:{user_id}"
            result = await self.redis.redis.sismember(key, session_id)
            return bool(result)
        except Exception as e:
            logger.error(f"Error checking user session history: {str(e)}")
            return False
    
    async def _remove_user_session(self, user_id: int, session_id: str) -> None:
        """Remove session ID from user's session history."""
        try:
            key = f"user_sessions:{user_id}"
            await self.redis.redis.srem(key, session_id)
            logger.debug(f"Removed session {session_id} from user {user_id} history")
        except Exception as e:
            logger.error(f"Error removing user session: {str(e)}")
            # Don't raise - this is cleanup, not critical
    
    async def _log_suspicious_activity(self, user_id: int, session_id: str, ip_address: str) -> None:
        """Log potentially malicious activity with IP address."""
        try:
            timestamp = await get_iso_timestamp()
            log_data = {
                "timestamp": timestamp,
                "user_id": user_id,
                "session_id": session_id,
                "ip_address": ip_address,
                "activity": "invalid_session_access"
            }
            
            # Store in Redis with 30 day TTL for security monitoring
            key = f"suspicious_activity:{timestamp}:{user_id}"
            await self.redis.redis.setex(key, 2592000, json.dumps(log_data))  # 30 days
            
            # Also log to application logger for immediate monitoring
            logger.warning(f"Suspicious activity detected - User {user_id} from IP {ip_address} attempted to access invalid session {session_id}")
            
        except Exception as e:
            logger.error(f"Error logging suspicious activity: {str(e)}")
            # Don't raise - this is logging, not critical
    
    async def initialize_session(self, user_id: int) -> str:
        """
        Initialize a new empty session for a user.
        
        This creates a session without any model selection, ready for 
        the user to add models via update_session_models.
        
        Args:
            user_id: User identifier
            
        Returns:
            session_id: Unique session identifier
        """
        try:
            session_id = str(uuid.uuid4())
            
            # Create empty session state
            session_state = SessionState(
                session_id=session_id,
                user_id=user_id,
                selected_models=[],  # Now stores string list
                current_provider="",
                current_model="",
                created_at=await get_iso_timestamp()
            )
            
            await self._store_session_state(session_state)
            
            # Track this session for the user
            await self._track_user_session(user_id, session_id)
            
            logger.info(f"Initialized empty session {session_id} for user {user_id}")
            return session_id
            
        except Exception as e:
            logger.error(f"Error initializing session: {str(e)}")
            raise
    
    async def update_session_models(self, session_id: str, new_selected_models: List[str]) -> Tuple[bool, Optional[str]]:
        """
        Update session's selected models and regenerate endpoint list.
        Use the key server's intelligent selection for keys.
        
        Args:
            session_id: Session identifier
            new_selected_models: New list of "provider/model" strings
            
        Returns:
            Tuple of (needs_disconnection, message)
        """
        try:
            # Get current session state
            session_state = await self.get_session(session_id)
            if not session_state:
                raise Exception(f"Session {session_id} not found")
            
            # Update selected models
            session_state.selected_models = new_selected_models
            
            # Check if current endpoint is still valid
            current_provider = session_state.current_provider
            current_model = session_state.current_model
            needs_disconnection = False
            
            if current_provider and current_model:
                # Check if current provider/model is still in new selection
                current_model_string = f"{current_provider}/{current_model}"
                
                if current_model_string not in new_selected_models:
                    # Current endpoint is no longer valid - disconnect
                    needs_disconnection = True
                    session_state.current_provider = ""
                    session_state.current_model = ""
                    session_state.endpoint_id = None
                    session_state.api_key_hash = None
                    logger.info(f"Session {session_id}: Current endpoint removed from selection - disconnecting")
            
            # Use key server to select endpoints for this session
            selected_keys = await self.key_client.select_keys_for_session(
                session_id=session_id,
                user_id=session_state.user_id,
                models=new_selected_models,  # Pass string list directly
                count_per_model=2  # Get 2 keys per model for redundancy
            )
            
            if not selected_keys:
                # No endpoints available
                needs_disconnection = True
                session_state.current_provider = ""
                session_state.current_model = ""
                session_state.endpoint_id = None
                session_state.api_key_hash = None
                logger.warning(f"Session {session_id}: No endpoints available for new model selection")
                selected_keys = []  # Ensure it's an empty list, not None
            
            # Store the selected endpoints with their API keys
            await self._store_session_endpoints_with_keys(session_id, selected_keys)
            
            # Store updated session state
            await self._store_session_state(session_state)
            
            # Generate status message
            if needs_disconnection and not selected_keys:
                message = "No endpoints available for selected models. Session disconnected."
            elif needs_disconnection:
                message = f"Current endpoint removed from selection. Session disconnected. {len(selected_keys)} new endpoints available."
            else:
                message = f"Session models updated. {len(selected_keys)} endpoints available."
            
            logger.info(f"Session {session_id} models updated: {len(new_selected_models)} models, {len(selected_keys)} endpoints")
            return needs_disconnection, message
            
        except Exception as e:
            logger.error(f"Error updating session models: {str(e)}")
            raise
    
    async def _store_session_endpoints_with_keys(self, session_id: str, selected_keys: List[Dict]) -> None:
        """
        Store session endpoints with their bound API keys.
        
        This stores both the endpoint list and the individual endpoint data
        including the API keys for permanent binding.
        """
        try:
            endpoints = []
            
            for key_info in selected_keys:
                # Generate endpoint ID in web server
                endpoint_id = await generate_endpoint_id(
                    provider=key_info["provider"],
                    model=key_info["model"],
                    key_id=key_info["key_id"],
                    session_id=session_id,
                    length=20
                )
                
                # Store full endpoint data including API key (remove key_id from storage)
                endpoint_data = {
                    "id": endpoint_id,
                    "provider": key_info["provider"],
                    "model": key_info["model"],
                    "api_key": key_info["api_key"],  # Store encrypted in production
                    # key_id removed from storage - not needed after endpoint creation
                    "tokens_hour": key_info["tokens_hour"],
                    "tokens_total": key_info["tokens_total"],
                    "status": key_info["status"],
                    "session_id": session_id,
                    "created_at": await get_iso_timestamp()
                }
                
                # Store individual endpoint
                await self.redis.set_endpoint(endpoint_id, endpoint_data, ttl=3600)
                
                # Add to endpoints list (without API key for list view)
                endpoints.append({
                    "id": endpoint_id,
                    "name": f"endpoint-{endpoint_id[:8]}",
                    "provider": key_info["provider"],
                    "model_tag": key_info["model"],
                    "models_accessible": key_info["model"],
                    "usage_load": self._get_usage_load(key_info["tokens_hour"]),
                    "status": key_info["status"],
                    "token_usage_hour": key_info["tokens_hour"],
                    "token_usage_total": key_info["tokens_total"],
                    "api_key_hash": await self._generate_session_specific_api_key_hash(key_info["key_id"], session_id)
                })
            
            # Store session endpoints list
            await self.redis.set_session_endpoints(session_id, endpoints, ttl=3600)
            
        except Exception as e:
            logger.error(f"Error storing session endpoints: {str(e)}")
            raise
    
    def _get_usage_load(self, tokens_hour: int) -> str:
        """Convert token usage to load category."""
        if tokens_hour == 0:
            return "idle"
        elif tokens_hour < 1000:
            return "light"
        elif tokens_hour < 5000:
            return "moderate"
        else:
            return "heavy"
    
    async def _generate_session_specific_api_key_hash(self, key_id: str, session_id: str) -> str:
        """Generate session-specific hash for API key identification to prevent cross-session comparison."""
        import hashlib
        
        # Include session_id and current timestamp to make hash unique per session
        session_time = await get_hour_bucket()  # Hour-based to allow some consistency within session
        hash_input = f"{key_id}:{session_id}:{session_time}".encode('utf-8')
        return hashlib.sha256(hash_input).hexdigest()[:24]

    async def get_session_endpoints(self, session_id: str) -> List[Dict]:
        """Get session-specific endpoint list."""
        try:
            endpoints = await self.redis.get_session_endpoints(session_id)
            return endpoints if endpoints else []
        except Exception as e:
            logger.error(f"Error getting session endpoints: {str(e)}")
            return []
    
    async def choose_session_endpoint(self, session_id: str, endpoint_id: Optional[str] = None) -> Tuple[str, str, str, str]:
        """
        Choose an endpoint for the session (either random or specific).
        
        Args:
            session_id: Session identifier
            endpoint_id: Optional specific endpoint ID, if None will choose randomly
            
        Returns:
            Tuple of (provider, model, chosen_endpoint_id)
        """
        try:
            # Get session endpoints
            session_endpoints = await self.get_session_endpoints(session_id)
            if not session_endpoints:
                raise Exception(f"No endpoints available for session {session_id}")
            
            # Choose endpoint
            if endpoint_id:
                # Specific endpoint
                endpoint_data = next((ep for ep in session_endpoints if ep["id"] == endpoint_id), None)
                if not endpoint_data:
                    raise ValueError(f"Endpoint {endpoint_id} not available for this session")
                chosen_endpoint_id = endpoint_id
            else:
                # Random endpoint
                from ...utils.async_random import secure_choice
                endpoint_data = await secure_choice(session_endpoints)
                chosen_endpoint_id = endpoint_data["id"]
            
            provider = endpoint_data['provider']
            model_tag = endpoint_data['models_accessible']
            api_key_hash = endpoint_data.get('api_key_hash')
            
            # Update session state with chosen endpoint
            session_state = await self.get_session(session_id)
            if not session_state:
                raise Exception(f"Session {session_id} not found")
            
            session_state.current_provider = provider
            session_state.current_model = model_tag
            session_state.endpoint_id = chosen_endpoint_id
            session_state.api_key_hash = api_key_hash
            
            await self._store_session_state(session_state)
            
            logger.info(f"Session {session_id} chose endpoint {chosen_endpoint_id}: {provider}:{model_tag}")
            return provider, model_tag, chosen_endpoint_id, api_key_hash
            
        except Exception as e:
            logger.error(f"Error choosing session endpoint: {str(e)}")
            raise

    async def get_session(self, session_id: str) -> Optional[SessionState]:
        """Get session state."""
        try:
            session_data = await self.redis.get(f"session_state:{session_id}")
            if session_data:
                # Redis returns string when decode_responses=True, no need to decode
                data = json.loads(session_data)
                return SessionState(**data)
            return None
        except Exception as e:
            logger.error(f"Error getting session {session_id}: {str(e)}")
            return None
    
    async def check_session_status(self, session_id: str, user_id: int) -> Dict[str, any]:
        """
        Check session status and return appropriate response.
        
        Args:
            session_id: Session identifier
            user_id: User identifier
            
        Returns:
            Dictionary with status information:
            - status: "active", "expired", or "invalid"
            - session_state: SessionState if active, None otherwise
            - message: Status message
            - should_log_ip: Whether to log IP for potential malicious activity
        """
        try:
            # Try to get active session
            session_state = await self.get_session(session_id)
            
            if session_state:
                # Session is active
                return {
                    "status": "active",
                    "session_state": session_state,
                    "message": "Session is active",
                    "should_log_ip": False
                }
            
            # Session not found - check if it was ever valid for this user
            was_valid = await self._was_user_session(user_id, session_id)
            
            if was_valid:
                # Session existed but has expired
                return {
                    "status": "expired",
                    "session_state": None,
                    "message": "Session has expired. Please create a new session for better privacy.",
                    "should_log_ip": False
                }
            else:
                # Session ID never existed for this user - potentially malicious
                return {
                    "status": "invalid",
                    "session_state": None,
                    "message": "Invalid session ID",
                    "should_log_ip": True
                }
                
        except Exception as e:
            logger.error(f"Error checking session status: {str(e)}")
            return {
                "status": "error",
                "session_state": None,
                "message": "Error checking session status",
                "should_log_ip": False
            }
    
    async def get_session_endpoint(self, session_id: str) -> Optional[object]:
        """Create endpoint instance for session on-demand."""
        try:
            session_state = await self.get_session(session_id)
            if not session_state:
                logger.warning(f"No session state found for session {session_id}")
                return None
            
            # Check if session has chosen an endpoint
            if not session_state.current_provider or not session_state.current_model:
                logger.warning(f"Session {session_id} has not chosen an endpoint yet")
                return None
            
            # Get the bound endpoint data
            if not session_state.endpoint_id:
                logger.error(f"Session {session_id} has no endpoint_id bound")
                return None
            
            # Retrieve endpoint data with API key
            endpoint_data = await self.redis.get_endpoint(session_state.endpoint_id)
            if not endpoint_data:
                logger.error(f"Endpoint {session_state.endpoint_id} not found for session {session_id}")
                return None
            
            # Create provider instance directly (no caching)
            api_key = endpoint_data.get("api_key")
            if not api_key:
                logger.error(f"No API key found in endpoint {session_state.endpoint_id}")
                return None
            
            # Create endpoint instance directly using factory
            endpoint = self.endpoint_factory.create_endpoint(
                provider=endpoint_data["provider"],
                model_tag=endpoint_data["model"],
                api_key=api_key
            )
            
            if endpoint:
                logger.debug(f"Created endpoint instance for session {session_id}")
                return endpoint
            else:
                logger.error(f"Failed to create endpoint instance for session {session_id}")
                return None
            
        except Exception as e:
            logger.error(f"Error getting session endpoint: {str(e)}")
            return None
    
    async def end_session(self, session_id: str) -> None:
        """Clean up session resources."""
        try:
            # Get session to find user_id before cleanup
            session_state = await self.get_session(session_id)
            user_id = session_state.user_id if session_state else None
            
            # Release key
            await self.key_client.release_key(session_id)
            
            # Delete session state
            await self.redis.delete(f"session_state:{session_id}")
            
            # Delete session metadata
            await self.redis.delete_session_endpoints(session_id)
            
            # Remove from user session tracking
            if user_id:
                await self._remove_user_session(user_id, session_id)
            
            logger.info(f"Cleaned up session: {session_id}")
        except Exception as e:
            logger.error(f"Error cleaning up session {session_id}: {str(e)}")
            raise
    
    async def _store_session_state(self, session_state: SessionState) -> None:
        """Store session state in Redis."""
        try:
            key = f"session_state:{session_state.session_id}"
            data = session_state.model_dump_json()
            await self.redis.redis.setex(key, 3600, data)  # 1 hour TTL
            logger.debug(f"Stored session state for {session_state.session_id}")
        except Exception as e:
            logger.error(f"Error storing session state: {str(e)}")
            raise

    async def get_active_sessions_count(self) -> int:
        """
        Get the count of active sessions.
        
        Returns:
            Number of active sessions
        """
        try:
            # Get all session state keys
            pattern = "session_state:*"
            keys = await self.redis.redis.keys(pattern)
            return len(keys)
        except Exception as e:
            logger.error(f"Error getting active sessions count: {str(e)}")
            return 0
    
    async def close(self):
        """Close session manager and cleanup resources."""
        logger.info("SessionManager closed") 