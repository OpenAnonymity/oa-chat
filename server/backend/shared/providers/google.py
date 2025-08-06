"""
Google provider implementation.
"""

from google import genai
from loguru import logger

from .base import BaseProvider
from .enums import Provider


class GoogleProvider(BaseProvider):
    """Google AI LLM provider implementation."""
    
    def __init__(self, model_tag: str, api_key: str):
        """
        Initialize a Google provider.
        
        Args:
            model_tag: Google-specific model identifier (e.g. "gemini-pro")
            api_key: Google API key
        """
        super().__init__(Provider.GOOGLE, model_tag, api_key)

    def get_provider_name(self) -> str:
        return Provider.GOOGLE.value
    
    def send_message(self, message: str):
        logger.debug(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send message")
        
        # Create a Google client with the API key
        client = genai.Client(api_key=self._get_api_key())
        
        # Generate content using the model tag
        response = client.models.generate_content(
            model=self.get_model_tag(),
            contents=message,
            # stream=True
        )
        
        logger.debug("Response generated successfully")
        return response

    async def send_message_non_streaming(self, message: str):
        """Send message and return complete response."""
        logger.info(f"Using {self.get_provider_name()} - {self.get_model_tag()} endpoint to send non-streaming message")
        
        # TODO: Implement proper Google non-streaming
        logger.warning("Google non-streaming implementation needed")
        
        return {
            "id": f"msg_{self.get_provider_name()}_{self.get_model_tag()}",
            "object": "chat.completion",
            "model": self.get_model_tag(),
            "provider": self.get_provider_name(),
            "choices": [{"message": {"content": "Google non-streaming not implemented"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        }


# Self-register with the provider registry
from .registry import provider_registry
provider_registry.register("google", GoogleProvider) 