"""
Request models for API endpoints.
"""

from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field, validator

# Import industry-standard security validation
from ..utils.security import (
    SecurityValidationError,
    validate_session_id,
    validate_endpoint_id, 
    validate_user_id,
    validate_and_escape_text,
    validate_model_string,
    validate_messages_array
)


class InitializeSessionRequest(BaseModel):
    """Request to initialize a new session."""
    user_id: int = Field(..., description="User identifier")
    
    @validator('user_id')
    def validate_user_id_range(cls, v):
        """Validate user ID is within acceptable range."""
        try:
            return validate_user_id(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))


class UpdateSessionModelsRequest(BaseModel):
    """Request to update session models."""
    session_id: str = Field(..., description="Session identifier")
    selected_models: List[str] = Field(..., description="List of selected models in 'provider/model' format")
    
    @validator('session_id')
    def validate_session_id_format(cls, v):
        """Validate session ID format and security."""
        try:
            return validate_session_id(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))
    
    @validator('selected_models')
    def validate_model_format(cls, v):
        """Validate model strings are in 'provider/model' format."""
        if len(v) > 20:  # Reasonable limit on number of models
            raise ValueError("Too many models selected (max 20)")
        
        for model_string in v:
            try:
                # Validate each model string using security module
                validate_model_string(model_string)
            except SecurityValidationError as e:
                raise ValueError(str(e))
        return v


class EndSessionRequest(BaseModel):
    """Request to end a session."""
    session_id: str = Field(..., description="Session identifier")
    
    @validator('session_id')
    def validate_session_id_format(cls, v):
        """Validate session ID format and security."""
        try:
            return validate_session_id(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))


class SessionRequest(BaseModel):
    """Basic session request with just session_id."""
    session_id: str = Field(..., description="Session identifier")
    
    @validator('session_id')
    def validate_session_id_format(cls, v):
        """Validate session ID format and security."""
        try:
            return validate_session_id(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))


class GenerateRequest(BaseModel):
    """Request for text generation."""
    session_id: str = Field(..., description="Session identifier")
    prompt: str = Field(..., description="Input prompt")
    streaming: bool = Field(default=False, description="Whether to stream the response")
    stateless: bool = Field(default=False, description="True for single-turn (new endpoint each query), False for multi-turn (reuse endpoint)")
    endpoint_id: Optional[str] = Field(default=None, description="Specific endpoint ID for single-turn mode, or None for random selection")
    user_id: Optional[int] = Field(default=None, description="User identifier for session validation (optional)")
    
    # Multi-turn conversation fields (frontend compatibility)
    is_multi_turn: bool = Field(default=False, description="Whether this is a multi-turn conversation (frontend compatibility)")
    conversation_history: Optional[List[Dict[str, Any]]] = Field(default=None, description="Previous messages in the conversation (frontend compatibility)")
    
    # Privacy Features
    pii_removal: bool = Field(False, description="Enable PII removal")
    obfuscate: bool = Field(False, description="Enable message obfuscation")
    decoy: bool = Field(False, description="Enable decoy generation (stateless only)")
    
    @validator('session_id')
    def validate_session_id_format(cls, v):
        """Validate session ID format and security."""
        try:
            return validate_session_id(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))
    
    @validator('prompt')
    def validate_prompt_security(cls, v):
        """Validate prompt for security issues and length."""
        try:
            return validate_and_escape_text(v, "prompt")
        except SecurityValidationError as e:
            raise ValueError(str(e))
    
    @validator('endpoint_id')
    def validate_endpoint_id_format(cls, v):
        """Validate endpoint ID format if provided."""
        if v is not None:
            try:
                return validate_endpoint_id(v)
            except SecurityValidationError as e:
                raise ValueError(str(e))
        return v
    
    @validator('user_id')
    def validate_user_id_range(cls, v):
        """Validate user ID if provided."""
        if v is not None:
            try:
                return validate_user_id(v)
            except SecurityValidationError as e:
                raise ValueError(str(e))
        return v


