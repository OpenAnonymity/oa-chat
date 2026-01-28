"""
Configuration for the memory retrieval system.
Shared configuration used by both the experimental scripts and the server.
"""

import os


class MemoryConfig:
    """Configuration for chat-event retrieval over a pre-embedded event store."""

    def __init__(self):
        self.event_store_path = os.path.abspath(
            os.path.join(
                os.path.dirname(__file__),
                "event_store.json",
            )
        )
        self.embedding_model_path = "Qwen/Qwen3-Embedding-0.6B"
        self.event_top_k = 3
        self.event_summary_max_chars = 480
        self.event_random_seed = 13
        self.logdir = os.path.join(".", "ds_results", "eval_logs")
        # Default to OpenRouter's GPT-5.2 chat identifier; override via LLM_MODEL env if needed
        self.llm_model = os.environ.get("LLM_MODEL", "openai/gpt-5.2-chat")
        self.llm_max_tokens = 400
        self.llm_temperature = 0.6
