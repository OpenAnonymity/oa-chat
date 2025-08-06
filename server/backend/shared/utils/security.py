"""
Security validation utilities using industry-standard libraries.
Replaces manual regex patterns with expert-maintained security libraries.
"""

import bleach
import validators
from markupsafe import Markup, escape
from typing import List, Dict, Any, Optional
import html
import re


# Security configuration
MAX_CONTENT_LENGTH = 50000  # 50KB max content
MAX_SESSION_ID_LENGTH = 64
MAX_ENDPOINT_ID_LENGTH = 64
MAX_USER_ID = 999999999  # 9-digit max
MIN_USER_ID = 1

# Allowed HTML tags for content that may contain markup
ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'u', 'code', 'pre', 'blockquote']
ALLOWED_ATTRIBUTES = {
    '*': ['class'],
    'code': ['class']
}

# Safe patterns for IDs (alphanumeric, underscore, dash only)
SAFE_ID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]+$')


class SecurityValidationError(ValueError):
    """Raised when security validation fails."""
    pass


def validate_and_sanitize_html(content: str, field_name: str = "content") -> str:
    """
    Validate and sanitize HTML content using bleach (industry standard).
    
    Args:
        content: The HTML content to validate and sanitize
        field_name: Name of the field for error messages
        
    Returns:
        Sanitized HTML content
        
    Raises:
        SecurityValidationError: If content is too long or contains dangerous elements
    """
    if not content:
        return content
    
    # Check length
    if len(content) > MAX_CONTENT_LENGTH:
        raise SecurityValidationError(f"{field_name} too long (max {MAX_CONTENT_LENGTH} characters)")
    
    # Use bleach to clean HTML - removes all dangerous elements
    cleaned_content = bleach.clean(
        content,
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRIBUTES,
        strip=True,  # Strip disallowed tags instead of escaping
        strip_comments=True
    )
    
    return cleaned_content


def validate_and_escape_text(content: str, field_name: str = "content") -> str:
    """
    Validate and escape plain text content.
    
    Args:
        content: The text content to validate and escape
        field_name: Name of the field for error messages
        
    Returns:
        HTML-escaped text content
        
    Raises:
        SecurityValidationError: If content is too long
    """
    if not content:
        return content
    
    # Check length
    if len(content) > MAX_CONTENT_LENGTH:
        raise SecurityValidationError(f"{field_name} too long (max {MAX_CONTENT_LENGTH} characters)")
    
    # Use markupsafe for proper HTML escaping
    return str(escape(content))


def validate_session_id(session_id: str) -> str:
    """
    Validate session ID format and security using safe patterns.
    
    Args:
        session_id: The session ID to validate
        
    Returns:
        The validated session ID
        
    Raises:
        SecurityValidationError: If session ID is invalid
    """
    if not session_id:
        raise SecurityValidationError("Session ID cannot be empty")
    
    if len(session_id) > MAX_SESSION_ID_LENGTH:
        raise SecurityValidationError(f"Session ID too long (max {MAX_SESSION_ID_LENGTH} characters)")
    
    if not SAFE_ID_PATTERN.match(session_id):
        raise SecurityValidationError("Session ID contains invalid characters (only alphanumeric, underscore, and dash allowed)")
    
    return session_id


def validate_endpoint_id(endpoint_id: str) -> str:
    """
    Validate endpoint ID format using safe patterns.
    
    Args:
        endpoint_id: The endpoint ID to validate
        
    Returns:
        The validated endpoint ID
        
    Raises:
        SecurityValidationError: If endpoint ID is invalid
    """
    if not endpoint_id:
        raise SecurityValidationError("Endpoint ID cannot be empty")
    
    if len(endpoint_id) > MAX_ENDPOINT_ID_LENGTH:
        raise SecurityValidationError(f"Endpoint ID too long (max {MAX_ENDPOINT_ID_LENGTH} characters)")
    
    if not SAFE_ID_PATTERN.match(endpoint_id):
        raise SecurityValidationError("Endpoint ID contains invalid characters (only alphanumeric, underscore, and dash allowed)")
    
    return endpoint_id


def validate_user_id(user_id: int) -> int:
    """
    Validate user ID range.
    
    Args:
        user_id: The user ID to validate
        
    Returns:
        The validated user ID
        
    Raises:
        SecurityValidationError: If user ID is out of range
    """
    if user_id < MIN_USER_ID or user_id > MAX_USER_ID:
        raise SecurityValidationError(f"User ID must be between {MIN_USER_ID} and {MAX_USER_ID}")
    
    return user_id


