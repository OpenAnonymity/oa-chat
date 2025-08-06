"""
Query Router - The ONLY component responsible for sending messages to LLMs.
Handles stateless and stateful routing, plus temporal mixing for privacy protection.
"""

import asyncio
from typing import Optional, List, Dict, Any, AsyncGenerator, Union
from loguru import logger

from ...clients.key_client import KeyClient
from ...clients.redis import RedisClient
from ...utils.utils import parse_model_string, format_model_string
from ...utils.hashing import generate_endpoint_id
from ...utils.async_random import secure_choice, secure_shuffle, secure_uniform
from ...core.exceptions import EndpointExpiredError


class QueryRouter:
    """
    The ONLY component that sends messages to LLMs.
    
    Features:
    - Stateless: New endpoint for each query, immediate release after response
    - Stateful: Persistent endpoint binding, reuses same endpoint for conversation
    - Temporal mixing: Sends real query mixed with decoys for privacy protection
    - Automatic endpoint list regeneration for stateless queries
    - TTL-based endpoint management
    """
    
    def __init__(self, key_client: KeyClient, redis_client: RedisClient, endpoint_factory):
        """
        Initialize QueryRouter with dependencies.
        
        Args:
            key_client: KeyClient instance for key management
            redis_client: RedisClient instance for caching
            endpoint_factory: EndpointFactory instance for creating endpoints
        """
        self.key_client = key_client
        self.redis = redis_client
        self.endpoint_factory = endpoint_factory
        logger.info("QueryRouter initialized - THE message sender")
    
    async def route_query(
        self,
        user_id: int,
        prompt: Union[str, List[Dict[str, str]]],
        streaming: bool = False,
        stateless: bool = True,
        endpoint_id: Optional[str] = None,
        models: Optional[List[str]] = None,
        ttl: int = 3600,  # 1 hour default TTL
        decoy_prompts: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Route a query using stateless or stateful mode with optional temporal mixing.
        Temporal mixing is automatically enabled when decoy_prompts are provided.
        
        Args:
            user_id: User identifier
            prompt: User prompt to process (string or messages array)
            streaming: Whether to stream the response
            stateless: True for single-turn (new endpoint each time), False for multi-turn
            endpoint_id: Specific endpoint to use (for stateful mode)
            models: List of "provider/model" strings (for stateless mode)
            ttl: TTL for endpoint caching in seconds
            decoy_prompts: Optional decoy prompts for temporal mixing (auto-enables mixing)
            
        Returns:
            Dictionary containing response and routing information
        """
        try:
            if endpoint_id:
                # Use specific endpoint (stateful mode)
                logger.info(f"Routing query for user {user_id} using specific endpoint {endpoint_id}")
                return await self._route_with_endpoint(
                    user_id=user_id,
                    endpoint_id=endpoint_id,
                    prompt=prompt,
                    streaming=streaming,
                    stateless=stateless,
                    ttl=ttl,
                    decoy_prompts=decoy_prompts
                )
            else:
                # Select endpoint automatically

                # TODO: remove this once we have a default model to use for auto-selection
                if not models:
                    raise ValueError("Models list is required when no specific endpoint is provided")
                 
                logger.info(f"Routing query for user {user_id} with auto-selection from models: {models}")
                return await self._route_with_auto_selection(
                    user_id=user_id,
                    models=models,
                    prompt=prompt,
                    streaming=streaming,
                    stateless=stateless,
                    ttl=ttl,
                    decoy_prompts=decoy_prompts
                )
                
        except EndpointExpiredError:
            # Re-raise endpoint expired errors to be handled by FastAPI
            raise
        except Exception as e:
            logger.error(f"Error in route_query: {str(e)}")
            return {
                "success": False,
                "error": str(e),
                "response": None,
                "endpoint_info": None,
                "new_endpoints": None
            }
    
    async def _route_with_endpoint(
        self,
        user_id: int,
        endpoint_id: str,
        prompt: str,
        streaming: bool,
        stateless: bool,
        ttl: int,
        decoy_prompts: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Route query using a specific endpoint."""
        try:
            # Get endpoint data
            endpoint_data = await self.redis.get_endpoint(endpoint_id)
            if not endpoint_data:
                raise EndpointExpiredError(endpoint_id)
            
            # Create endpoint instance
            api_key = endpoint_data.get("api_key")
            if not api_key:
                raise Exception(f"No API key found for endpoint {endpoint_id}")
            
            endpoint_instance = self.endpoint_factory.create_endpoint(
                provider=endpoint_data["provider"],
                model_tag=endpoint_data["model"],
                api_key=api_key
            )
            
            if not endpoint_instance:
                raise Exception(f"Failed to create endpoint instance for {endpoint_id}")
            
            # Send message with optional temporal mixing
            response = await self._send_message(
                endpoint_instance=endpoint_instance,
                prompt=prompt,
                streaming=streaming,
                decoy_prompts=decoy_prompts
            )
            
            return {
                "success": True,
                "response": response,
                "endpoint_info": {
                    "endpoint_id": endpoint_id,
                    "provider": endpoint_data["provider"],
                    "model": endpoint_data["model"],
                    "stateless": stateless
                },
                "new_endpoints": None  # Only for auto-selection mode
            }
            
        except EndpointExpiredError:
            # Re-raise endpoint expired errors to be handled by FastAPI
            raise
        except Exception as e:
            logger.error(f"Error routing with endpoint {endpoint_id}: {str(e)}")
            raise
    
    async def _route_with_auto_selection(
        self,
        user_id: int,
        models: List[str],
        prompt: str,
        streaming: bool,
        stateless: bool,
        ttl: int,
        decoy_prompts: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Route query with automatic endpoint selection."""
        try:
            # Generate temporary session ID for endpoint selection
            temp_session_id = f"temp_{user_id}_{int(asyncio.get_event_loop().time())}"
            
            # Select endpoints from key server
            selected_keys = await self.key_client.select_keys_for_session(
                session_id=temp_session_id,
                user_id=user_id,
                models=models,
                count_per_model=1  # One endpoint per model for auto-selection
            )
            
            if not selected_keys:
                raise Exception("No endpoints available for selected models")
            
            # Randomly choose one endpoint
            chosen_key = await secure_choice(selected_keys)
            
            # Generate endpoint ID in web server (not from key server)
            endpoint_id = await generate_endpoint_id(
                provider=chosen_key["provider"],
                model=chosen_key["model"],
                key_id=chosen_key["key_id"],
                session_id=temp_session_id,
                length=20
            )
            
            # Store endpoint data temporarily
            endpoint_data = {
                "id": endpoint_id,
                "provider": chosen_key["provider"],
                "model": chosen_key["model"],
                "api_key": chosen_key["api_key"],
                "status": chosen_key["status"],
                "created_at": temp_session_id  # Use temp session for tracking
            }
            
            await self.redis.set_endpoint(endpoint_id, endpoint_data, ttl=ttl)
            
            # Create endpoint instance
            endpoint_instance = self.endpoint_factory.create_endpoint(
                provider=chosen_key["provider"],
                model_tag=chosen_key["model"],
                api_key=chosen_key["api_key"]
            )
            
            if not endpoint_instance:
                raise Exception(f"Failed to create endpoint instance")
            
            # Send message with optional temporal mixing
            response = await self._send_message(
                endpoint_instance=endpoint_instance,
                prompt=prompt,
                streaming=streaming,
                decoy_prompts=decoy_prompts
            )
            
            # Prepare new endpoints list for client (all with web server generated IDs)
            new_endpoints = []
            for key_info in selected_keys:
                # Generate endpoint ID for each endpoint
                ep_id = await generate_endpoint_id(
                    provider=key_info["provider"],
                    model=key_info["model"],
                    key_id=key_info["key_id"],
                    session_id=temp_session_id,
                    length=20
                )
                new_endpoints.append({
                    "id": ep_id,
                    "provider": key_info["provider"],
                    "model": key_info["model"],
                    "status": key_info["status"],
                    "tokens_hour": key_info["tokens_hour"],
                    "tokens_total": key_info["tokens_total"]
                })
            
            return {
                "success": True,
                "response": response,
                "endpoint_info": {
                    "endpoint_id": endpoint_id,
                    "provider": chosen_key["provider"],
                    "model": chosen_key["model"],
                    "stateless": stateless
                },
                "new_endpoints": new_endpoints  # For client to update UI
            }
            
        except EndpointExpiredError:
            # Re-raise endpoint expired errors to be handled by FastAPI
            raise
        except Exception as e:
            logger.error(f"Error in auto-selection routing: {str(e)}")
            raise
    
    async def _send_message(
        self,
        endpoint_instance: Any,
        prompt: str,
        streaming: bool,
        decoy_prompts: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Send message with optional temporal mixing for privacy protection.
        THE ONLY method that actually calls send_message on endpoints.
        """
        if decoy_prompts:
            # Use temporal mixing for privacy protection
            return await self._send_with_temporal_mixing(
                endpoint_instance=endpoint_instance,
                real_prompt=prompt,
                decoy_prompts=decoy_prompts,
                streaming=streaming
            )
        else:
            # Regular message sending
            return await self._send_regular_message(
                endpoint_instance=endpoint_instance,
                prompt=prompt,
                streaming=streaming
            )
    
    def _convert_messages_to_string(self, messages: List[Dict[str, str]]) -> str:
        """Convert messages array to string format for providers that expect strings."""
        if not messages:
            return ""
        
        # Simple conversion that preserves context
        parts = []
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role and content:
                parts.append(f"{role}: {content}")
        
        return "\n".join(parts)
    
    async def _send_regular_message(
        self, 
        endpoint_instance: Any, 
        prompt: Union[str, List[Dict[str, str]]], 
        streaming: bool
    ) -> Dict[str, Any]:
        """Send a message to endpoint (handles both regular queries and real query in temporal mixing)."""
        try:
            # Convert messages to string for providers that expect strings
            prompt_str = self._convert_messages_to_string(prompt) if isinstance(prompt, list) else prompt
            
            logger.debug("Executing query (unified message sender)")
            if streaming:
                # Handle streaming response - return the raw streaming response for frontend
                streaming_response = endpoint_instance.send_message(prompt_str)
                
                return {
                    "type": "streaming",
                    "stream": streaming_response,
                    "content": ""  # Will be populated by streaming
                }
            else:
                # Non-streaming response
                if hasattr(endpoint_instance, 'send_message_non_streaming'):
                    # Use non-streaming method if available
                    response = await endpoint_instance.send_message_non_streaming(prompt_str)
                else:
                    # Fallback to streaming method
                    response = endpoint_instance.send_message(prompt_str)
                
                if isinstance(response, dict):
                    # Extract content from structured response
                    content = ""
                    if "choices" in response and len(response["choices"]) > 0:
                        content = response["choices"][0].get("message", {}).get("content", "")
                    else:
                        content = response.get("content", str(response))
                    
                    return {
                        "type": "complete",
                        "content": content,
                        "usage": response.get("usage", {}),
                        "raw_response": response
                    }
                else:
                    return {
                        "type": "complete",
                        "content": str(response),
                        "usage": {},
                        "raw_response": response
                    }
                    
        except Exception as e:
            logger.error(f"Error sending regular message: {str(e)}")
            raise
    
    async def _send_with_temporal_mixing(
        self,
        endpoint_instance: Any,
        real_prompt: str,
        decoy_prompts: List[str],
        streaming: bool
    ) -> Dict[str, Any]:
        """
        Efficient temporal mixing that maintains network indistinguishability
        while minimizing resource usage and achieving zero TTFT impact.
        
        Key features:
        - All queries sent simultaneously to same endpoint with identical network behavior
        - Random shuffle provides timing obfuscation without delays
        - Real query processed immediately (zero TTFT impact)  
        - Decoy responses discarded immediately (memory/CPU efficient)
        - Provider cannot distinguish queries through network analysis
        """
        total_queries = len(decoy_prompts) + 1
        logger.info(f"Starting efficient temporal mixing with {total_queries} queries")
        
        # Prepare all queries with secure random positioning
        all_prompts = [real_prompt] + decoy_prompts
        
        # Randomly shuffle to determine send order
        query_indices = list(range(len(all_prompts)))
        await secure_shuffle(query_indices)
        
        # Create separate endpoint instances for true parallelism
        # Each query needs its own instance to avoid serialization
        provider = endpoint_instance.get_provider() 
        model_tag = endpoint_instance.get_model_tag()
        api_key = endpoint_instance.get_api_key()
        
        # Start all queries simultaneously with NO delays
        # Random shuffling already provides timing obfuscation
        query_tasks = []
        real_task_index = None
        
        for i, shuffled_index in enumerate(query_indices):
            # Create separate endpoint instance for each query (prevents serialization)
            query_endpoint = self.endpoint_factory.create_endpoint(
                provider=provider,
                model_tag=model_tag,
                api_key=api_key
            )
            
            if shuffled_index == 0:  # Real query
                # Real query - immediate execution
                task = asyncio.create_task(
                    self._send_regular_message(
                        endpoint_instance=query_endpoint,
                        prompt=all_prompts[shuffled_index],
                        streaming=streaming
                    )
                )
                real_task_index = i
            else:
                # Decoy query - immediate execution
                decoy_prompt = all_prompts[shuffled_index]
                task = asyncio.create_task(
                    self._execute_decoy_query(
                        endpoint_instance=query_endpoint,
                        prompt=decoy_prompt,
                        query_index=shuffled_index,  # Use original index for logging
                        streaming=streaming  # CRITICAL: Must match real query!
                    )
                )
            
            query_tasks.append(task)
        
        # Wait ONLY for the real query (no TTFT impact)
        real_result = await query_tasks[real_task_index]
        
        # All decoy tasks continue in background
        # Register them for connection maintenance
        self._register_background_decoys(query_tasks, real_task_index)
        
        # Return real result immediately with minimal temporal mixing metadata
        return {
            **real_result,
            "temporal_mixing": {
                "active": True,
                "total_queries": total_queries
                # No position info that could leak timing patterns
            }
        }
    


    async def _execute_decoy_query(
        self,
        endpoint_instance: Any,
        prompt: str,
        query_index: int,
        streaming: bool  # MUST match real query!
    ) -> None:
        """
        Execute decoy query immediately with IDENTICAL network behavior to real query:
        - Same request/response cycle as real query
        - Same connection lifecycle as real query  
        - Response discarded immediately (memory efficient)
        """
        try:
            logger.debug(f"Executing decoy {query_index} immediately (shuffle-based privacy)")
            
            # CRITICAL: Use identical request pattern as real query
            if streaming:
                # Streaming mode - consume all chunks (same as real query)
                response_stream = endpoint_instance.send_message(prompt)
                
                # Consume stream to nowhere (memory efficient)
                if hasattr(response_stream, '__aiter__'):
                    async for chunk in response_stream:
                        pass  # Discard immediately - no storage, no processing
                else:
                    # Run sync iterator in thread pool to avoid blocking event loop
                    await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: list(response_stream)  # Consume iterator in thread
                    )
                
                logger.debug(f"Decoy {query_index} streaming completed, response discarded")
                
            else:
                # Non-streaming mode - same as real query
                if hasattr(endpoint_instance, 'send_message_non_streaming'):
                    response = await endpoint_instance.send_message_non_streaming(prompt)
                else:
                    # Use whatever the real query would use
                    response = endpoint_instance.send_message(prompt)
                
                # Response received and immediately discarded (minimal memory impact)
                logger.debug(f"Decoy {query_index} non-streaming completed, response discarded")
            
        except Exception as e:
            # Decoy errors logged but don't affect real query
            logger.debug(f"Decoy {query_index} error: {str(e)}")
            # No special error handling - fail naturally like real query would

    def _register_background_decoys(self, tasks: List[asyncio.Task], real_index: int):
        """
        Register decoy tasks for proper cleanup.
        Prevents memory leaks from accumulating background tasks.
        """
        # Track background tasks
        if not hasattr(self, '_background_decoys'):
            self._background_decoys = set()
        
        for i, task in enumerate(tasks):
            if i != real_index:  # Skip real query task
                self._background_decoys.add(task)
                
                # Add cleanup callback
                task.add_done_callback(
                    lambda t: self._background_decoys.discard(t)
                )

    async def cleanup_background_tasks(self):
        """
        Clean up any remaining background tasks on shutdown.
        Call this in your cleanup/shutdown handler.
        """
        if hasattr(self, '_background_decoys'):
            # Cancel remaining tasks
            for task in self._background_decoys:
                if not task.done():
                    task.cancel()
            
            # Wait for cancellations
            await asyncio.gather(*self._background_decoys, return_exceptions=True)
            
            self._background_decoys.clear()
    
    async def close(self):
        """Close router and cleanup resources."""
        # Clean up background decoy tasks
        await self.cleanup_background_tasks()
        logger.info("QueryRouter closed") 