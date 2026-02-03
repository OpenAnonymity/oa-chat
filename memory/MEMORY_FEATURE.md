# Memory Processing Feature

This feature allows you to process your chat history stored in IndexedDB into an event store with embeddings that can be used for memory retrieval.

## Setup

1. **Install Python dependencies:**
   ```bash
   cd OA_memory
   pip install -r requirements.txt
   pip install -r requirements-server.txt
   ```

2. **Set up OpenRouter API key** (for LLM summaries):
   ```bash
   # Create .env file in OA_memory directory
   echo "OPENROUTER_API_KEY=your_key_here" > .env
   ```

3. **Start the memory processing server:**
   ```bash
   cd OA_memory/scripts
   python server.py
   ```
   
   The server will start on `http://localhost:5555`

## Usage

### From the UI

1. Make sure the memory processing server is running
2. In the chat input, type `@memory`
3. Click on "memory" in the popup
4. The system will:
   - Export your chat history from IndexedDB
   - Send it to the local processing server
   - Generate embeddings using Qwen3-Embedding-0.6B
   - Create summaries using LLM (via OpenRouter)
   - Save the event store to `OA_memory/event_store.json`

### From the Command Line

You can also process chat history manually:

1. **Export your chat history** from the UI (Settings → Export Chats)
2. **Run the preprocessing script:**
   ```bash
   cd OA_memory
   python scripts/preprocess_events.py \
     --export /path/to/exported_chats.json \
     --output event_store.json \
     --use-llm-summary \
     --dedup
   ```

## How It Works

1. **Chat Export**: The browser reads all sessions and messages from IndexedDB
2. **Server Processing**: The Flask server receives the data and:
   - Loads chat sessions
   - Groups messages by session
   - Generates LLM summaries of each conversation
   - Computes embeddings using a local transformer model
   - Saves everything to `event_store.json`
3. **Event Store**: The output file contains:
   - Session metadata (title, timestamps)
   - Conversation content
   - LLM-generated summaries
   - Pre-computed embeddings (ready for similarity search)

## Troubleshooting

**"Memory processing server is not running"**
- Make sure you started the server with `python OA_memory/scripts/server.py`
- Check that port 5555 is not in use by another application

**Server errors**
- Check the server terminal for error logs
- Ensure all dependencies are installed
- Verify your OpenRouter API key is set in `.env`

**CORS errors in browser**
- The server enables CORS by default
- If issues persist, check browser console for specific errors

## Architecture

```
Browser (IndexedDB)
    ↓
    Export chat history
    ↓
Flask Server (localhost:5555)
    ↓
    Load events → Generate summaries → Compute embeddings
    ↓
event_store.json
```

The event store can then be used by retrieval systems to provide context-aware memory for your AI assistant.
