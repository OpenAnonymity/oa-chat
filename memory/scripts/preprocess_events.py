"""
Preprocess chat export and create event store with pre-computed embeddings.

This script loads a FastChat JSON export, creates ChatEvent objects for each session,
computes embeddings, and persists them to disk. The event store can then be loaded
and used by retriever without re-embedding on every run.
"""

import json
import os
import sys
import argparse
import logging
from collections import defaultdict
from pathlib import Path
from typing import List, Optional

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer
from dotenv import load_dotenv

# Add parent directory to path to import oa_agent
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from oa_agent.llm_client import LLMClient

load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class ChatEvent:
    """Represents a chat session as a single event."""
    
    def __init__(
        self,
        session_id: str,
        title: str,
        content: str,
        summary: str,
        created_at: Optional[int] = None,
        updated_at: Optional[int] = None,
        embedding: Optional[np.ndarray] = None,
    ):
        self.session_id = session_id
        self.title = title
        self.content = content
        self.summary = summary
        self.created_at = created_at
        self.updated_at = updated_at
        self.embedding = embedding

    def to_dict(self):
        """Convert to dict for JSON serialization."""
        return {
            "session_id": self.session_id,
            "title": self.title,
            "content": self.content,
            "summary": self.summary,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "embedding": self.embedding.tolist() if self.embedding is not None else None,
        }

    @classmethod
    def from_dict(cls, data):
        """Reconstruct from dict."""
        embedding = None
        if data.get("embedding") is not None:
            embedding = np.array(data["embedding"], dtype=np.float32)
        return cls(
            session_id=data["session_id"],
            title=data["title"],
            content=data["content"],
            summary=data["summary"],
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at"),
            embedding=embedding,
        )


