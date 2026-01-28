"""Chat-event retrieval utilities."""

from dataclasses import dataclass
from collections import defaultdict
import os
import json
import numpy as np
import torch
import time
import random
from typing import List, Tuple, Optional
from transformers import AutoModel, AutoTokenizer
from dotenv import load_dotenv
import logging

load_dotenv()


# ----------------------- Chat Event Retriever -----------------------


@dataclass
class ChatEvent:
    """Represents a chat session treated as a single retrievable event."""

    session_id: str
    title: str
    content: str
    summary: str
    created_at: Optional[int] = None
    updated_at: Optional[int] = None
    embedding: Optional[np.ndarray] = None


class ChatEventRetriever:
    """Lightweight RAG over pre-embedded chat events.

    Each chat session is treated as an event. Events must be pre-embedded
    (via preprocess_events.py script) and loaded from an event store JSON file.
    Top-k retrieval uses cosine similarity against the cached embedding matrix.
    """

    def __init__(
        self,
        event_store_path: str,
        embedding_model_path: str = "Qwen/Qwen3-Embedding-0.6B",
        random_seed: int = 13,
        summary_max_chars: int = 480,
    ):
        self.logger = logging.getLogger("exp_with_memory")
        self.event_store_path = os.path.abspath(event_store_path)
        self.summary_max_chars = summary_max_chars
        self._base_seed = random_seed

        # Force CPU to avoid MPS issues on Mac
        self.device = "cpu"
        self.tokenizer = AutoTokenizer.from_pretrained(embedding_model_path)
        self.model = AutoModel.from_pretrained(
            embedding_model_path, 
            torch_dtype=torch.float32,
            device_map=self.device
        )
        self.logger.info(f"ChatEventRetriever using model: {embedding_model_path}")

        self.events: List[ChatEvent] = self._load_event_store()
        self._event_matrix = (
            np.stack([e.embedding for e in self.events]) if self.events else np.empty((0,))
        )

    def _load_event_store(self) -> List[ChatEvent]:
        """Load pre-computed event store from JSON."""
        if not os.path.exists(self.event_store_path):
            raise FileNotFoundError(
                f"Event store not found: {self.event_store_path}. "
                f"Run preprocess_events.py first to create it."
            )

        with open(self.event_store_path, "r") as f:
            data = json.load(f)

        events: List[ChatEvent] = []
        for item in data:
            embedding = None
            if item.get("embedding") is not None:
                embedding = np.array(item["embedding"], dtype=np.float32)
            
            event = ChatEvent(
                session_id=item["session_id"],
                title=item["title"],
                content=item["content"],
                summary=item["summary"],
                created_at=item.get("created_at"),
                updated_at=item.get("updated_at"),
                embedding=embedding,
            )
            events.append(event)

        self.logger.info(f"Loaded {len(events)} pre-embedded events from {self.event_store_path}")
        return events

    def embed_text(self, text: str, max_retries: int = 3) -> np.ndarray:
        """Embed query text for retrieval."""
        for attempt in range(max_retries):
            try:
                inputs = self.tokenizer(
                    text,
                    return_tensors="pt",
                    truncation=True,
                    max_length=8192,
                )
                inputs = {k: v.to(self.device) for k, v in inputs.items()}
                with torch.no_grad():
                    outputs = self.model(**inputs)
                    hidden = outputs.last_hidden_state.float()
                    mask = inputs["attention_mask"].unsqueeze(-1).float()
                    masked = hidden * mask
                    summed = masked.sum(dim=1)
                    counts = mask.sum(dim=1).clamp(min=1)
                    embedding = summed / counts
                vec = embedding.squeeze(0).cpu().numpy()
                norm = np.linalg.norm(vec)
                return vec / (norm + 1e-9)
            except Exception as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt
                    self.logger.warning(
                        f"Embedding error (attempt {attempt + 1}/{max_retries}): {e}"
                    )
                    time.sleep(wait_time)
                else:
                    raise

    def retrieve_top_k(self, query: str, top_k: int) -> List[Tuple[ChatEvent, float]]:
        if not self.events:
            return []

        query_embedding = self.embed_text(query)
        similarities = self._event_matrix @ query_embedding

        top_indices = np.argsort(similarities)[-top_k:][::-1]
        return [
            (self.events[idx], float(similarities[idx])) for idx in top_indices
        ]

    def format_events_for_prompt(
        self, retrieved: List[Tuple[ChatEvent, float]], randomize: bool = True
    ) -> str:
        if not retrieved:
            return ""

        items = list(retrieved)
        if randomize:
            local_rng = random.Random(self._base_seed + len(items))
            local_rng.shuffle(items)

        formatted = "## Retrieved Chat Events (top-k)\n\n"
        formatted += (
            "These are prior chat sessions; use them only as hints. Do not copy text verbatim.\n\n"
        )

        for idx, (event, sim) in enumerate(items, start=1):
            snippet = event.content[: self.summary_max_chars]
            formatted += f"### Event {idx} (sim={sim:.3f})\n"
            formatted += f"Title: {event.title}\n"
            formatted += f"Summary: {event.summary}\n"
            formatted += f"Snippet: {snippet}\n\n"

        return formatted