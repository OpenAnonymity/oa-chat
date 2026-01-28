"""Lightweight memory store."""

import json
import os
import time
from dataclasses import dataclass, asdict, fields
from typing import List, Optional
from datetime import datetime
from dotenv import load_dotenv
import numpy as np
import logging
import torch
from transformers import AutoModel, AutoTokenizer

load_dotenv()

logger = logging.getLogger(__name__)

@dataclass
class MemoryItem:
    """Single memory item in ReasoningBank"""
    title: str
    description: str
    content: str
    problem_id: str
    success: bool
    created_at: str
    code_snippet: Optional[str] = None 
    runtime: Optional[float] = None 
    baseline_runtime: Optional[float] = None 
    speedup_ratio: Optional[float] = None 
    performance_category: Optional[str] = None 
    embedding: Optional[np.ndarray] = None 

    def to_dict(self):
        """Convert to dictionary for JSON, converting ndarray to list"""
        data = asdict(self)
        if isinstance(self.embedding, np.ndarray):
            data['embedding'] = self.embedding.tolist()
        return data

    @classmethod
    def from_dict(cls, data):
        """Create MemoryItem from dict, converting list back to ndarray if present"""
        valid_fields = {f.name for f in fields(cls)}
        filtered_data = {k: v for k, v in data.items() if k in valid_fields}
        if 'embedding' in filtered_data and filtered_data['embedding'] is not None:
            if isinstance(filtered_data['embedding'], list):
                filtered_data['embedding'] = np.array(filtered_data['embedding'], dtype=float)
        
        return cls(**filtered_data)

class ReasoningBank:
    """Simple vector store for generic memories."""

    def __init__(self,
                 embedding_model_path: str = "Qwen/Qwen3-Embedding-0.6B",
                 memory_file: Optional[str] = None):
        storage_path = os.path.abspath(memory_file) if memory_file else os.path.abspath("./memories.json")
        os.makedirs(os.path.dirname(storage_path), exist_ok=True)
        self.storage_path = storage_path
        self.memories: List[MemoryItem] = []
        # Force CPU to avoid MPS issues on Mac
        self.device = "cpu"
        self.tokenizer = AutoTokenizer.from_pretrained(embedding_model_path)
        self.model = AutoModel.from_pretrained(
            embedding_model_path, torch_dtype=torch.float32
        ).to(self.device)
        logger.info(f"Loaded embedding model: {embedding_model_path}")
        self.load()

    def embed_text(self, text: str, max_retries: int = 3) -> np.ndarray:
        """Generate embedding for a single text with retry/backoff using local model."""
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
                return embedding.squeeze(0).cpu().numpy()
            except Exception as e:
                if attempt < max_retries - 1:
                    wait_time = 2 ** attempt
                    print(f"Embedding error (attempt {attempt + 1}/{max_retries}): {e}")
                    print(f"Retrying in {wait_time} seconds...")
                    time.sleep(wait_time)
                else:
                    print(f"Failed to embed text after {max_retries} attempts")
                    raise

    def embed_memories(self, memories: list):
        """Embed a list of memories if they don't already have embeddings"""
        for memory in memories:
            if memory.embedding is not None:
                continue

            text = memory.content.strip() or f"{memory.title}.{memory.description}"
            try:
                embedding = self.embed_text(text)
                if embedding is not None:
                    memory.embedding = embedding
                else:
                    print(f"[WARN] Memory '{memory.title}' returned no embedding!")
            except Exception as e:
                print(f"[ERROR] Embedding memory '{memory.title}': {e}")

        self.save()

    def add_memory(self, memory: MemoryItem):
        """Add new memory item"""
        text = memory.content.strip() or f"{memory.title}.{memory.description}"
        memory.embedding = self.embed_text(text)
        self.memories.append(memory)
        self.save()

    def add_memories(self, memories: List[MemoryItem]):
        """Add multiple memories"""
        for m in memories:
            self.add_memory(m)

    def get_all_memories(self) -> List[MemoryItem]:
        """Get all memories"""
        return self.memories

    def save(self):
        """Persist to disk"""
        with open(self.storage_path, 'w') as f:
            data = [m.to_dict() for m in self.memories]
            json.dump(data, f, indent=2)

    def load(self):
        """Load from disk"""
        try:
            with open(self.storage_path, 'r') as f:
                data = json.load(f)
                self.memories = [MemoryItem.from_dict(m) for m in data]
        except FileNotFoundError:
            self.memories = []

    def clear(self):
        """Clear all memories"""
        self.memories = []
        self.save()

    def __len__(self):
        return len(self.memories)