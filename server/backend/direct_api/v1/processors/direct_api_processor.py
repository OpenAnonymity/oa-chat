"""
Direct API Processor - Orchestrates privacy features and delegates message sending to QueryRouter.
"""

from typing import List, Dict, Optional, Any, Union, AsyncGenerator
from loguru import logger
import uuid

from ....shared.services.query.routing import QueryRouter
from ....shared.services.privacy import PrivacyProcessor
from ....shared.models.responses import (
    StatelessQueryResponse,
    StatefulQueryResponse,
    QueryMetaData,
    QueryChoice
)
from ....shared.utils.utils import parse_model_string
from ....shared.services.streaming import (
    extract_text_from_chunk,
    process_sync_stream_in_thread,
    create_openai_streaming_chunk
)


class DirectAPIProcessor:
    """
    Processes direct API queries with privacy features.
    ONLY orchestrates - delegates all message sending to QueryRouter.
    """
    
    def __init__(self, query_router: QueryRouter, privacy_processor: PrivacyProcessor, session_manager: Optional[Any] = None):
        """
        Initialize with dependency injection.
        
        Args:
            query_router: QueryRouter instance for message sending
            privacy_processor: PrivacyProcessor instance for privacy features
            session_manager: Optional SessionManager for stateful queries
        """
        self.query_router = query_router
        self.privacy_processor = privacy_processor
        self.session_manager = session_manager
        logger.info("DirectAPIProcessor initialized")

    async def _process_query_core(
        self,
        user_id: int,
        messages: List[Dict[str, str]],
        models: Optional[List[str]],
        pii_removal: bool,
        obfuscate: bool,
        decoy: bool,
        is_stateless: bool,
        session_id: Optional[str] = None,
        streaming: bool = False
    ) -> Dict[str, Any]:
        """
        Core query processing logic shared by all methods.
        Returns standardized result dict for different output formatters.
        """
        # Generate turn ID
        # TODO: turnid will be stored for token usage tracking (relates to the privacy pass token and LLM token usage)
        turn_id = f"turn_{uuid.uuid4().hex[:12]}"
        query_type = "stateless" if is_stateless else "stateful"
        stream_info = "streaming" if streaming else "non-streaming"
        logger.info(f"Processing {stream_info} {query_type} query {turn_id} for user {user_id}")
        
        # Pass user input as-is - no manipulation needed
        processed_prompt = messages
        
        # Privacy processing now supports messages natively
        if pii_removal or obfuscate:
            processed_prompt, privacy_metadata = await self.privacy_processor.process_request_privacy_features(
                messages=processed_prompt,
                pii_removal=pii_removal,
                obfuscate=obfuscate,
                decoy=decoy,
                is_stateless=is_stateless,
                session_id=session_id
            )
        else:
            privacy_metadata = {
                "pii_detected": False,
                "obfuscated": False,
                "decoy_requested": decoy and is_stateless,
                "original_messages": messages  # Store full conversation consistently
            } if decoy else None
        
        # Decoy generation now supports messages natively
        decoy_prompts = None
        if decoy:
            should_generate = await self.privacy_processor.should_generate_decoys(
                messages=messages,
                decoy_requested=True,
                is_stateless=is_stateless
            )
            
            if should_generate:
                decoy_prompts = await self.privacy_processor.generate_decoy_queries(
                    messages=processed_prompt,
                    count=2
                )
                logger.info(f"Generated {len(decoy_prompts)} decoy queries for temporal mixing")
        
        # Query routing
        endpoint_id = None
        if not is_stateless and session_id:
            # For stateful queries, we need to get the endpoint_id from the session
            # QueryRouter works with endpoints, not sessions
            if self.session_manager:
                session_state = await self.session_manager.get_session(session_id)
                if session_state and session_state.endpoint_id:
                    endpoint_id = session_state.endpoint_id
                    logger.debug(f"Using endpoint {endpoint_id} for session {session_id}")
                else:
                    logger.warning(f"No endpoint found for session {session_id}")
            else:
                logger.warning("SessionManager not available for stateful query")
        
        result = await self.query_router.route_query(
            user_id=user_id,
            prompt=processed_prompt,
            streaming=streaming,
            stateless=is_stateless,
            endpoint_id=endpoint_id,  # Use endpoint_id for stateful, None for stateless
            models=models,
            ttl=300 if is_stateless else None,
            decoy_prompts=decoy_prompts
        )
        
        if not result["success"]:
            raise Exception(result.get("error", "Query routing failed"))
        
        # Return standardized result
        return {
            "turn_id": turn_id,
            "result": result,
            "obfuscate": obfuscate,
            "session_id": session_id,
            "is_stateless": is_stateless,
            "streaming": streaming
        }
    
    async def _format_non_streaming_response(
        self, 
        core_result: Dict[str, Any],
        pii_removal: bool = False,
        decoy: bool = False
    ) -> Union[StatelessQueryResponse, StatefulQueryResponse]:
        """Format core result as non-streaming response."""
        turn_id = core_result["turn_id"]
        result = core_result["result"]
        obfuscate = core_result["obfuscate"]
        session_id = core_result["session_id"]
        is_stateless = core_result["is_stateless"]
        
        # Extract and process response
        response_data = result["response"]
        
        # Extract content from OpenAI-style chat completion response
        if "choices" in response_data and len(response_data["choices"]) > 0:
            choice = response_data["choices"][0]
            if "message" in choice and "content" in choice["message"]:
                response_content = choice["message"]["content"]
            else:
                response_content = str(choice.get("text", choice))
        elif response_data.get("type") == "complete":
            response_content = response_data.get("content", "")
        else:
            response_content = response_data.get("content", str(response_data))
        
        # Apply obfuscation if needed
        if obfuscate:
            processed_response = await self.privacy_processor.process_response_privacy_features(
                response_content=response_content,
                obfuscate=obfuscate,
                session_id=session_id
            )
        else:
            processed_response = response_content
        
        # Create response object
        endpoint_info = result["endpoint_info"]
        response_data = result["response"]
        
        base_response_data = {
            "turn_id": turn_id,
            "choices": [QueryChoice(
                index=0,
                message={"role": "assistant", "content": processed_response},
                finish_reason="stop"
            )],
            "meta_data": QueryMetaData(
                endpoint_id=endpoint_info["endpoint_id"],
                model=f"{endpoint_info['provider']}/{endpoint_info['model']}",
                token_usage=response_data.get("usage", {}),
                total_token_used=response_data.get("usage", {}).get("total_tokens", 0)
            )
        }
        
        # Add session-specific metadata for stateful queries
        if not is_stateless:
            # Calculate privacy score for stateful queries
            privacy_score = self.privacy_processor.calculate_privacy_score(
                pii_removal=pii_removal,
                obfuscate=obfuscate
            )
            base_response_data["meta_data"].session_privacy_score = privacy_score
            base_response_data["session_id"] = session_id  # Add required session_id field
            return StatefulQueryResponse(**base_response_data)
        else:
            return StatelessQueryResponse(**base_response_data)
    
    async def _format_streaming_response(
        self, 
        core_result: Dict[str, Any]
    ) -> AsyncGenerator[str, None]:
        """Format core result as streaming response."""
        result = core_result["result"]
        obfuscate = core_result["obfuscate"]
        session_id = core_result["session_id"]
        
        try:
            # Handle streaming response
            if "stream" in result:
                stream = result["stream"]
                endpoint_info = result["endpoint_info"]
                provider = endpoint_info["provider"]
                model = endpoint_info["model"]
                
                # Handle both sync and async streams
                if hasattr(stream, '__aiter__'):
                    # Async stream
                    async for chunk in stream:
                        text_content = extract_text_from_chunk(chunk)
                        if text_content:
                            # Apply obfuscation if needed
                            if obfuscate:
                                processed_content = await self.privacy_processor.process_response_privacy_features(
                                    response_content=text_content,
                                    obfuscate=obfuscate,
                                    session_id=session_id
                                )
                            else:
                                processed_content = text_content
                            
                            response_chunk = create_openai_streaming_chunk(
                                content=processed_content,
                                provider=provider,
                                model=model
                            )
                            yield response_chunk
                else:
                    # Sync stream
                    async for chunk in process_sync_stream_in_thread(stream):
                        text_content = extract_text_from_chunk(chunk)
                        if text_content:
                            if obfuscate:
                                processed_content = await self.privacy_processor.process_response_privacy_features(
                                    response_content=text_content,
                                    obfuscate=obfuscate,
                                    session_id=session_id
                                )
                            else:
                                processed_content = text_content
                            
                            response_chunk = create_openai_streaming_chunk(
                                content=processed_content,
                                provider=provider,
                                model=model
                            )
                            yield response_chunk
                
                # Send final chunk
                final_chunk = create_openai_streaming_chunk(
                    content="",
                    provider=provider,
                    model=model,
                    finish_reason="stop"
                )
                yield final_chunk
                yield "data: [DONE]\n\n"
            
        except Exception as e:
            # Send error chunk
            error_chunk = create_openai_streaming_chunk(
                content=f"Processing error: {str(e)}",
                provider="system",
                model="error",
                finish_reason="error"
            )
            yield error_chunk
    
    async def process_stateless_query(
        self,
        user_id: int,
        messages: List[Dict[str, str]],
        models: Optional[List[str]],
        pii_removal: bool,
        obfuscate: bool,
        decoy: bool,
        streaming: bool = False
    ) -> StatelessQueryResponse:
        """Process stateless query (non-streaming)."""
        if streaming:
            raise ValueError("Use process_stateless_query_streaming for streaming queries")
        
        core_result = await self._process_query_core(
            user_id=user_id,
            messages=messages,
            models=models,
            pii_removal=pii_removal,
            obfuscate=obfuscate,
            decoy=decoy,
            is_stateless=True,
            streaming=False
        )
        
        return await self._format_non_streaming_response(core_result, pii_removal, decoy)
    
    async def process_stateless_query_streaming(
        self,
        user_id: int,
        messages: List[Dict[str, str]],
        models: Optional[List[str]],
        pii_removal: bool,
        obfuscate: bool,
        decoy: bool
    ) -> AsyncGenerator[str, None]:
        """Process stateless query (streaming)."""
        core_result = await self._process_query_core(
            user_id=user_id,
            messages=messages,
            models=models,
            pii_removal=pii_removal,
            obfuscate=obfuscate,
            decoy=decoy,
            is_stateless=True,
            streaming=True
        )
        
        async for chunk in self._format_streaming_response(core_result):
            yield chunk
    
    async def process_stateful_query(
        self,
        user_id: int,
        session_id: str,
        messages: List[Dict[str, str]],
        models: Optional[List[str]],
        pii_removal: bool,
        obfuscate: bool,
        decoy: bool,
        streaming: bool = False
    ) -> StatefulQueryResponse:
        """Process stateful query (non-streaming)."""
        if streaming:
            raise ValueError("Use process_stateful_query_streaming for streaming queries")
        
        core_result = await self._process_query_core(
            user_id=user_id,
            messages=messages,
            models=models,  # Can be None or override session models
            pii_removal=pii_removal,
            obfuscate=obfuscate,
            decoy=decoy,
            is_stateless=False,
            session_id=session_id,
            streaming=False
        )
        
        return await self._format_non_streaming_response(core_result, pii_removal, decoy)
    
    async def process_stateful_query_streaming(
        self,
        user_id: int,
        session_id: str,
        messages: List[Dict[str, str]],
        models: Optional[List[str]],
        pii_removal: bool,
        obfuscate: bool,
        decoy: bool
    ) -> AsyncGenerator[str, None]:
        """Process stateful query (streaming)."""
        core_result = await self._process_query_core(
            user_id=user_id,
            messages=messages,
            models=models,  # Can be None or override session models  
            pii_removal=pii_removal,
            obfuscate=obfuscate,
            decoy=decoy,
            is_stateless=False,
            session_id=session_id,
            streaming=True
        )
        
        async for chunk in self._format_streaming_response(core_result):
            yield chunk 
