"""
Shared streaming utilities for both Web API and Direct API.
Extracted from web_api for reusability.
"""

import json
import asyncio
import queue
import threading
from typing import Optional, AsyncGenerator, Any
from loguru import logger


def extract_text_from_chunk(chunk) -> Optional[str]:
    """
    Extract text content from provider streaming response chunks.
    Handles different provider formats (OpenAI, Anthropic, etc.).
    
    Args:
        chunk: Streaming response chunk from provider
        
    Returns:
        Extracted text content or None
    """
    try:
        # Handle OpenAI Response API format
        if hasattr(chunk, 'type'):
            if chunk.type == 'response.output_text.delta' and hasattr(chunk, 'delta'):
                return chunk.delta
            elif chunk.type == 'response.output_text.done' and hasattr(chunk, 'text'):
                return None  # Don't return final text to avoid duplication

        # Handle OpenAI Chat Completions API format
        if hasattr(chunk, 'choices') and len(chunk.choices) > 0:
            choice = chunk.choices[0]
            if hasattr(choice, 'delta') and hasattr(choice.delta, 'content'):
                return choice.delta.content
            elif hasattr(choice, 'message') and hasattr(choice.message, 'content'):
                return choice.message.content

        # Handle Anthropic format  
        if hasattr(chunk, 'delta') and hasattr(chunk.delta, 'text'):
            return chunk.delta.text
        elif hasattr(chunk, 'completion'):
            return chunk.completion

        # Handle dictionary format (common fallback)
        if isinstance(chunk, dict):
            # OpenAI-style dict
            if 'choices' in chunk and len(chunk['choices']) > 0:
                choice = chunk['choices'][0]
                if 'delta' in choice and 'content' in choice['delta']:
                    return choice['delta']['content']
                elif 'message' in choice and 'content' in choice['message']:
                    return choice['message']['content']
            
            # Direct content
            if 'content' in chunk:
                return chunk['content']
            if 'text' in chunk:
                return chunk['text']
            if 'delta' in chunk:
                return chunk['delta']

        # Handle string format
        if isinstance(chunk, str):
            return chunk

        return None

    except Exception as e:
        logger.debug(f"Error extracting text from chunk: {e}")
        return None


async def process_sync_stream_in_thread(streaming_response, extract_func) -> AsyncGenerator[str, None]:
    """
    Convert sync streaming response to async using queue-based chunk streaming.
    Prevents blocking the event loop when providers return sync iterators.
    """
    # Create a thread-safe queue for streaming chunks
    chunk_queue = queue.Queue()
    
    def consume_sync_stream():
        """Consume sync stream and put chunks in queue one by one."""
        try:
            for chunk in streaming_response:
                content_text = extract_func(chunk)
                if content_text:
                    chunk_queue.put(content_text)
            # Signal completion
            chunk_queue.put(None)
        except Exception as e:
            # Signal error
            chunk_queue.put(Exception(f"Sync stream error: {e}"))
    
    # Start the sync stream consumer in a thread
    thread = threading.Thread(target=consume_sync_stream)
    thread.daemon = True
    thread.start()
    
    # Yield chunks as they become available
    while True:
        try:
            # Wait for next chunk (non-blocking async)
            loop = asyncio.get_event_loop()
            chunk = await loop.run_in_executor(None, chunk_queue.get, True, 1.0)  # 1 sec timeout
            
            if chunk is None:
                # Stream completed
                break
            elif isinstance(chunk, Exception):
                # Stream error
                raise chunk
            else:
                # Yield the chunk immediately
                yield chunk
        except queue.Empty:
            # Timeout - continue waiting
            continue


def create_openai_streaming_chunk(
    content: str, 
    provider: str, 
    model: str, 
    chunk_id: str = "chatcmpl-123",
    finish_reason: Optional[str] = None
) -> str:
    """
    Create OpenAI-compatible streaming chunk for Direct API.
    Returns format expected by OpenAI SDK clients.
    """
    chunk_data = {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(asyncio.get_event_loop().time()),
        "model": f"{provider}/{model}",
        "choices": [
            {
                "index": 0,
                "delta": {"content": content} if content else {},
                "finish_reason": finish_reason
            }
        ]
    }
    
    return f"data: {json.dumps(chunk_data)}\n\n"


def create_content_chunk(content: str, provider: str, model: str, chunk_type: str) -> str:
    """
    Create content chunk for Web API streaming.
    Returns formatted chunk for real-time frontend updates.
    """
    chunk_data = {
        "content": content,
        "provider": provider,
        "model": model,
        "type": chunk_type
    }
    return f"data: {json.dumps(chunk_data)}\n\n"


def create_status_chunk(stage: str, message: str, status: str) -> str:
    """
    Create privacy status update chunk for Web API streaming.
    Used to show real-time privacy processing updates in the UI.
    """
    status_data = {
        "type": "privacy_status",
        "stage": stage,
        "message": message,
        "status": status
    }
    return f"data: {json.dumps(status_data)}\n\n"