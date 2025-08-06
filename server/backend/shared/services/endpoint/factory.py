"""
Factory for creating provider instances based on provider names.
Uses the provider registry for dynamic provider management.
"""

from typing import Optional
from loguru import logger

from ...providers.base import BaseProvider
from ...providers.registry import get_provider_registry


class EndpointFactory:
    """
    Factory class for creating provider instances using the provider registry.
    
    This factory dynamically discovers providers through the registry system,
    eliminating hardcoded provider mappings.
    """
    
    def __init__(self):
        """Initialize the factory with the provider registry."""
        self._registry = get_provider_registry()
        
        # Ensure all providers are registered by importing them
        # This triggers the self-registration code at the bottom of each provider file
        self._ensure_providers_loaded()
    
    def _ensure_providers_loaded(self) -> None:
        """Ensure all provider modules are loaded to trigger self-registration."""
        try:
            # Import all provider modules to trigger self-registration
            from ...providers import openai, anthropic, deepseek, together, xai, google
            logger.debug("All provider modules loaded and registered")
        except ImportError as e:
            logger.warning(f"Some provider modules could not be loaded: {e}")
    

    
    def create_endpoint(self, provider: str, model_tag: str, api_key: str) -> Optional[BaseProvider]:
        """
        Create a provider instance for the specified provider and model.
        
        Args:
            provider: Provider name (e.g., "openai", "anthropic")
            model_tag: Model API identifier (e.g., "gpt-4o", "claude-3-opus-20240229")
            api_key: API key for the provider
            
        Returns:
            Provider instance or None if not available
        """
        provider_class = self._registry.get_provider_class(provider)
        
        if not provider_class:
            logger.error(f"Unsupported provider: {provider}. Available providers: {self._registry.list_providers()}")
            return None
        
        try:
            # Create provider instance
            provider_instance = provider_class(model_tag, api_key)
            logger.info(f"Created {provider} provider for model: {model_tag}")
            return provider_instance
            
        except Exception as e:
            logger.error(f"Failed to create {provider} provider: {str(e)}")
            return None
    

    
    def get_supported_providers(self) -> list[str]:
        """
        Get list of supported provider names.
        
        Returns:
            List of supported provider names including aliases
        """
        providers = self._registry.list_providers()
        aliases = list(self._registry.list_aliases().keys())
        return sorted(providers + aliases)
    

    
    def is_provider_supported(self, provider: str) -> bool:
        """Check if a provider is supported."""
        return self._registry.is_provider_registered(provider)
    

    
    @classmethod
    def convert_response_to_standard_format(cls, raw_response, provider: str, model_tag: str) -> dict:
        """
        Convert a response to standard format.
        
        Args:
            raw_response: Raw response from provider
            provider: Provider name
            model_tag: Model API tag
            
        Returns:
            Standardized response dictionary
        """
        logger.debug(f"Converting response for {provider}:{model_tag}")
        
        try:
            # If response is already in dictionary format, return as-is
            if isinstance(raw_response, dict):
                # Ensure required fields are present
                if "provider" not in raw_response:
                    raw_response["provider"] = provider
                if "model" not in raw_response:
                    raw_response["model"] = model_tag
                    
                return raw_response
            
            # Handle other response types
            standard_response = {
                "id": f"msg_{provider}_{model_tag}",
                "object": "chat.completion",
                "created": int(__import__("time").time()),
                "model": model_tag,
                "provider": provider,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": str(raw_response) if raw_response else "No response"
                        },
                        "finish_reason": "stop"
                    }
                ],
                "usage": {
                    "prompt_tokens": 0,
                    "completion_tokens": 0,
                    "total_tokens": 0
                }
            }
            
            return standard_response
            
        except Exception as e:
            logger.error(f"Error converting response: {str(e)}")
            return cls._create_error_response(f"Response conversion failed: {str(e)}", provider, model_tag)
    
    @classmethod
    def _create_error_response(cls, error_message: str, provider: str = "unknown", model: str = "unknown") -> dict:
        """Create a standardized error response."""
        return {
            "id": "error_response",
            "object": "error",
            "created": int(__import__("time").time()),
            "model": model,
            "provider": provider,
            "error": {
                "message": error_message,
                "type": "api_error"
            },
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": f"Error: {error_message}"
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