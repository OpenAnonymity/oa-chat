"""
LLM generate API endpoints with privacy features.
Web API controller - delegates all message sending to QueryRouter.
"""

from typing import Annotated, Optional, Dict
from fastapi import APIRouter, Depends, HTTPException, status, Request
from fastapi.responses import StreamingResponse
from loguru import logger
import json
import asyncio

from ...shared.core.dependencies import get_session_manager, get_query_router, get_turn_completion_service, get_privacy_processor
from ...shared.models.requests import GenerateRequest
from ...shared.models.responses import GenerateResponse
from ...shared.services.session.session_manager import SessionManager
from ...shared.services.session.turn_completion import TurnCompletionService
from ...shared.services.query.routing import QueryRouter
from ...shared.services.privacy.privacy import PrivacyProcessor
from ...shared.core.exceptions import EndpointExpiredError
from ...shared.services.streaming import extract_text_from_chunk, process_sync_stream_in_thread, create_status_chunk, create_content_chunk


router = APIRouter(
    tags=["chat"]
)


@router.post("/generate")
async def generate(
    request: GenerateRequest,
    http_request: Request,
    session_manager: Annotated[SessionManager, Depends(get_session_manager)],
    query_router: Annotated[QueryRouter, Depends(get_query_router)],
    turn_completion: Annotated[TurnCompletionService, Depends(get_turn_completion_service)],
    privacy_processor: Annotated[PrivacyProcessor, Depends(get_privacy_processor)]
):
    """
    Generate text for web UI with privacy features.
    Supports both single-turn (stateless=true) and multi-turn (stateless=false) with existing endpoints.
    Privacy features: PII removal, obfuscation, decoy generation.
    ONLY handles web API logic - delegates message sending to QueryRouter.
    """
    try:
        logger.info(f"Web generate request for session {request.session_id}, stateless={request.stateless}, privacy=[PII:{request.pii_removal}, Obf:{request.obfuscate}, Decoy:{request.decoy}]")
        
        # Get client IP for logging
        client_ip = http_request.client.host if http_request.client else "unknown"
        
        # Validate session
        session_state = await _validate_session(
            session_manager, request.session_id, request.user_id, client_ip
        )
        
        # Web API requires pre-connected endpoint
        if not session_state.endpoint_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="No endpoint connected. Please connect to an endpoint first using /api/web/session/bind-endpoint or /api/web/session/connect"
            )
        
        # For streaming requests, privacy processing will be done inside the stream
        # to show real-time progress. For non-streaming, do it here.
        if request.streaming:
            # Pass original request data to streaming handler for real-time processing
            processed_prompt = request.prompt  # Will be processed in stream
            privacy_metadata = None  # Will be generated in stream
            decoy_prompts = None  # Will be generated in stream
        else:
            # Process request through privacy features (only if needed)
            processed_prompt = request.prompt
            
            # Only call privacy processor if any privacy features are enabled
            if request.pii_removal or request.obfuscate:
                processed_prompt, privacy_metadata = await privacy_processor.process_request_privacy_features(
                    prompt=request.prompt,
                    pii_removal=request.pii_removal,
                    obfuscate=request.obfuscate,
                    decoy=request.decoy,
                    is_stateless=request.stateless,
                    session_id=request.session_id
                )
            else:
                # Initialize minimal privacy metadata only when needed for decoy generation
                privacy_metadata = {
                    "pii_detected": False,
                    "obfuscated": False,
                    "decoy_requested": request.decoy and request.stateless,
                    "original_prompt": request.prompt
                } if request.decoy and request.stateless else None
            
            # Decoy generation is handled separately because it doesn't modify the prompt
            # and can be used independently of other privacy features
            decoy_prompts = None
            
            if request.decoy and request.stateless:
                # Use original prompt directly for decoy generation
                original_prompt = privacy_metadata["original_prompt"] if privacy_metadata else request.prompt
                
                # Check if we should generate decoys
                should_generate = await privacy_processor.should_generate_decoys(
                    original_prompt=original_prompt,
                    decoy_requested=True,
                    is_stateless=request.stateless
                )
                
                if should_generate:
                    decoy_prompts = await privacy_processor.generate_decoy_queries(
                        original_prompt=original_prompt,
                        count=2
                    )
                    logger.info(f"Generated {len(decoy_prompts)} decoy queries for temporal mixing")
        
                # Handle streaming vs non-streaming differently
        if request.streaming:
            # For streaming: privacy processing and query execution happen inside the stream
            return await _handle_streaming_response(
                request=request,
                result={},  # Empty result since we'll execute query in stream
                session_state=session_state,
                query_router=query_router,
                turn_completion=turn_completion,
                privacy_processor=privacy_processor
            )
        
        # For non-streaming: execute query here with pre-processed privacy features
        result = await query_router.route_query(
            user_id=request.user_id or 0,
            prompt=processed_prompt,
            streaming=request.streaming,
            stateless=request.stateless,
            endpoint_id=session_state.endpoint_id,
            decoy_prompts=decoy_prompts
        )
        
        # Handle response
        if not result.get("success"):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=result.get("error", "Failed to generate response")
            )
        
        # Process response through privacy features (only if needed)
        response_data = result.get("response", {})
        raw_content = response_data.get("content", "")
        
        # Only process response if obfuscation was enabled
        if request.obfuscate:
            processed_content = await privacy_processor.process_response_privacy_features(
                response_content=raw_content,
                obfuscate=request.obfuscate,
                session_id=request.session_id
            )
        else:
            processed_content = raw_content
        
        # Handle non-streaming response
        endpoint_info = result.get("endpoint_info", {})
        
        # Handle single-turn completion for non-streaming
        new_endpoints = None
        completion_message = None
        if request.stateless:
            completion_result = await turn_completion.complete_single_turn(request.session_id)
            if completion_result["success"]:
                new_endpoints = completion_result["new_endpoints"]
                completion_message = completion_result["message"]
            else:
                completion_message = completion_result["message"]
        
        # Create response
        generate_response = GenerateResponse(
            content=processed_content,
            provider=endpoint_info.get("provider", "unknown"),
            model=endpoint_info.get("model", "unknown"),
            usage=response_data.get("usage", {}),
            new_endpoints=new_endpoints
        )
        
        # Add session status for single-turn mode
        if request.stateless:
            response_dict = generate_response.model_dump()
            response_dict["session_disconnected"] = True
            response_dict["message"] = completion_message or "Single-turn completed."
            
            # Add temporal mixing metadata if available
            if "temporal_mixing" in response_data:
                response_dict["temporal_mixing"] = response_data["temporal_mixing"]
                
            return response_dict
        
        return generate_response
        
    except EndpointExpiredError as e:
        logger.warning(f"Endpoint expired during generate request: {str(e)}")
        raise
    except Exception as e:
        if isinstance(e, HTTPException):
            raise e
        elif isinstance(e, ValueError):
            logger.warning(f"generate request: {str(e)}")
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
        else:
            logger.error(f"generate request: {str(e)}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Internal server error")


