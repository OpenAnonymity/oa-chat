"""
Anthropic provider implementation.
"""

from anthropic import Anthropic
from loguru import logger

from .base import BaseProvider
from .enums import Provider


class AnthropicProvider(BaseProvider):
    """Anthropic Claude LLM provider implementation."""
    
    def __init__(self, model_tag: str, api_key: str):
        """
        Initialize an Anthropic provider.
        
        Args:
            model_tag: Anthropic-specific model identifier (e.g. "claude-3-opus-20240229")
            api_key: Anthropic API key
        """
        super().__init__(Provider.ANTHROPIC, model_tag, api_key)
    
    def get_provider_name(self) -> str:
        return Provider.ANTHROPIC.value
    
    def send_message(self, message: str):
        logger.debug(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send message")
        
        client = Anthropic(api_key=self._get_api_key())
        
        with client.messages.stream(
            model=self.get_model_tag(),
            messages=[
                {"role": "user", "content": message}
            ],
            max_tokens=1024,
        ) as stream:
            logger.debug("Response stream created successfully")
            return list(stream)
    
    async def send_message_non_streaming(self, message: str):
        """Send message and return complete response."""
        logger.info(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send non-streaming message")
        
        try:
            client = Anthropic(api_key=self._get_api_key())
            response = client.messages.create(
                model=self.get_model_tag(),
                messages=[{"role": "user", "content": message}],
                max_tokens=1024,
            )
            
            logger.debug("Non-streaming response received successfully")
            
            # Convert to standard format
            return {
                "id": f"msg_{self.get_provider_name()}_{self.get_model_tag()}",
                "object": "chat.completion",
                "created": int(__import__("time").time()),
                "model": self.get_model_tag(),
                "provider": self.get_provider_name(),
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": response.content[0].text if response.content else "No response"
                        },
                        "finish_reason": "stop"
                    }
                ],
                "usage": {
                    "prompt_tokens": response.usage.input_tokens if hasattr(response, 'usage') else 0,
                    "completion_tokens": response.usage.output_tokens if hasattr(response, 'usage') else 0,
                    "total_tokens": (response.usage.input_tokens + response.usage.output_tokens) if hasattr(response, 'usage') else 0
                }
            }
            
        except Exception as e:
            logger.error(f"Anthropic non-streaming API error: {str(e)}")
            return {
                "error": str(e),
                "provider": self.get_provider_name(),
                "model": self.get_model_tag()
            }


# Self-register with the provider registry
from .registry import provider_registry
provider_registry.register("anthropic", AnthropicProvider) 