def validate_email(email: str) -> str:
    """
    Validate email format using the validators library.
    
    Args:
        email: The email to validate
        
    Returns:
        The validated email
        
    Raises:
        SecurityValidationError: If email format is invalid
    """
    if not email:
        raise SecurityValidationError("Email cannot be empty")
    
    if not validators.email(email):
        raise SecurityValidationError("Invalid email format")
    
    return email.lower().strip()


def validate_url(url: str, public: bool = True) -> str:
    """
    Validate URL format using the validators library.
    
    Args:
        url: The URL to validate
        public: If True, only allow public URLs (no localhost, private IPs)
        
    Returns:
        The validated URL
        
    Raises:
        SecurityValidationError: If URL format is invalid or not public
    """
    if not url:
        raise SecurityValidationError("URL cannot be empty")
    
    if not validators.url(url, public=public):
        raise SecurityValidationError("Invalid URL format" + (" or private/local URL" if public else ""))
    
    return url.strip()


def validate_model_string(model_string: str) -> tuple[str, str]:
    """
    Validate and parse model string in 'provider/model' format.
    
    Args:
        model_string: The model string to validate
        
    Returns:
        Tuple of (provider, model)
        
    Raises:
        SecurityValidationError: If model string format is invalid
    """
    if not model_string:
        raise SecurityValidationError("Model string cannot be empty")
    
    if len(model_string) > 100:  # Reasonable limit
        raise SecurityValidationError("Model string too long (max 100 characters)")
    
    if '/' not in model_string:
        raise SecurityValidationError("Invalid model format. Expected 'provider/model'")
    
    parts = model_string.split('/', 1)
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        raise SecurityValidationError("Invalid model format. Expected 'provider/model'")
    
    provider = parts[0].strip()
    model = parts[1].strip()
    
    # Validate provider and model contain only safe characters
    if not re.match(r'^[a-zA-Z0-9._-]+$', provider):
        raise SecurityValidationError("Provider name contains invalid characters")
    
    if not re.match(r'^[a-zA-Z0-9._-]+$', model):
        raise SecurityValidationError("Model name contains invalid characters")
    
    return provider, model


def validate_openai_message(message: Dict[str, Any], index: int = 0) -> Dict[str, Any]:
    """
    Validate OpenAI-format message with security checks.
    
    Args:
        message: The message dictionary to validate
        index: Index of the message for error reporting
        
    Returns:
        Validated and sanitized message
        
    Raises:
        SecurityValidationError: If message format is invalid or contains dangerous content
    """
    if not isinstance(message, dict):
        raise SecurityValidationError(f"Message {index} must be a dictionary")
    
    if 'role' not in message or 'content' not in message:
        raise SecurityValidationError(f"Message {index} must have 'role' and 'content' fields")
    
    role = message['role']
    if role not in ['system', 'user', 'assistant']:
        raise SecurityValidationError(f"Message {index} has invalid role: {role}. Must be 'system', 'user', or 'assistant'")
    
    # Validate and sanitize content
    content = message.get('content', '')
    if isinstance(content, str):
        # For LLM messages, we want to preserve the content but escape any HTML
        sanitized_content = validate_and_escape_text(content, f"Message {index} content")
    else:
        raise SecurityValidationError(f"Message {index} content must be a string")
    
    return {
        'role': role,
        'content': sanitized_content,
        **{k: v for k, v in message.items() if k not in ['role', 'content']}
    }


def validate_messages_array(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Validate an array of OpenAI-format messages.
    
    Args:
        messages: List of message dictionaries to validate
        
    Returns:
        List of validated and sanitized messages
        
    Raises:
        SecurityValidationError: If any message is invalid
    """
    if not messages:
        raise SecurityValidationError("Messages array cannot be empty")
    
    if len(messages) > 100:  # Reasonable limit
        raise SecurityValidationError("Too many messages (max 100)")
    
    validated_messages = []
    for i, message in enumerate(messages):
        validated_message = validate_openai_message(message, i)
        validated_messages.append(validated_message)
    
    return validated_messages


def sanitize_prompt_for_logging(prompt: str, max_length: int = 100) -> str:
    """
    Sanitize a prompt for safe logging (remove sensitive info, truncate).
    
    Args:
        prompt: The prompt to sanitize
        max_length: Maximum length for logging
        
    Returns:
        Sanitized prompt safe for logging
    """
    if not prompt:
        return ""
    
    # Escape HTML and remove newlines for logging
    sanitized = html.escape(prompt).replace('\n', ' ').replace('\r', ' ')
    
    # Truncate for logging
    if len(sanitized) > max_length:
        sanitized = sanitized[:max_length] + "..."
    
    return sanitized 