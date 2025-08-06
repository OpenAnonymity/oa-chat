"""
Provider enums for LLM providers.
"""

from enum import Enum


class Provider(Enum):
    """LLM provider enumeration."""
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"
    TOGETHER = "together.ai"
    DEEPSEEK = "deepseek"
    XAI = "xai" 