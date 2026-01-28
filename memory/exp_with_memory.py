import os
import logging
from dataclasses import dataclass
from typing import List
from dotenv import load_dotenv

from oa_agent.retriever import ChatEventRetriever
from oa_agent.llm_client import LLMClient
from oa_agent.logging_utils import setup_logging
from config import MemoryConfig

load_dotenv()

logger = logging.getLogger(__name__)


@dataclass
class QueryTask:
    query: str
    name: str = ""


def run_queries(config: MemoryConfig, queries: List[QueryTask]):
    """Run top-k retrieval for each query and print formatted snippets."""
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
{user_query}

The following context may help your response:
{context_block}
"""

def personalize_prompt(config: MemoryConfig, user_query: str) -> str:
    """Retrieve top events and build a personalized_prompt."""
    logger.info("Initializing retriever for personalized prompt run")

    retriever = ChatEventRetriever(
        event_store_path=config.event_store_path,
        embedding_model_path=config.embedding_model_path,
        random_seed=config.event_random_seed,
        summary_max_chars=config.event_summary_max_chars,
    )

    retrieved = retriever.retrieve_top_k(user_query, top_k=config.event_top_k)
    context_block = retriever.format_events_for_prompt(retrieved, randomize=True)

    # Show the context fed to the model
    logger.info("\n===== Retrieved Context =====\n")
    logger.info(context_block or "<no events>")
    logger.info("\n============================\n")

    final_prompt = build_recommendation_prompt(context_block, user_query)
    # Show the full prompt sent to the model
    logger.info("\n===== Prompt to LLM =====\n")
    logger.info(final_prompt)
    logger.info("\n========================\n")
    logger.info("Personalized prompt built with retrieved context | events=%s", len(retrieved))
    return final_prompt

def llm_generate_response(config: MemoryConfig, prompt: str) -> str:
    """Retrieve top events and ask the LLM for tailored recommendations."""
    logger.info("Initializing LLM client for response generation")

    llm_client = LLMClient(
        model_name=config.llm_model,
        temperature=config.llm_temperature,
        max_tokens=config.llm_max_tokens,
        server_type="openrouter",
    )

    logger.info("Calling LLM with prompt | prompt=%s", prompt)
    return llm_client.generate(prompt)


def _default_queries() -> List[QueryTask]:
    return [
        QueryTask("Explain memory structure for rlm paper"),
        QueryTask("Summarize proposal sensitivity analysis"),
    ]


if __name__ == "__main__":
    cfg = MemoryConfig()
    # Set up logging when running standalone
    setup_logging(cfg, log_filename="exp_log.log")
    
    # user_query = "I want recommendations for clothes that I might like."
    user_query = "Give me a personal description of who you think I am."
    personalized_prompt = personalize_prompt(cfg, user_query)
    response = llm_generate_response(cfg, personalized_prompt)
    print("\n===== LLM Response =====\n")
    print(response)
    print("\n========================\n")