async def _validate_session(
    session_manager: SessionManager,
    session_id: str,
    user_id: Optional[int],
    client_ip: str
):
    """Validate session and handle various error cases."""
    session_state = await session_manager.get_session(session_id)
    
    if not session_state:
        # Session not found - check if we can validate against user history
        if user_id:
            # We have user_id, can check session history for better security
            session_status = await session_manager.check_session_status(session_id, user_id)
            
            if session_status["status"] == "expired":
                # Session was valid but expired
                raise HTTPException(
                    status_code=status.HTTP_410_GONE,
                    detail={
                        "error": "session_expired",
                        "message": session_status["message"],
                        "action": "create_new_session"
                    }
                )
            elif session_status["status"] == "invalid" and session_status["should_log_ip"]:
                # Potentially malicious request - log IP
                await session_manager._log_suspicious_activity(user_id, session_id, client_ip)
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Session not found"
                )
            else:
                # Some other status
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Session not found"
                )
        else:
            # No user_id provided - assume expired for better UX
            raise HTTPException(
                status_code=status.HTTP_410_GONE,
                detail={
                    "error": "session_expired",
                    "message": "Session has expired. Please create a new session for better privacy.",
                    "action": "create_new_session"
                }
            )
    
    return session_state




async def _handle_streaming_response(
    request: GenerateRequest,
    result: Dict,
    session_state,
    query_router: QueryRouter,
    turn_completion: TurnCompletionService,
    privacy_processor: PrivacyProcessor
):
    """Handle streaming response for web UI."""
    endpoint_info = result.get("endpoint_info", {})
    
    async def generate_stream():
        try:
            # Real-time privacy processing with live status updates
            processed_prompt = request.prompt
            privacy_metadata = None
            decoy_prompts = None
            
            # Step 1: PII Removal (if requested)
            if request.pii_removal:
                yield create_status_chunk('pii', '🛡️ Analyzing query for personal information...', 'processing')
                
                # Process only PII removal first
                processed_prompt, privacy_metadata = await privacy_processor.process_request_privacy_features(
                    prompt=request.prompt,
                    pii_removal=True,
                    obfuscate=False,  # Don't obfuscate yet
                    decoy=False,      # Don't generate decoys yet
                    is_stateless=request.stateless,
                    session_id=request.session_id
                )
                
                if privacy_metadata and privacy_metadata.get("pii_detected"):
                    yield create_status_chunk('pii', '🛡️ Personal information removed from query', 'completed')
                else:
                    yield create_status_chunk('pii', '✅ No personal information detected', 'completed')
            
            # Step 2: Obfuscation (if requested) 
            if request.obfuscate:
                yield create_status_chunk('obfuscation', '🔒 Obfuscating query for enhanced privacy...', 'processing')
                
                # Process obfuscation on the current prompt
                processed_prompt, obf_metadata = await privacy_processor.process_request_privacy_features(
                    prompt=processed_prompt,  # Use already PII-cleaned prompt
                    pii_removal=False,        # Already done
                    obfuscate=True,
                    decoy=False,              # Don't generate decoys yet
                    is_stateless=request.stateless,
                    session_id=request.session_id
                )
                
                # Merge metadata
                if privacy_metadata:
                    privacy_metadata.update(obf_metadata or {})
                else:
                    privacy_metadata = obf_metadata
                    
                yield create_status_chunk('obfuscation', '🔒 Query obfuscated for privacy', 'completed')
            
            # Step 3: Decoy Generation (if requested)
            if request.decoy and request.stateless:
                yield create_status_chunk('decoy', '🎭 Generating decoy queries for temporal mixing...', 'processing')
                
                # Use original prompt for decoy generation (before any processing)
                original_prompt = request.prompt
                
                # Check if we should generate decoys
                should_generate = await privacy_processor.should_generate_decoys(
                    original_prompt=original_prompt,
                    decoy_requested=True,
                    is_stateless=request.stateless
                )
                
                if should_generate:
                    decoy_prompts = await privacy_processor.generate_decoy_queries(
                        original_prompt=original_prompt,
                        count=2
                    )
                    logger.info(f"Generated {len(decoy_prompts)} decoy queries for temporal mixing")
                    yield create_status_chunk('decoy', f'🎭 Generated {len(decoy_prompts)} decoy queries', 'completed')
                else:
                    yield create_status_chunk('decoy', '⏩ Skipping decoy generation (not beneficial)', 'completed')
            
            # Step 4: Query Execution  
            if decoy_prompts:
                yield create_status_chunk('temporal_mixing', f'🎭 Executing {len(decoy_prompts)} decoy queries in parallel...', 'processing')
            
            yield create_status_chunk('processing', '🚀 Executing query...', 'processing')
            
            # Execute the query with processed prompt and decoys
            query_result = await query_router.route_query(
                user_id=request.user_id or 0,
                prompt=processed_prompt,
                streaming=request.streaming,
                stateless=request.stateless,
                endpoint_id=session_state.endpoint_id,
                decoy_prompts=decoy_prompts
            )
            
            if not query_result.get("success"):
                yield f"data: {json.dumps({'error': query_result.get('error', 'Query execution failed'), 'type': 'error'})}\n\n"
                return
                
            endpoint_info = query_result.get("endpoint_info", {})
            
            # Complete all privacy status before starting response
            if decoy_prompts:
                yield create_status_chunk('temporal_mixing', f'🎭 Decoy queries running in background...', 'completed')
            
            # Signal to frontend that response is starting (so it can clear privacy status)
            yield f"data: {json.dumps({'type': 'response_starting', 'message': '💬 Response incoming...'})}\n\n"
            
            # For obfuscation, show thinking mode with streaming raw content
            if request.obfuscate:
                yield f"data: {json.dumps({'type': 'thinking', 'stage': 'start', 'message': '🤔 Processing raw response:'})}\n\n"
                
                response_data = query_result.get("response", {})
                
                if response_data.get("type") == "streaming" and "stream" in response_data:
                    # Process streaming response for obfuscation thinking mode
                    streaming_response = response_data["stream"]
                    accumulated_raw_content = ""
                    
                    try:
                        if hasattr(streaming_response, '__aiter__'):
                            # Async iterator - collect raw streaming content first
                            async for chunk in streaming_response:
                                content_text = extract_text_from_chunk(chunk)
                                if content_text:
                                    accumulated_raw_content += content_text
                                    yield create_content_chunk(
                                        content_text,
                                        endpoint_info.get("provider", "unknown"),
                                        endpoint_info.get("model", "unknown"),
                                        "thinking_chunk"
                                    )
                        else:
                            # Sync iterator - convert to async streaming to avoid blocking
                            async for content_text in process_sync_stream_in_thread(streaming_response, extract_text_from_chunk):
                                accumulated_raw_content += content_text
                                yield create_content_chunk(
                                    content_text,
                                    endpoint_info.get("provider", "unknown"),
                                    endpoint_info.get("model", "unknown"),
                                    "thinking_chunk"
                                )
                        
                        # Send deobfuscation processing message
                        yield f"data: {json.dumps({'type': 'thinking', 'stage': 'deobfuscating', 'message': '🔄 Deobfuscating response for clarity...'})}\n\n"
                        
                        # Process the accumulated content through deobfuscation
                        if accumulated_raw_content:
                            deobfuscated_content = await privacy_processor.process_response_privacy_features(
                                response_content=accumulated_raw_content,
                                obfuscate=True,
                                session_id=request.session_id
                            )
                        else:
                            deobfuscated_content = ""
                        
                        # Send final deobfuscated response
                        yield create_content_chunk(
                            deobfuscated_content,
                            endpoint_info.get("provider", "unknown"),
                            endpoint_info.get("model", "unknown"),
                            "final"
                        )
                        
                    except Exception as stream_error:
                        logger.error(f"Error processing obfuscation streaming: {stream_error}")
                        yield create_content_chunk(
                            f"Obfuscation processing error: {str(stream_error)}",
                            endpoint_info.get("provider", "unknown"),
                            endpoint_info.get("model", "unknown"),
                            "final"
                        )
                else:
                    # Fallback for non-streaming obfuscation - process the content
                    response_content = response_data.get("content", "")
                    if response_content:
                        processed_content = await privacy_processor.process_response_privacy_features(
                            response_content=response_content,
                            obfuscate=True,
                            session_id=request.session_id
                        )
                    else:
                        processed_content = ""
                        
                    yield create_content_chunk(
                        processed_content,
                        endpoint_info.get("provider", "unknown"),
                        endpoint_info.get("model", "unknown"),
                        "final"
                    )
            else:
                # Handle real streaming - iterate over the raw streaming response
                response_data = query_result.get("response", {})
                
                if response_data.get("type") == "streaming" and "stream" in response_data:
                    # Process the raw streaming response
                    streaming_response = response_data["stream"]
                    
                    try:
                        if hasattr(streaming_response, '__aiter__'):
                            # Async iterator
                            async for chunk in streaming_response:
                                content_text = extract_text_from_chunk(chunk)
                                if content_text:
                                    yield create_content_chunk(
                                        content_text,
                                        endpoint_info.get("provider", "unknown"),
                                        endpoint_info.get("model", "unknown"),
                                        "chunk"
                                    )
                        else:
                            # Sync iterator - convert to async streaming to avoid blocking
                            async for content_text in process_sync_stream_in_thread(streaming_response, extract_text_from_chunk):
                                yield create_content_chunk(
                                    content_text,
                                    endpoint_info.get("provider", "unknown"),
                                    endpoint_info.get("model", "unknown"),
                                    "chunk"
                                )
                    except Exception as stream_error:
                        logger.error(f"Error processing streaming response: {stream_error}")
                        yield f"data: {json.dumps({'error': f'Stream processing error: {str(stream_error)}', 'type': 'error'})}\n\n"
                else:
                    # Fallback - send response content directly
                    response_content = response_data.get("content", "")
                    if response_content:
                        yield create_content_chunk(
                            response_content,
                            endpoint_info.get("provider", "unknown"),
                            endpoint_info.get("model", "unknown"),
                            "chunk"
                        )
            

            
            # Handle single-turn completion after streaming is complete
            if request.stateless:
                completion_result = await turn_completion.complete_single_turn(request.session_id)
                
                if completion_result["success"]:
                    if completion_result["new_endpoints"]:
                        # Send endpoints refreshed message
                        refresh_data = {
                            "type": "endpoints_refreshed",
                            "message": completion_result["message"],
                            "new_endpoints": completion_result["new_endpoints"],
                            "auto_selected": completion_result["auto_selected"]
                        }
                        yield f"data: {json.dumps(refresh_data)}\n\n"
                    else:
                        # No models selected, send disconnection notice
                        final_data = {
                            "type": "session_disconnected",
                            "message": completion_result["message"]
                        }
                        yield f"data: {json.dumps(final_data)}\n\n"
                else:
                    # Send error message
                    error_data = {
                        "type": "endpoints_refresh_error",
                        "message": completion_result["message"]
                    }
                    yield f"data: {json.dumps(error_data)}\n\n"
            
            yield "data: [DONE]\n\n"
            
        except Exception as e:
            logger.error(f"Streaming error: {str(e)}")
            error_chunk = {
                "error": str(e),
                "type": "error"
            }
            yield f"data: {json.dumps(error_chunk)}\n\n"
    
    return StreamingResponse(
        generate_stream(),
        media_type="text/plain",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )
