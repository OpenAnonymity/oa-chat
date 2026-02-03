import logging
from typing import Optional
from oa_agent.llm_client import LLMClient

logger = logging.getLogger(__name__)


class LLMAgent:
    def __init__(self, model_name: str = "qwen/qwen-2.5-7b-instruct",
                 temperature: float = 0.6,
                 max_tokens: int = 4096,
                 server_type: str = "openrouter"):
        self.agent = LLMClient(model_name, temperature, max_tokens, server_type=server_type, logger=logger)
    
    def generate_text(self, prompt: str) -> str:
        """Generate raw text from the model"""
        return self.agent.generate(prompt)
