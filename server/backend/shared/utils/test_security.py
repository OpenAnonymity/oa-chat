"""
Simple tests to verify security validation is working correctly.
Run with: python -m pytest server/backend/shared/utils/test_security.py -v
"""

import pytest
from .security import (
    SecurityValidationError,
    validate_and_sanitize_html,
    validate_and_escape_text,
    validate_session_id,
    validate_endpoint_id,
    validate_user_id,
    validate_email,
    validate_url,
    validate_model_string,
    validate_openai_message,
    validate_messages_array,
    sanitize_prompt_for_logging
)


class TestSecurityValidation:
    """Test suite for security validation functions."""
    
    def test_html_sanitization(self):
        """Test HTML sanitization removes dangerous content."""
        # Test XSS attempts are blocked
        dangerous_html = '<script>alert("xss")</script><p>Safe content</p>'
        sanitized = validate_and_sanitize_html(dangerous_html)
        assert '<script>' not in sanitized
        assert 'Safe content' in sanitized
        
        # Test allowed tags are preserved
        safe_html = '<p>Hello <strong>world</strong></p>'
        sanitized = validate_and_sanitize_html(safe_html)
        assert '<p>' in sanitized
        assert '<strong>' in sanitized
    
    def test_text_escaping(self):
        """Test text escaping prevents HTML injection."""
        dangerous_text = '<script>alert("xss")</script>'
        escaped = validate_and_escape_text(dangerous_text)
        assert '&lt;script&gt;' in escaped
        assert '<script>' not in escaped
    
    def test_session_id_validation(self):
        """Test session ID validation."""
        # Valid session IDs
        assert validate_session_id("session_123") == "session_123"
        assert validate_session_id("abc-def-123") == "abc-def-123"
        
        # Invalid session IDs
        with pytest.raises(SecurityValidationError):
            validate_session_id("")  # Empty
        
        with pytest.raises(SecurityValidationError):
            validate_session_id("a" * 100)  # Too long
        
        with pytest.raises(SecurityValidationError):
            validate_session_id("session with spaces")  # Invalid chars
    
    def test_user_id_validation(self):
        """Test user ID validation."""
        # Valid user IDs
        assert validate_user_id(123) == 123
        assert validate_user_id(999999999) == 999999999
        
        # Invalid user IDs
        with pytest.raises(SecurityValidationError):
            validate_user_id(0)  # Too low
        
        with pytest.raises(SecurityValidationError):
            validate_user_id(1000000000)  # Too high
    
    def test_email_validation(self):
        """Test email validation."""
        # Valid emails
        assert validate_email("test@example.com") == "test@example.com"
        assert validate_email("  TEST@EXAMPLE.COM  ") == "test@example.com"
        
        # Invalid emails
        with pytest.raises(SecurityValidationError):
            validate_email("not-an-email")
        
        with pytest.raises(SecurityValidationError):
            validate_email("")
    
    def test_url_validation(self):
        """Test URL validation."""
        # Valid URLs
        assert validate_url("https://example.com") == "https://example.com"
        assert validate_url("http://api.example.com/path") == "http://api.example.com/path"
        
        # Invalid URLs
        with pytest.raises(SecurityValidationError):
            validate_url("not-a-url")
        
        with pytest.raises(SecurityValidationError):
            validate_url("http://localhost", public=True)  # Private URL with public=True
    
    def test_model_string_validation(self):
        """Test model string validation."""
        # Valid model strings
        provider, model = validate_model_string("openai/gpt-4")
        assert provider == "openai"
        assert model == "gpt-4"
        
        provider, model = validate_model_string("anthropic/claude-3-haiku")
        assert provider == "anthropic"
        assert model == "claude-3-haiku"
        
        # Invalid model strings
        with pytest.raises(SecurityValidationError):
            validate_model_string("")  # Empty
        
        with pytest.raises(SecurityValidationError):
            validate_model_string("no-slash")  # No slash
        
        with pytest.raises(SecurityValidationError):
            validate_model_string("provider/")  # Empty model
        
        with pytest.raises(SecurityValidationError):
            validate_model_string("/model")  # Empty provider
    
    def test_openai_message_validation(self):
        """Test OpenAI message validation."""
        # Valid message
        valid_msg = {"role": "user", "content": "Hello world"}
        validated = validate_openai_message(valid_msg)
        assert validated["role"] == "user"
        assert "Hello world" in validated["content"]
        
        # Message with HTML content gets escaped
        html_msg = {"role": "user", "content": "<script>alert('xss')</script>"}
        validated = validate_openai_message(html_msg)
        assert "&lt;script&gt;" in validated["content"]
        assert "<script>" not in validated["content"]
        
        # Invalid messages
        with pytest.raises(SecurityValidationError):
            validate_openai_message({})  # Missing fields
        
        with pytest.raises(SecurityValidationError):
            validate_openai_message({"role": "invalid", "content": "test"})  # Invalid role
    
    def test_messages_array_validation(self):
        """Test messages array validation."""
        # Valid messages array
        valid_messages = [
            {"role": "system", "content": "You are a helpful assistant"},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"}
        ]
        validated = validate_messages_array(valid_messages)
        assert len(validated) == 3
        assert all(msg["role"] in ["system", "user", "assistant"] for msg in validated)
        
        # Array with dangerous content gets sanitized
        dangerous_messages = [
            {"role": "user", "content": "<script>alert('xss')</script>Hello"}
        ]
        validated = validate_messages_array(dangerous_messages)
        assert "&lt;script&gt;" in validated[0]["content"]
        assert "<script>" not in validated[0]["content"]
        
        # Invalid arrays
        with pytest.raises(SecurityValidationError):
            validate_messages_array([])  # Empty array
        
        with pytest.raises(SecurityValidationError):
            validate_messages_array([{}])  # Invalid message
    
    def test_prompt_logging_sanitization(self):
        """Test prompt sanitization for logging."""
        # Test HTML escaping for logs
        dangerous_prompt = '<script>alert("xss")</script>This is a test prompt'
        sanitized = sanitize_prompt_for_logging(dangerous_prompt)
        assert "&lt;script&gt;" in sanitized
        assert "<script>" not in sanitized
        
        # Test truncation
        long_prompt = "A" * 200
        sanitized = sanitize_prompt_for_logging(long_prompt, max_length=50)
        assert len(sanitized) <= 53  # 50 + "..."
        assert sanitized.endswith("...")
        
        # Test newline removal
        multiline_prompt = "Line 1\nLine 2\rLine 3"
        sanitized = sanitize_prompt_for_logging(multiline_prompt)
        assert "\n" not in sanitized
        assert "\r" not in sanitized
        assert " Line " in sanitized  # Newlines replaced with spaces


if __name__ == "__main__":
    # Simple test runner if called directly
    test = TestSecurityValidation()
    test.test_html_sanitization()
    test.test_text_escaping()
    test.test_session_id_validation()
    test.test_user_id_validation()
    test.test_model_string_validation()
    test.test_openai_message_validation()
    test.test_messages_array_validation()
    test.test_prompt_logging_sanitization()
    print("All security validation tests passed!") 