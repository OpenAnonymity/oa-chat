"""
Internal domain models.
"""

from typing import List, Optional, Dict, Any
from datetime import datetime
from pydantic import BaseModel, Field


class SessionState(BaseModel):
    """Internal session state representation."""
    session_id: str
    user_id: int
    selected_models: List[str] = Field(default_factory=list, description="Selected models in 'provider/model' format")
    current_provider: str = ""
    current_model: str = ""
    endpoint_id: Optional[str] = None
    api_key_hash: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    status: str = "active"  # active, expired, ended

    def is_active(self) -> bool:
        """Check if session has an active endpoint."""
        return bool(self.current_provider and self.current_model and self.endpoint_id)


class EndpointInfo(BaseModel):
    """Internal endpoint information."""
    id: str
    provider: str
    model: str
    api_key: str
    api_key_hash: str
    key_id: str
    usage_stats: Dict[str, int] = Field(default_factory=dict)
    
    def get_usage_load(self) -> float:
        """Calculate usage load (0-1)."""
        tokens_hour = self.usage_stats.get("tokens_hour", 0)
        # Assume 100k tokens/hour is max load
        return min(tokens_hour / 100000, 1.0)
    
    def get_status(self) -> str:
        """Determine endpoint status."""
        load = self.get_usage_load()
        if load >= 0.9:
            return "unavailable"
        elif load >= 0.7:
            return "degraded"
        return "healthy"


class ProviderConfig(BaseModel):
    """Provider configuration."""
    name: str
    models: List[str]
    endpoint_class: str
    max_requests_per_hour: int = 10000
    max_tokens_per_hour: int = 100000
    
    def supports_model(self, model: str) -> bool:
        """Check if provider supports a model."""
        return model in self.models 