"""
Utility functions for the web server.
"""

from typing import List, Tuple, Dict
import re


def parse_model_string(model_string: str) -> Tuple[str, str]:
    """
    Parse "provider/model" string format.
    
    Args:
        model_string: String in format "provider/model"
        
    Returns:
        Tuple of (provider, model)
        
    Raises:
        ValueError: If format is invalid
    """
    if not model_string or '/' not in model_string:
        raise ValueError(f"Invalid model string format: {model_string}. Expected 'provider/model'")
    
    parts = model_string.split('/', 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError(f"Invalid model string format: {model_string}. Expected 'provider/model'")
    
    return parts[0].strip(), parts[1].strip()


def format_model_string(provider: str, model: str) -> str:
    """
    Format provider and model into "provider/model" string.
    
    Args:
        provider: Provider name
        model: Model name
        
    Returns:
        Formatted string "provider/model"
    """
    if not provider or not model:
        raise ValueError("Provider and model cannot be empty")
    
    return f"{provider}/{model}"


def parse_model_list(model_strings: List[str]) -> List[Dict[str, str]]:
    """
    Parse list of "provider/model" strings into list of dictionaries.
    
    Args:
        model_strings: List of strings in format "provider/model"
        
    Returns:
        List of {"provider": str, "model": str} dictionaries
    """
    result = []
    for model_string in model_strings:
        provider, model = parse_model_string(model_string)
        result.append({"provider": provider, "model": model})
    
    return result


def format_model_list(model_dicts: List[Dict[str, str]]) -> List[str]:
    """
    Format list of model dictionaries into "provider/model" strings.
    
    Args:
        model_dicts: List of {"provider": str, "model": str} dictionaries
        
    Returns:
        List of "provider/model" strings
    """
    result = []
    for model_dict in model_dicts:
        provider = model_dict.get("provider")
        model = model_dict.get("model")
        if provider and model:
            result.append(format_model_string(provider, model))
    
    return result


def validate_model_string(model_string: str) -> bool:
    """
    Validate if string is in correct "provider/model" format.
    
    Args:
        model_string: String to validate
        
    Returns:
        True if valid, False otherwise
    """
    try:
        parse_model_string(model_string)
        return True
    except ValueError:
        return False 