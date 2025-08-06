"""
Validation utilities.
"""

from typing import Tuple, Optional, Dict, List


def validate_model_format(model: str) -> Tuple[bool, Optional[str]]:
    """
    Validate model format (provider/model).
    
    Args:
        model: Model string to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not model or not isinstance(model, str):
        return False, "Model must be a non-empty string"
    
    if '/' not in model:
        return False, "Model must be in format 'provider/model'"
    
    parts = model.split('/', 1)
    if len(parts) != 2:
        return False, "Model must contain exactly one '/'"
    
    provider, model_name = parts
    if not provider or not model_name:
        return False, "Both provider and model must be non-empty"
    
    return True, None


def validate_provider_model(
    provider: str,
    model: str,
    provider_config: Dict[str, List[str]]
) -> Tuple[bool, Optional[str]]:
    """
    Validate if a provider/model combination is supported.
    
    Args:
        provider: Provider name
        model: Model name
        provider_config: Configuration mapping providers to their models
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if provider not in provider_config:
        return False, f"Unknown provider: {provider}"
    
    if model not in provider_config[provider]:
        return False, f"Model {model} not supported by provider {provider}"
    
    return True, None


def parse_model_string(model: str) -> Tuple[str, str]:
    """
    Parse a model string into provider and model components.
    
    Args:
        model: Model string in format "provider/model"
        
    Returns:
        Tuple of (provider, model)
        
    Raises:
        ValueError: If model format is invalid
    """
    is_valid, error = validate_model_format(model)
    if not is_valid:
        raise ValueError(error)
    
    provider, model_name = model.split('/', 1)
    return provider, model_name 