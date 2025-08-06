"""
Provider Registry - Dynamic provider management system.
Replaces hardcoded provider mappings with a flexible registry pattern.
"""

from typing import Dict, Type, Optional, List
from loguru import logger

from .base import BaseProvider


class ProviderRegistry:
    """
    Registry for dynamically managing provider implementations.
    
    This replaces the hardcoded provider mappings in EndpointFactory
    and allows for more flexible provider management.
    """
    
    def __init__(self):
        self._providers: Dict[str, Type[BaseProvider]] = {}
        self._aliases: Dict[str, str] = {}  # For provider name aliases
        logger.info("ProviderRegistry initialized")
    
    def register(self, name: str, provider_class: Type[BaseProvider], aliases: Optional[List[str]] = None) -> None:
        """
        Register a provider implementation.
        
        Args:
            name: Primary name for the provider (e.g., "openai")
            provider_class: Provider class implementing BaseProvider
            aliases: Optional list of alternative names (e.g., ["openai", "openai-api"])
        
        Raises:
            ValueError: If provider_class is not a BaseProvider subclass
        """
        if not issubclass(provider_class, BaseProvider):
            raise ValueError(f"Provider class {provider_class.__name__} must inherit from BaseProvider")
        
        name_lower = name.lower()
        
        # Check for name conflicts
        if name_lower in self._providers:
            logger.warning(f"Provider '{name}' already registered, overwriting with {provider_class.__name__}")
        
        # Register the primary name
        self._providers[name_lower] = provider_class
        logger.info(f"Registered provider: {name} -> {provider_class.__name__}")
        
        # Register aliases if provided
        if aliases:
            for alias in aliases:
                alias_lower = alias.lower()
                if alias_lower in self._aliases:
                    logger.warning(f"Alias '{alias}' already exists, overwriting")
                self._aliases[alias_lower] = name_lower
                logger.debug(f"Registered alias: {alias} -> {name}")
    
    def get_provider_class(self, name: str) -> Optional[Type[BaseProvider]]:
        """
        Get provider class by name or alias.
        
        Args:
            name: Provider name or alias
            
        Returns:
            Provider class if found, None otherwise
        """
        name_lower = name.lower()
        
        # Check direct registration first
        if name_lower in self._providers:
            return self._providers[name_lower]
        
        # Check aliases
        if name_lower in self._aliases:
            primary_name = self._aliases[name_lower]
            return self._providers.get(primary_name)
        
        return None
    
    def is_provider_registered(self, name: str) -> bool:
        """
        Check if a provider is registered.
        
        Args:
            name: Provider name or alias
            
        Returns:
            True if provider is registered, False otherwise
        """
        return self.get_provider_class(name) is not None
    
    def list_providers(self) -> List[str]:
        """
        List all registered provider names.
        
        Returns:
            List of primary provider names
        """
        return list(self._providers.keys())
    
    def list_aliases(self) -> Dict[str, str]:
        """
        List all registered aliases and their primary names.
        
        Returns:
            Dictionary mapping aliases to primary names
        """
        return self._aliases.copy()
    
    def unregister(self, name: str) -> bool:
        """
        Unregister a provider.
        
        Args:
            name: Provider name to unregister
            
        Returns:
            True if provider was unregistered, False if not found
        """
        name_lower = name.lower()
        
        if name_lower in self._providers:
            del self._providers[name_lower]
            
            # Remove any aliases pointing to this provider
            aliases_to_remove = [alias for alias, primary in self._aliases.items() if primary == name_lower]
            for alias in aliases_to_remove:
                del self._aliases[alias]
            
            logger.info(f"Unregistered provider: {name}")
            return True
        
        return False
    
    def get_provider_info(self, name: str) -> Optional[Dict[str, str]]:
        """
        Get information about a provider.
        
        Args:
            name: Provider name or alias
            
        Returns:
            Dictionary with provider information or None if not found
        """
        provider_class = self.get_provider_class(name)
        if not provider_class:
            return None
        
        name_lower = name.lower()
        
        # Find the primary name
        primary_name = name_lower if name_lower in self._providers else self._aliases.get(name_lower)
        
        # Find aliases for this provider
        provider_aliases = [alias for alias, primary in self._aliases.items() if primary == primary_name]
        
        return {
            "primary_name": primary_name,
            "class_name": provider_class.__name__,
            "module": provider_class.__module__,
            "aliases": provider_aliases
        }
    
    def clear(self) -> None:
        """Clear all registered providers and aliases."""
        self._providers.clear()
        self._aliases.clear()
        logger.info("ProviderRegistry cleared")


# Global registry instance
provider_registry = ProviderRegistry()


def get_provider_registry() -> ProviderRegistry:
    """
    Get the global provider registry instance.
    
    Returns:
        Global ProviderRegistry instance
    """
    return provider_registry 