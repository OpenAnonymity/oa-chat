"""
Data models for the web server.
"""

from .requests import (
    InitializeSessionRequest,
    UpdateSessionModelsRequest,
    EndSessionRequest,
    SessionRequest,
    GenerateRequest,
    ChatCompletionRequest,
    QueryRequest,
    DirectAPIBaseRequest,
    StatelessQueryRequest,
    StatefulQueryRequest
)

from .responses import (
    InitializeSessionResponse,
    ProxyInfo,
    SessionInfoResponse,
    GenerateResponse,
    ProxyEndpointsResponse,
    UpdateSessionModelsResponse,
    ProvidersResponse,
    ChatCompletionResponse,
    StreamChunk,
    HealthResponse,
    StatsResponse,
    ErrorResponse,
    QueryResponse,
    QueryMetaData,
    QueryChoice,
    DirectAPIBaseResponse,
    StatelessQueryResponse,
    StatefulQueryResponse
)

from .internal import (
    SessionState,
    EndpointInfo,
    ProviderConfig
)

__all__ = [
    # Request models
    "InitializeSessionRequest",
    "UpdateSessionModelsRequest",
    "EndSessionRequest",
    "SessionRequest",
    "GenerateRequest",
    "ChatCompletionRequest",
    "QueryRequest",
    "DirectAPIBaseRequest",
    "StatelessQueryRequest",
    "StatefulQueryRequest",
    
    # Response models
    "InitializeSessionResponse",
    "ProxyInfo",
    "SessionInfoResponse",
    "GenerateResponse",
    "ProxyEndpointsResponse",
    "UpdateSessionModelsResponse",
    "ProvidersResponse",
    "ChatCompletionResponse",
    "StreamChunk",
    "HealthResponse",
    "StatsResponse",
    "ErrorResponse",
    "QueryResponse",
    "QueryMetaData",
    "QueryChoice",
    "DirectAPIBaseResponse",
    "StatelessQueryResponse",
    "StatefulQueryResponse",
    
    # Internal models
    "SessionState",
    "EndpointInfo",
    "ProviderConfig"
] 