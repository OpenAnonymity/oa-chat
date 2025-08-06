"""
Direct API v1 endpoints for stateless and stateful queries.
Provides OpenAI-compatible interface with privacy features.
"""

from typing import Annotated, Optional
from fastapi import APIRouter, Depends, HTTPException, Header, status
from fastapi.responses import StreamingResponse
from loguru import logger
import uuid
import time
import jwt
from datetime import datetime, timezone

from ...shared.core.dependencies import get_query_router, get_session_manager, get_privacy_processor, get_settings
from ...shared.models.requests import StatelessQueryRequest, StatefulQueryRequest, CreateSessionRequest
from ...shared.models.responses import (
    StatelessQueryResponse, 
    StatefulQueryResponse,
    CreateSessionResponse,
    QueryMetaData,
    QueryChoice
)
from ...shared.services.query.routing import QueryRouter
from ...shared.services.session.session_manager import SessionManager
from ...shared.services.privacy.privacy import PrivacyProcessor
from ...shared.core.config import Settings
from .processors.direct_api_processor import DirectAPIProcessor


router = APIRouter(
    prefix="/v1",
    tags=["direct-api-v1"]
)


def get_user_id_from_token(
    authorization: Annotated[str, Header()],
    settings: Annotated[Settings, Depends(get_settings)]
) -> int:
    """Extract and validate user ID from JWT token."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization header"
        )
    
    token = authorization.replace("Bearer ", "")
    
    try:
        # Decode JWT token with configured secret key
        payload = jwt.decode(
            token, 
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm]
        )
        
        # Validate token expiration
        exp = payload.get("exp")
        if exp and datetime.fromtimestamp(exp, tz=timezone.utc) < datetime.now(timezone.utc):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token expired"
            )
        
        # Extract user ID from claims
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token claims: missing user ID"
            )
        
        try:
            # Ensure user_id is an integer
            user_id_int = int(user_id)
            logger.debug(f"Extracted user ID {user_id_int} from valid JWT token")
            return user_id_int
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token claims: user ID must be a number"
            )
        
    except jwt.ExpiredSignatureError:
        logger.warning("JWT token expired")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired"
        )
    except jwt.InvalidTokenError as e:
        logger.error(f"JWT validation failed: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token"
        )
    except Exception as e:
        logger.error(f"Unexpected error during token validation: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token validation failed"
        )


@router.post("/stateless-query", response_model=StatelessQueryResponse)
async def stateless_query(
    request: StatelessQueryRequest,
    authorization: Annotated[str, Header()],
    query_router: Annotated[QueryRouter, Depends(get_query_router)],
    privacy_processor: Annotated[PrivacyProcessor, Depends(get_privacy_processor)],
    settings: Annotated[Settings, Depends(get_settings)]
):
    """
    Stateless query endpoint - each request is independent.
    Supports privacy features: PII removal, obfuscation, and decoy generation.
    """
    try:
        # Extract user ID from token
        user_id = get_user_id_from_token(authorization, settings)
        logger.info(f"Stateless query from user {user_id}, streaming={request.stream}")
        
        # Create processor
        processor = DirectAPIProcessor(
            query_router=query_router,
            privacy_processor=privacy_processor
        )
        
        # Handle streaming vs non-streaming
        if request.stream:
            # Return streaming response (OpenAI-compatible)
            return StreamingResponse(
                processor.process_stateless_query_streaming(
                    user_id=user_id,
                    messages=request.messages,
                    models=request.models,
                    pii_removal=request.pii_removal,
                    obfuscate=request.obfuscate,
                    decoy=request.decoy
                ),
                media_type="text/plain",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
            )
        else:
            # Process non-streaming query
            result = await processor.process_stateless_query(
                user_id=user_id,
                messages=request.messages,
                models=request.models,
                pii_removal=request.pii_removal,
                obfuscate=request.obfuscate,
                decoy=request.decoy,
                streaming=False
            )
            
            return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stateless query error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )


@router.post("/stateful-query", response_model=StatefulQueryResponse)
async def stateful_query(
    request: StatefulQueryRequest,
    authorization: Annotated[str, Header()],
    query_router: Annotated[QueryRouter, Depends(get_query_router)],
    session_manager: Annotated[SessionManager, Depends(get_session_manager)],
    privacy_processor: Annotated[PrivacyProcessor, Depends(get_privacy_processor)],
    settings: Annotated[Settings, Depends(get_settings)]
):
    """
    Stateful query endpoint - maintains conversation context.
    Supports privacy features and session management.
    """
    try:
        # Extract user ID from token
        user_id = get_user_id_from_token(authorization, settings)
        logger.info(f"Stateful query from user {user_id}, streaming={request.stream}")
        
        # Create or get session
        session_id = request.session_id
        if not session_id:
            # Auto-create session with default model
            logger.info(f"Auto-creating session for user {user_id}")
            
            # Step 1: Initialize session  
            session_id = await session_manager.initialize_session(user_id)
            
            # Step 2: Set default models if none provided in request
            default_models = request.models or ["OpenAI/gpt-4o-mini"]
            needs_disconnection, update_message = await session_manager.update_session_models(
                session_id, default_models
            )
            
            # Step 3: Validate endpoints exist
            endpoints = await session_manager.get_session_endpoints(session_id)
            if not endpoints:
                # Clean up failed session
                await session_manager.end_session(session_id)
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"No endpoints available for default models: {default_models}"
                )
            
            # Step 4: Choose random endpoint for the session
            provider, model, chosen_endpoint_id, api_key_hash = await session_manager.choose_session_endpoint(
                session_id, None  # None = random selection
            )
            
            logger.info(f"Auto-created session {session_id} with {provider}/{model}")
        
        # Create processor (with session_manager for stateful queries)
        processor = DirectAPIProcessor(
            query_router=query_router,
            privacy_processor=privacy_processor,
            session_manager=session_manager
        )
        
        # Handle streaming vs non-streaming
        if request.stream:
            # Return streaming response (OpenAI-compatible)
            return StreamingResponse(
                processor.process_stateful_query_streaming(
                    user_id=user_id,
                    session_id=session_id,
                    messages=request.messages,
                    models=request.models,
                    pii_removal=request.pii_removal,
                    obfuscate=request.obfuscate,
                    decoy=request.decoy
                ),
                media_type="text/plain",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
            )
        else:
            # Process non-streaming query
            result = await processor.process_stateful_query(
                user_id=user_id,
                session_id=session_id,
                messages=request.messages,
                models=request.models,
                pii_removal=request.pii_removal,
                obfuscate=request.obfuscate,
                decoy=request.decoy,
                streaming=False
            )
            
            return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Stateful query error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )


@router.post("/create-session", response_model=CreateSessionResponse)
async def create_session(
    request: CreateSessionRequest,
    authorization: Annotated[str, Header()],
    session_manager: Annotated[SessionManager, Depends(get_session_manager)],
    settings: Annotated[Settings, Depends(get_settings)]
):
    """
    Create a new session with model selection and automatic endpoint assignment.
    
    Combines the functionality of web API's initialize-session, update-models, 
    get-endpoints, and choose-endpoint into a single streamlined call.
    
    The session is created with the specified models and an endpoint is 
    automatically selected. The selected model cannot be changed later.
    """
    try:
        # Extract user ID from token
        user_id = get_user_id_from_token(authorization, settings)
        logger.info(f"Creating session for user {user_id} with models: {request.models}")
        
        # Step 1: Initialize empty session
        session_id = await session_manager.initialize_session(user_id)
        logger.debug(f"Initialized session {session_id}")
        
        # Step 2: Set models for the session (this generates available endpoints)
        needs_disconnection, update_message = await session_manager.update_session_models(
            session_id, request.models
        )
        logger.debug(f"Updated session models: {update_message}")
        
        # Step 3: Get available endpoints for validation
        endpoints = await session_manager.get_session_endpoints(session_id)
        if not endpoints:
            # Clean up the session since no endpoints are available
            await session_manager.end_session(session_id)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"No endpoints available for the selected models: {request.models}"
            )
        
        available_endpoints_count = len(endpoints)
        logger.debug(f"Found {available_endpoints_count} available endpoints")
        
        # Step 4: Automatically choose a random endpoint
        provider, model, chosen_endpoint_id, api_key_hash = await session_manager.choose_session_endpoint(
            session_id, None  # None means random selection
        )
        
        logger.info(f"Session {session_id} created with endpoint {chosen_endpoint_id} ({provider}/{model})")
        
        return CreateSessionResponse(
            session_id=session_id,
            endpoint_id=chosen_endpoint_id,
            provider=provider,
            model=model,
            api_key_hash=api_key_hash,
            message=f"Session created with {provider}/{model} (randomly selected)",
            available_endpoints=available_endpoints_count
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create session error: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error"
        )