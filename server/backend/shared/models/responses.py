"""
Response models for API endpoints.
"""

from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field


class InitializeSessionResponse(BaseModel):
    """Response for session initialization."""
    session_id: str = Field(..., description="Unique session identifier")
    message: str = Field(..., description="Success message")


class ProxyInfo(BaseModel):
    """Information about a proxy/endpoint."""
    model_config = {"protected_namespaces": ()}
    
    id: str = Field(..., description="Unique proxy identifier")
    name: str = Field(..., description="Proxy display name")
    provider: str = Field(..., description="LLM provider")
    model_tag: str = Field(..., description="Model identifier")
    models_accessible: str = Field(..., description="Models accessible through this proxy")
    usage_load: str = Field(..., description="Current usage load (idle, light, moderate, heavy)")
    status: str = Field(..., description="Proxy status (Available, Standby, Active, Rate Limited)")
    token_usage_hour: int = Field(..., description="Tokens used in the last hour")
    token_usage_total: int = Field(..., description="Total tokens used")
    api_key_hash: str = Field(..., description="Hash of the API key for identification")
    last_used: Optional[str] = Field(None, description="Last used timestamp")


class SessionInfoResponse(BaseModel):
    """Response with session information."""
    session_id: str
    provider: str
    model: str
    endpoint_info: Optional[Dict[str, Any]] = None


class GenerateResponse(BaseModel):
    """Response for generate request."""
    content: str = Field(..., description="Generated content")
    provider: str = Field(..., description="Provider used")
    model: str = Field(..., description="Model used")
    usage: Optional[Dict[str, int]] = Field(None, description="Token usage statistics")
    new_endpoints: Optional[List[Dict[str, Any]]] = Field(None, description="New endpoint list for single-turn mode")


class ProxyEndpointsResponse(BaseModel):
    """Response with proxy endpoints."""
    endpoints: List[ProxyInfo] = Field(..., description="List of proxy endpoints")
    total_count: int = Field(..., description="Total number of endpoints")
    active_count: int = Field(..., description="Number of active endpoints")


class UpdateSessionModelsResponse(BaseModel):
    """Response for updating session models."""
    session_id: str = Field(..., description="Session ID")
    needs_disconnection: bool = Field(..., description="Whether disconnection is needed")
    message: str = Field(..., description="Update message")
    available_endpoints: int = Field(..., description="Number of available endpoints")


class ProvidersResponse(BaseModel):
    """Response with available providers."""
    providers: Dict[str, List[str]] = Field(
        ...,
        description="Map of provider names to their available models"
    )


class ChatCompletionResponse(BaseModel):
    """OpenAI-compatible chat completion response."""
    model_config = {
        "json_schema_extra": {
            "example": {
                "id": "chatcmpl-123",
                "object": "chat.completion",
                "created": 1677652288,
                "model": "openai/gpt-4o",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "Hello! How can I help you today?"
                    },
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 12,
                    "total_tokens": 22
                }
            }
        }
    }
    
    id: str = Field(..., description="Unique completion ID")
    object: str = Field("chat.completion", description="Object type")
    created: int = Field(..., description="Unix timestamp")
    model: str = Field(..., description="Model used")
    choices: List[Dict[str, Any]] = Field(..., description="Completion choices")
    usage: Dict[str, int] = Field(..., description="Token usage statistics")


class StreamChunk(BaseModel):
    """Streaming response chunk."""
    id: str = Field(..., description="Chunk ID")
    object: str = Field("chat.completion.chunk", description="Object type")
    created: int = Field(..., description="Unix timestamp")
    model: str = Field(..., description="Model used")
    choices: List[Dict[str, Any]] = Field(..., description="Chunk choices")


class HealthResponse(BaseModel):
    """Health check response."""
    status: str = Field("healthy", description="Service status")
    version: str = Field(..., description="Service version")
    uptime: float = Field(..., description="Service uptime in seconds")
    
    
class StatsResponse(BaseModel):
    """Statistics response."""
    total_sessions: int
    active_sessions: int
    total_requests: int
    providers_stats: Dict[str, Dict[str, Any]]
    

class ErrorResponse(BaseModel):
    """Error response."""
    error: str = Field(..., description="Error message")
    code: str = Field(..., description="Error code")
    details: Optional[Dict[str, Any]] = Field(None, description="Additional error details")


class QueryResponse(BaseModel):
    """Response for the new query routing API."""
    success: bool = Field(..., description="Whether the query was successful")
    response: Optional[Dict[str, Any]] = Field(None, description="Generated response data")
    error: Optional[str] = Field(None, description="Error message if failed")
    endpoint_info: Optional[Dict[str, Any]] = Field(None, description="Information about the endpoint used")
    new_endpoints: Optional[List[Dict[str, Any]]] = Field(None, description="New endpoint list for stateless queries")


class QueryMetaData(BaseModel):
    """Metadata for query responses."""
    endpoint_id: str = Field(..., description="Endpoint ID used for the query")
    model: str = Field(..., description="Model used in 'provider/model' format")
    token_usage: Dict[str, int] = Field(..., description="Token usage statistics")
    total_token_used: int = Field(..., description="Total tokens used in this query")
    session_privacy_score: Optional[float] = Field(None, description="Session privacy score (stateful only)")


class QueryChoice(BaseModel):
    """OpenAI-compatible choice structure."""
    index: int = Field(0, description="Choice index")
    message: Dict[str, str] = Field(..., description="Message with role and content")
    finish_reason: str = Field("stop", description="Finish reason")
    

class DirectAPIBaseResponse(BaseModel):
    """Base response for Direct API endpoints."""
    turn_id: str = Field(..., description="Unique turn identifier")
    choices: List[QueryChoice] = Field(..., description="OpenAI-compatible choices array")
    meta_data: QueryMetaData = Field(..., description="Query metadata")


class StatelessQueryResponse(DirectAPIBaseResponse):
    """Response for stateless (single-turn) direct API queries."""
    pass  # All fields inherited from base


class StatefulQueryResponse(DirectAPIBaseResponse):
    """Response for stateful (multi-turn) direct API queries."""
    session_id: str = Field(..., description="Session ID for conversation continuity")


class CreateSessionResponse(BaseModel):
    """Response for create session endpoint in Direct API."""
    session_id: str = Field(..., description="Unique session identifier")
    endpoint_id: str = Field(..., description="Selected endpoint identifier for this session")
    provider: str = Field(..., description="Provider name (e.g., 'openai', 'anthropic')")
    model: str = Field(..., description="Model name (e.g., 'gpt-4o', 'claude-3-opus')")
    api_key_hash: str = Field(..., description="Hash of the API key for identification")
    message: str = Field(..., description="Success message with session details")
    available_endpoints: int = Field(..., description="Total number of endpoints available for this session")