class EventPreprocessor:
    """Preprocesses FastChat exports into event store."""
    
    def __init__(
        self,
        embedding_model_path: str = "Qwen/Qwen3-Embedding-0.6B",
        dedup: bool = False,
        use_llm_summary: bool = False,
    ):
        self.embedding_model_path = embedding_model_path
        self.dedup = dedup
        self.use_llm_summary = use_llm_summary
        
        # Force CPU to avoid MPS issues on Mac
        self.device = "cpu"
        logger.info(f"Using device: {self.device}")
        
        self.tokenizer = AutoTokenizer.from_pretrained(embedding_model_path)
        self.model = AutoModel.from_pretrained(
            embedding_model_path, torch_dtype=torch.float32
        ).to(self.device)
        logger.info(f"Loaded embedding model: {embedding_model_path}")
        
        # Initialize LLM client if using LLM summaries
        self.llm_client = None
        if self.use_llm_summary:
            self.llm_client = LLMClient(
                model_name="qwen/qwen-2.5-7b-instruct",
                temperature=0.3,
                max_tokens=150,
                server_type="openrouter",
                system_prompt="You are a helpful assistant that creates concise summaries.",
                logger=logger,
            )
            logger.info("Initialized LLM client for summary generation")
    
    def embed_text(self, text: str, max_retries: int = 3) -> np.ndarray:
        """Generate normalized embedding for text."""
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
                
                vec = embedding.squeeze(0).cpu().numpy().astype(np.float32)
                norm = np.linalg.norm(vec)
                return vec / (norm + 1e-9)
            except Exception as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt
                    logger.warning(
                        f"Embedding error (attempt {attempt + 1}/{max_retries}): {e}"
                    )
                    import time
                    time.sleep(wait_time)
                else:
                    raise
    
    def generate_llm_summary(self, content: str, title: str) -> str:
        """Generate a summary using LLM."""
        if not self.llm_client:
            return title  # Fallback
        
        prompt = f"""Summarize the following conversation in concise sentences. Focus on the main topic and key points.

Title: {title}

Conversation:
{content}  

Summary:"""
        
        try:
            summary = self.llm_client.generate(prompt).strip()
            logger.info(f"Generated LLM summary for '{title}': {summary[:100]}...")
            return summary
        except Exception as e:
            logger.warning(f"LLM summary failed for '{title}': {e}. Using title as fallback.")
            return title
    
    def load_events_from_export(self, events_path: str) -> List[ChatEvent]:
        """Load and parse FastChat JSON export into ChatEvent objects."""
        if not os.path.exists(events_path):
            raise FileNotFoundError(f"Events file not found: {events_path}")
        
        with open(events_path, "r") as f:
            data = json.load(f)
        
        chats = data.get("data", {}).get("chats", {})
        sessions = chats.get("sessions", [])
        messages = chats.get("messages", [])
        
        # Group messages by session
        grouped_msgs = defaultdict(list)
        for msg in messages:
            session_id = msg.get("sessionId")
            if session_id:
                grouped_msgs[session_id].append(msg)
        
        events: List[ChatEvent] = []
        seen_keys = set()
        
        for session in sessions:
            session_id = session.get("id")
            if not session_id:
                continue
            
            # Sort messages by timestamp
            session_msgs = sorted(
                grouped_msgs.get(session_id, []),
                key=lambda m: m.get("timestamp") or m.get("createdAt") or 0,
            )
            
            # Build content and extract summary
            lines = []
            first_user = None
            for msg in session_msgs:
                role = msg.get("role", "")
                content = (msg.get("content") or "").strip()
                if first_user is None and role == "user" and content:
                    first_user = content
                if content:
                    lines.append(f"{role}: {content}")
            
            content_blob = "\n".join(lines)
            summary = first_user or session.get("title") or "conversation"
            title = session.get("title") or f"Session {session_id}"
            
            # Generate LLM summary if enabled
            if self.use_llm_summary and content_blob:
                summary = self.generate_llm_summary(content_blob, title)
            
            # Optional dedup
            dedup_key = (title.strip().lower(), (summary or "").strip().lower())
            if self.dedup and dedup_key in seen_keys:
                logger.debug(f"Skipping duplicate session: {title}")
                continue
            seen_keys.add(dedup_key)
            
            events.append(
                ChatEvent(
                    session_id=session_id,
                    title=title,
                    content=content_blob,
                    summary=summary,
                    created_at=session.get("createdAt"),
                    updated_at=session.get("updatedAt"),
                )
            )
        
        logger.info(
            f"Loaded {len(events)} chat events from {events_path} (dedup={self.dedup})"
        )
        return events
    
    def embed_events(self, events: List[ChatEvent]) -> List[ChatEvent]:
        """Compute and assign embeddings to all events."""
        for idx, event in enumerate(events):
            text = f"{event.title}\n\n{event.summary}"
            event.embedding = self.embed_text(text)
            
            if (idx + 1) % 10 == 0:
                logger.info(f"Embedded {idx + 1}/{len(events)} events")
        
        logger.info(f"Completed embedding all {len(events)} events")
        return events
    
    def save_events(self, events: List[ChatEvent], output_path: str):
        """Persist events to JSON file."""
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        
        with open(output_path, "w") as f:
            data = [e.to_dict() for e in events]
            json.dump(data, f, indent=2)
        
        logger.info(f"Saved {len(events)} events to {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Preprocess FastChat export into embedded event store"
    )
    parser.add_argument(
        "--export",
        type=str,
        required=True,
        help="Path to FastChat JSON export",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="./event_store.json",
        help="Output path for event store (default: ./event_store.json)",
    )
    parser.add_argument(
        "--embedding-model",
        type=str,
        default="Qwen/Qwen3-Embedding-0.6B",
        help="Embedding model path (default: Qwen/Qwen3-Embedding-0.6B)",
    )
    parser.add_argument(
        "--dedup",
        action="store_true",
        help="Deduplicate events by (title, summary) key",
    )
    parser.add_argument(
        "--use-llm-summary",
        action="store_true",
        help="Use LLM (OpenRouter) to generate summaries instead of using first user message",
    )
    
    args = parser.parse_args()
    
    logger.info(f"Starting preprocessing: {args.export} -> {args.output}")
    
    preprocessor = EventPreprocessor(
        embedding_model_path=args.embedding_model,
        dedup=args.dedup,
        use_llm_summary=args.use_llm_summary,
    )
    
    # Load events from export
    events = preprocessor.load_events_from_export(args.export)
    
    # Embed all events
    events = preprocessor.embed_events(events)
    
    # Save to disk
    preprocessor.save_events(events, args.output)
    
    logger.info("Preprocessing complete")


if __name__ == "__main__":
    main()
