import os
import logging
from dataclasses import dataclass
from typing import List
from dotenv import load_dotenv

from oa_agent.retriever import ChatEventRetriever
from oa_agent.llm_client import LLMClient

load_dotenv()


def setup_logging(log_dir: str) -> logging.Logger:
    """Setup basic logging to file and console."""
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "exp_log.log")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
        handlers=[
            logging.FileHandler(log_file, mode="w"),
            logging.StreamHandler(),
        ],
    )
    return logging.getLogger("exp_with_memory")


class ExpConfig:
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


@dataclass
class QueryTask:
    query: str
    name: str = ""


def run_queries(config: ExpConfig, queries: List[QueryTask]):
    """Run top-k retrieval for each query and print formatted snippets."""
    logger = setup_logging(config.logdir)
    logger.info("Initializing chat-event retriever...")
    retriever = ChatEventRetriever(
        event_store_path=config.event_store_path,
        embedding_model_path=config.embedding_model_path,
        random_seed=config.event_random_seed,
        summary_max_chars=config.event_summary_max_chars,
    )
    logger.info(
        "Retriever ready | top_k=%s event_store=%s",
        config.event_top_k,
        config.event_store_path,
    )

    for task in queries:
        logger.info("\n=== Query: %s ===", task.name or task.query)
        retrieved = retriever.retrieve_top_k(task.query, top_k=config.event_top_k)
        formatted = retriever.format_events_for_prompt(retrieved, randomize=True)
        print("\n------ RETRIEVED PROMPT BLOCK ------\n")
        print(formatted or "<no events>")
        print("\n-----------------------------------\n")


def build_recommendation_prompt(context_block: str, user_query: str) -> str:
    return f"""
Past memory and context about user you should take into account:{context_block}

User request: {user_query}

"""


def run_llm_with_retrieval(config: ExpConfig, user_query: str) -> str:
    """Retrieve top events and ask the LLM for tailored recommendations."""
    logger = setup_logging(config.logdir)
    logger.info("Initializing retriever and LLM client for recommendation run")

    retriever = ChatEventRetriever(
        event_store_path=config.event_store_path,
        embedding_model_path=config.embedding_model_path,
        random_seed=config.event_random_seed,
        summary_max_chars=config.event_summary_max_chars,
    )

    retrieved = retriever.retrieve_top_k(user_query, top_k=config.event_top_k)
    context_block = retriever.format_events_for_prompt(retrieved, randomize=True)

    # Show the context fed to the model
    print("\n===== Retrieved Context =====\n")
    print(context_block or "<no events>")
    print("\n============================\n")

    llm_client = LLMClient(
        model_name=config.llm_model,
        temperature=config.llm_temperature,
        max_tokens=config.llm_max_tokens,
        server_type="openrouter",
    )

    prompt = build_recommendation_prompt(context_block, user_query)
    # Show the full prompt sent to the model
    print("\n===== Prompt to LLM =====\n")
    print(prompt)
    print("\n========================\n")
    logger.info("Calling LLM with retrieved context | events=%s", len(retrieved))
    return llm_client.generate(prompt)


def _default_queries() -> List[QueryTask]:
    return [
        QueryTask("Explain memory structure for rlm paper"),
        QueryTask("Summarize proposal sensitivity analysis"),
    ]


if __name__ == "__main__":
    cfg = ExpConfig()
    # user_query = "I want recommendations for clothes that I might like."
    user_query = "Give me a personal description of who you think I am."
    response = run_llm_with_retrieval(cfg, user_query)
    print("\n===== LLM Response =====\n")
    print(response)
    print("\n========================\n")