# Memory System Guide

## Overview

The memory system consists of two distinct workflows:

1. **Memory Processing**: Extract chat history from IndexedDB and create an event store with embeddings
2. **Memory Retrieval**: Use the event store to intelligently retrieve relevant memories and generate LLM responses

## Architecture

### Frontend (Browser)
- **`chat/services/mentionService.js`**: Detects @mentions and shows popup
- **`chat/services/memoryService.js`**: Handles "Process Memory" button - exports chat history and triggers preprocessing
- **`chat/services/memoryRetrievalService.js`**: Handles @memory mentions - retrieves memories and generates LLM responses

### Backend (Local Flask Server)
- **`OA_memory/scripts/server.py`**: Flask server running on port 5555
  - `GET /health` - Health check
  - `POST /process-memory` - Process chat history into event store
  - `GET /memory-status` - Check event store status
  - `POST /retrieve-memory` - Retrieve memories and generate response using LLM

### Python Processing
- **`OA_memory/scripts/preprocess_events.py`**: Converts chat exports to embeddings
  - Uses Qwen3-Embedding-0.6B for embeddings
  - Generates LLM summaries for each event
- **`OA_memory/exp_with_memory.py`**: Memory retrieval and LLM generation
  - `run_llm_with_retrieval(config, user_query)` - Core function for retrieval