class ChatCompletionRequest(BaseModel):
    """Chat completion request."""
    model: str
    messages: List[dict]
    stream: bool = False
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None


class QueryRequest(BaseModel):
    """New query request for stateless/stateful routing."""
    user_id: int = Field(..., description="User identifier")
    prompt: str = Field(..., description="User prompt")
    streaming: bool = Field(default=False, description="Whether to stream the response")
    stateless: bool = Field(default=True, description="True for single-turn, False for multi-turn")
    endpoint_id: Optional[str] = Field(None, description="Specific endpoint ID to use (for stateful)")
    models: Optional[List[str]] = Field(None, description="List of 'provider/model' strings (for stateless)")
    ttl: int = Field(default=600, description="TTL for endpoint caching in seconds")
    
    @validator('models')
    def validate_models_when_no_endpoint(cls, v, values):
        """Validate that models are provided when no endpoint_id is specified."""
        if not values.get('endpoint_id') and not v:
            raise ValueError("Either endpoint_id or models list must be provided")
        return v
    
    @validator('models')
    def validate_model_format_if_provided(cls, v):
        """Validate model strings are in 'provider/model' format if provided."""
        if v:
            for model_string in v:
                try:
                    validate_model_string(model_string)
                except SecurityValidationError as e:
                    raise ValueError(str(e))
        return v


class DirectAPIBaseRequest(BaseModel):
    """Base request for Direct API endpoints."""
    models: Optional[List[str]] = Field(None, description="List of 'provider/model' strings")
    pii_removal: bool = Field(False, description="Enable PII removal")
    obfuscate: bool = Field(False, description="Enable obfuscation")
    decoy: bool = Field(False, description="Enable decoy generation")
    messages: List[Dict[str, str]] = Field(..., description="OpenAI-compatible messages array")
    stream: bool = Field(False, description="Enable streaming response (OpenAI-compatible)")
    
    @validator('models')
    def validate_model_format_if_provided(cls, v):
        """Validate model strings are in 'provider/model' format if provided."""
        if v:
            for model_string in v:
                try:
                    validate_model_string(model_string)
                except SecurityValidationError as e:
                    raise ValueError(str(e))
        return v
    
    @validator('messages')
    def validate_messages(cls, v):
        """Validate messages follow OpenAI format and security requirements."""
        try:
            return validate_messages_array(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))


class StatelessQueryRequest(DirectAPIBaseRequest):
    """Request for stateless (single-turn) direct API queries."""
    pass  # All fields inherited from base


class StatefulQueryRequest(DirectAPIBaseRequest):
    """Request for stateful (multi-turn) direct API queries."""
    session_id: Optional[str] = Field(None, description="Session ID for conversation continuity")
    
    @validator('session_id')
    def validate_session_id_format(cls, v):
        """Validate session ID format if provided."""
        if v is not None:
            try:
                return validate_session_id(v)
            except SecurityValidationError as e:
                raise ValueError(str(e))
        return v


class CreateSessionRequest(BaseModel):
    """Request to create a new session with model selection for Direct API."""
    user_id: int = Field(..., description="User identifier")
    models: List[str] = Field(..., description="List of 'provider/model' strings to use for this session")
    
    @validator('user_id')
    def validate_user_id_range(cls, v):
        """Validate user ID is within acceptable range."""
        try:
            return validate_user_id(v)
        except SecurityValidationError as e:
            raise ValueError(str(e))
    
    @validator('models')
    def validate_model_format(cls, v):
        """Validate model strings are in 'provider/model' format."""
        if not v:
            raise ValueError("At least one model must be specified")
        if len(v) > 20:  # Reasonable limit on number of models
            raise ValueError("Too many models selected (max 20)")
        
        for model_string in v:
            try:
                # Validate each model string using security module
                validate_model_string(model_string)
            except SecurityValidationError as e:
                raise ValueError(str(e))
        return v 