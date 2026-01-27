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

## Setup Instructions

### 1. Install Flask Dependencies

```bash
cd /Users/cocox/Desktop/oa-fastchat/OA_memory
pip install flask flask-cors
```

### 2. Verify Python Dependencies

The system needs:
- `torch` or `transformers` for embeddings
- `openai` or compatible LLM client for OpenRouter

Check your `exp_with_memory.py` for the exact requirements.

### 3. Set Environment Variables

Make sure your OpenRouter API key is available:

```bash
export OPENROUTER_API_KEY="your-key-here"
```

Or set it in a `.env` file in the `OA_memory` directory.

## Usage Workflow

### Step 1: Process Chat History

1. Open the FastChat app in your browser
2. In the left sidebar, click the **"Process Memory"** button
3. The app will:
   - Export all chat sessions from IndexedDB
   - Send to the Flask server at `http://localhost:5555`
   - Preprocess chats into an event store with embeddings
   - Save the event store to `OA_memory/event_store.json`

### Step 2: Use @memory Mentions

1. In the chat input, type: `@memory what should I do?`
2. A popup will appear showing "memory"
3. Click on "memory" (or press Tab/Enter)
4. The system will:
   - Extract your query: "what should I do?"
   - Remove "@memory" from the input
   - Send query to `/retrieve-memory` endpoint
   - Retrieve relevant memories from the event store
   - Generate an LLM response based on those memories
   - Insert the response into your chat input
5. Press Enter to send the memory-augmented message

## Testing Checklist

### Testing the "Process Memory" Button

- [ ] Server is running: `python OA_memory/scripts/server.py`
- [ ] Click "Process Memory" button in sidebar
- [ ] Wait for processing to complete (see toast notifications)
- [ ] Check `OA_memory/event_store.json` exists
- [ ] Check browser console for no errors
- [ ] Visit `http://localhost:5555/memory-status` to verify event store stats

### Testing @memory Mentions

- [ ] Type `@memory` in chat input
- [ ] Popup appears with "memory" option
- [ ] Type a query like: `@memory what topics did we discuss?`
- [ ] Click on "memory" option or press Enter
- [ ] @memory gets removed from input
- [ ] Wait for LLM response to appear in input (see loading toast)
- [ ] Response appears in chat input
- [ ] Press Enter to send the memory-augmented message
- [ ] Verify the response was generated correctly

### End-to-End Test

1. Create a few chat sessions with various topics
2. Click "Process Memory" and wait for completion
3. In a new message, type: `@memory summarize the main topics we discussed`
4. Select @memory from the popup
5. Verify the response includes information from your past conversations
6. Send and verify it appears in the chat

## Troubleshooting

### Server Not Available Error

**Problem**: "Memory server is not running"

**Solution**:
```bash
cd /Users/cocox/Desktop/oa-fastchat/OA_memory
python scripts/server.py
```

Check the server is running at `http://localhost:5555/health`

### Event Store Not Found Error

**Problem**: "Event store not found at /path/to/event_store.json"

**Solution**: Click the "Process Memory" button first to create the event store.

### Memory Retrieval Fails

**Problem**: Various errors during `/retrieve-memory`

**Check**:
1. Server is running and healthy
2. Event store exists: `OA_memory/event_store.json`
3. OpenRouter API key is set in environment
4. Check server logs for detailed error messages

### @mention Popup Not Showing

**Problem**: Popup doesn't appear when typing @

**Check**:
1. Browser console for JavaScript errors
2. Make sure mention popup element exists in index.html
3. Check mentionService is initialized in app.js

## File Locations Reference

| Component | Location |
|-----------|----------|
| Mention Service | `chat/services/mentionService.js` |
| Memory Service (Processing) | `chat/services/memoryService.js` |
| Memory Retrieval Service | `chat/services/memoryRetrievalService.js` |
| Flask Server | `OA_memory/scripts/server.py` |
| Preprocessing Script | `OA_memory/scripts/preprocess_events.py` |
| LLM Retrieval Function | `OA_memory/exp_with_memory.py` |
| Event Store Output | `OA_memory/event_store.json` |
| Main App | `chat/app.js` |
| UI Template | `chat/index.html` |

## Performance Notes

- Embedding generation takes time (depends on number of messages)
- Retrieval is fast once embeddings are computed
- LLM generation time depends on OpenRouter latency (~5-10 seconds typical)
- Event store is cached in memory after first load

## Next Steps

1. Test the "Process Memory" workflow with your chat history
2. Test @memory mentions with various queries
3. Monitor server logs and browser console for issues
4. Adjust the memory retrieval parameters in `exp_with_memory.py` as needed
5. Consider adding persistent token tracking for usage monitoring

## Advanced: Server Configuration

The Flask server can be customized by setting environment variables:

```bash
# Change server port (default: 5555)
export MEMORY_SERVER_PORT=8000

# Enable debug mode (not recommended for production)
export FLASK_ENV=development
```

## Architecture Diagram

```
Browser (FastChat)
├── Chat Input
│   ├── @memory detection → MentionService → Show Popup
│   └── Process Memory button → MemoryService → Send to server
│
├── IndexedDB
│   └── Chat history (sessions + messages)
│
└── Local Server (Flask @ localhost:5555)
    ├── /health - Health check
    ├── /process-memory - Preprocess chat history → embeddings
    ├── /memory-status - Check event store
    └── /retrieve-memory - Retrieve memories + generate LLM response
        ├── Embedding generation (Qwen3)
        ├── Similarity search
        └── LLM generation (OpenRouter)
```
