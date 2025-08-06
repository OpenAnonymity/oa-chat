"""
Together AI provider implementation.
"""

from together import Together
from loguru import logger

from .base import BaseProvider
from .enums import Provider


class TogetherProvider(BaseProvider):
    """Together AI LLM provider implementation."""
    
    def __init__(self, model_tag: str, api_key: str):
        """
        Initialize a Together.ai provider.
        
        Args:
            model_tag: Together.ai-specific model identifier (e.g. "meta-llama/Llama-3-70b-chat")
            api_key: Together.ai API key
        """
        super().__init__(Provider.TOGETHER, model_tag, api_key)

    def get_provider_name(self) -> str:
        return Provider.TOGETHER.value
    
    def send_message(self, message: str):
        logger.debug(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send message")
        
        client = Together(api_key=self._get_api_key())
        
        messages = [{"role": "user", "content": message}]
        
        response = client.chat.completions.create(
            model=self.get_model_tag(),
            messages=messages,
            stream=True,
        )
        
        logger.debug("Response stream created successfully")
        return response
    
    def send_message_non_streaming(self, message: str):
        """Send message and return complete response."""
        logger.info(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send non-streaming message")
        
        # TODO: Implement proper Together non-streaming
        logger.warning("Together non-streaming implementation needed")
        
        return {
            "id": f"msg_{self.get_provider_name()}_{self.get_model_tag()}",
            "object": "chat.completion",
            "model": self.get_model_tag(),
            "provider": self.get_provider_name(),
            "choices": [{"message": {"content": "Together non-streaming not implemented"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }


# Self-register with the provider registry (including alias)
from .registry import provider_registry
provider_registry.register("together", TogetherProvider, aliases=["together.ai"]) 