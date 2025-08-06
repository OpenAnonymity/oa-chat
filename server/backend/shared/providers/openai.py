"""
OpenAI provider implementation.
"""

from openai import OpenAI
from loguru import logger

from .base import BaseProvider
from .enums import Provider


class OpenAIProvider(BaseProvider):
    """OpenAI LLM provider implementation."""
    
    def __init__(self, model_tag: str, api_key: str):
        """
        Initialize an OpenAI provider.
        
        Args:
            model_tag: OpenAI-specific model identifier (e.g. "gpt-4o-20250331")
            api_key: OpenAI API key
        """
        super().__init__(Provider.OPENAI, model_tag, api_key)

    def get_provider_name(self) -> str:
        return Provider.OPENAI.value
    
    def send_message(self, message: str):
        logger.debug(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send message")
        
        client = OpenAI(api_key=self.get_api_key())
        response = client.responses.create(
            model=self.get_model_tag(),
            instructions="You are a helpful assistant.",
            input=message,
            stream=True,
            store=False,     #  Disable the API logging
        )
        
        logger.debug("Response stream created successfully")
        return response
    
    async def send_message_non_streaming(self, message: str):
        """Send message and return complete response using client.responses API."""
        logger.info(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send non-streaming message")
        
        try:
            client = OpenAI(api_key=self.get_api_key())
            response = client.responses.create(
                model=self.get_model_tag(),
                instructions="You are a helpful assistant.",
                input=message,
                stream=False,  # Non-streaming
                store=False,   # Disable API logging
            )
            
            logger.debug("Non-streaming response received successfully")
            
            # Convert to standard format (matching chat completions structure)
            return {
                "id": getattr(response, 'id', f"resp_{int(__import__('time').time())}"),
                "object": "chat.completion", 
                "created": getattr(response, 'created', int(__import__('time').time())),
                "model": self.get_model_tag(),
                "provider": self.get_provider_name(),
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant", 
                            "content": getattr(response, 'content', str(response))
                        },
                        "finish_reason": "stop"
                    }
                ],
                "usage": {
                    "prompt_tokens": getattr(response.usage, 'prompt_tokens', 0) if hasattr(response, 'usage') and response.usage else 0,
                    "completion_tokens": getattr(response.usage, 'completion_tokens', 0) if hasattr(response, 'usage') and response.usage else 0,
                    "total_tokens": getattr(response.usage, 'total_tokens', 0) if hasattr(response, 'usage') and response.usage else 0
                }
            }
            
        except Exception as e:
            logger.error(f"OpenAI non-streaming API error: {str(e)}")
            # Return error in standard format
            return {
                "id": "error_response",
                "object": "error",
                "created": int(__import__("time").time()),
                "model": self.get_model_tag(),
                "provider": self.get_provider_name(),
                "error": {
                    "message": str(e),
                    "type": "api_error"
                },
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": f"Error: {str(e)}"
                        },
                        "finish_reason": "error"
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0
                }
            }


# Self-register with the provider registry
from .registry import provider_registry
provider_registry.register("openai", OpenAIProvider) 