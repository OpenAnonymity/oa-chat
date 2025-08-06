"""
Base provider class for LLM providers.
"""

from abc import ABC, abstractmethod
import hashlib
import uuid
from loguru import logger

from .enums import Provider


class BaseProvider(ABC):
    """
    Abstract base class for LLM providers.
    
    This class provides the common interface that all provider implementations
    must follow for consistency across different LLM providers.
    """
    
    def __init__(self, model_provider: Provider, model_tag: str, api_key: str):
        """
        Initialize a provider with model information.

        Args:
            model_provider: Provider enum for the model (e.g. Provider.OPENAI)
            model_tag: Provider-specific identifier for the model (e.g. "gpt-4o")
            api_key: API key for the provider
        """
        self._model_provider = model_provider
        self._model_tag = model_tag
        self._api_key = api_key
        self._uuid = str(uuid.uuid4())
        logger.info(f"Initialized {self._model_provider.value} provider with model {self._model_tag} (ID: {self._uuid})")

    @abstractmethod
    def send_message(self, message: str):
        pass

    # this is not yet used
    @abstractmethod
    def send_message_non_streaming(self, message: str):
        pass

    def get_api_key(self) -> str:
        """Get the API key for this provider."""
        return self._api_key

    def get_uuid(self) -> str:
        """Get the unique identifier for this provider instance."""
        return self._uuid

    def get_provider(self) -> str:
        """Get the provider name."""
        return self._model_provider.value

    def get_model_tag(self) -> str:
        """Get the model tag."""
        return self._model_tag

    def _get_api_key(self) -> str:
        """Get the API key (for compatibility with original endpoint interface)."""
        return self._api_key

    def summary(self) -> str:
        """Get a summary string for this provider."""
        api_key_hash = hashlib.sha256(self._api_key.encode()).hexdigest()[:8]
        return f"{self.get_provider()}/{self.get_model_tag()} ({api_key_hash})" 