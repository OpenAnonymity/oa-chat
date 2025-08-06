"""
XAI provider implementation.
"""

from openai import OpenAI  # XAI typically uses an OpenAI-compatible API
from loguru import logger

from .base import BaseProvider
from .enums import Provider


class XAIProvider(BaseProvider):
    """XAI (Grok) LLM provider implementation (OpenAI-compatible API)."""
    
    def __init__(self, model_tag: str, api_key: str, api_base: str = "https://api.x.ai/v1"):
        """
        Initialize an XAI provider.
        
        Args:
            model_tag: XAI-specific model identifier (e.g. "grok-1")
            api_key: XAI API key
            api_base: XAI API base URL
        """
        super().__init__(Provider.XAI, model_tag, api_key)
        self._api_base = api_base
    
    def get_provider_name(self) -> str:
        return Provider.XAI.value
    
    def send_message(self, message: str):
        logger.debug(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send message")
        
        # XAI typically uses an OpenAI-compatible API
        client = OpenAI(api_key=self._get_api_key(), base_url=self._api_base)

        response = client.chat.completions.create(
            model=self.get_model_tag(),
            messages=[
                {"role": "user", "content": message}
            ],
            stream=True
        )

        logger.debug("Response stream created successfully")
        return response
    
    async def send_message_non_streaming(self, message: str):
        """Send message and return complete response."""
        logger.info(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send non-streaming message")
        
        # TODO: Implement proper XAI non-streaming
        logger.warning("XAI non-streaming implementation needed")
        
        return {
            "id": f"msg_{self.get_provider_name()}_{self.get_model_tag()}",
            "object": "chat.completion",
            "model": self.get_model_tag(),
            "provider": self.get_provider_name(),
            "choices": [{"message": {"content": "XAI non-streaming not implemented"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }


# Self-register with the provider registry
from .registry import provider_registry
provider_registry.register("xai", XAIProvider) 