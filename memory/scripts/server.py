"""
Local server that accepts chat history from the browser and processes it.

This server provides an endpoint for the FastChat UI to send chat history
directly from IndexedDB, then runs the preprocessing pipeline to generate
an event store with embeddings.
"""

import json
from datetime import datetime
import logging
import os
import sys
import tempfile
from pathlib import Path

from flask import Flask, request, jsonify
from flask_cors import CORS

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from scripts.preprocess_events import EventPreprocessor
from exp_with_memory import llm_generate_response, personalize_prompt
from config import MemoryConfig
from oa_agent.logging_utils import setup_logging

logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)  # Enable CORS for browser requests

# Path for the event store output
EVENT_STORE_PATH = os.path.join(
    os.path.dirname(__file__), '..', 'event_store.json'
)


@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({"status": "ok"})


@app.route('/process-memory', methods=['POST'])
def process_memory():
    """
    Accepts chat history JSON from the browser and processes it into an event store.
    
    Expected JSON format:
    {
        "data": {
            "chats": {
                "sessions": [...],
                "messages": [...]
            }
        }
    }
    """
    try:
        # Get chat history from request
        chat_data = request.json
        
        if not chat_data or 'data' not in chat_data:
            return jsonify({
                "success": False,
                "error": "Invalid data format. Expected {data: {chats: ...}}"
            }), 400
        
        logger.info("Received chat history from browser")
        
        # Create temporary file for the export
        with tempfile.NamedTemporaryFile(
            mode='w',
            suffix='.json',
            delete=False
        ) as tmp_file:
            json.dump(chat_data, tmp_file, indent=2)
            tmp_path = tmp_file.name
        
        try:
            # Initialize preprocessor with LLM summary enabled
            logger.info("Initializing preprocessor...")
            preprocessor = EventPreprocessor(
                embedding_model_path="Qwen/Qwen3-Embedding-0.6B",
                dedup=True,
                use_llm_summary=True,
            )
            
            # Load events from the temporary export file
            logger.info("Loading events from chat history...")
            events = preprocessor.load_events_from_export(tmp_path)
            
            # Embed all events
            logger.info(f"Embedding {len(events)} events...")
            events = preprocessor.embed_events(events)
            
            # Save to event store
            logger.info(f"Saving event store to {EVENT_STORE_PATH}...")
            preprocessor.save_events(events, EVENT_STORE_PATH)
            
            return jsonify({
                "success": True,
                "events_count": len(events),
                "output_path": EVENT_STORE_PATH,
                "message": f"Successfully processed {len(events)} chat sessions into memory store"
            })
        
        finally:
            # Clean up temporary file
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    
    except Exception as e:
        logger.error(f"Error processing memory: {e}", exc_info=True)
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/memory-status', methods=['GET'])
def memory_status():
    """Check if event store exists and return stats."""
    if os.path.exists(EVENT_STORE_PATH):
        try:
            with open(EVENT_STORE_PATH, 'r') as f:
                events = json.load(f)
            
            return jsonify({
                "exists": True,
                "events_count": len(events),
                "path": EVENT_STORE_PATH,
                "size_mb": os.path.getsize(EVENT_STORE_PATH) / (1024 * 1024)
            })
        except Exception as e:
            return jsonify({
                "exists": True,
                "error": f"Failed to read event store: {e}"
            })
    else:
        return jsonify({
            "exists": False,
            "path": EVENT_STORE_PATH
        })


@app.route('/retrieve-memory', methods=['POST'])
def retrieve_memory():
    """
    Retrieve relevant memories based on a query and generate LLM response.
    
    Expected JSON format:
    {
        "query": "user's question or query"
    }
    """
    try:
        data = request.json
        
        if not data or 'query' not in data:
            return jsonify({
                "success": False,
                "error": "Invalid data format. Expected {query: 'user query'}"
            }), 400
        
        user_query = data['query'].strip()
        
        if not user_query:
            return jsonify({
                "success": False,
                "error": "Query cannot be empty"
            }), 400
        
        # Check if event store exists
        if not os.path.exists(EVENT_STORE_PATH):
            return jsonify({
                "success": False,
                "error": f"Event store not found at {EVENT_STORE_PATH}. Please process memory first using the Process Memory button."
            }), 404
        
        logger.info(f"Retrieving memory for query: {user_query}")
        
        # Run LLM with retrieval
        config = MemoryConfig()
        personalized_prompt = personalize_prompt(config, user_query)
        response = llm_generate_response(config, personalized_prompt)
        
        # Also get the context for the frontend
        from oa_agent.retriever import ChatEventRetriever
        retriever = ChatEventRetriever(
            event_store_path=config.event_store_path,
            embedding_model_path=config.embedding_model_path,
            random_seed=config.event_random_seed,
            summary_max_chars=config.event_summary_max_chars,
        )
        
        # Retrieve top-k events
        retrieved = retriever.retrieve_top_k(user_query, top_k=config.event_top_k)
        context_block = retriever.format_events_for_prompt(retrieved, randomize=True)
        
        return jsonify({
            "success": True,
            "response": response,
            "context": context_block or "",
            "retrieved_count": len(retrieved),
            "message": "Memory retrieval and generation complete"
        })
    
    except Exception as e:
        logger.error(f"Error retrieving memory: {e}", exc_info=True)
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


@app.route('/retrieve-context', methods=['POST'])
def retrieve_context():
    """
    Retrieve relevant memories based on a query without LLM generation.
    Returns only the context for the user to include in their message.
    
    Expected JSON format:
    {
        "query": "user's question or query"
    }
    """
    try:
        data = request.json
        
        if not data or 'query' not in data:
            return jsonify({
                "success": False,
                "error": "Invalid data format. Expected {query: 'user query'}"
            }), 400
        
        user_query = data['query'].strip()
        
        if not user_query:
            return jsonify({
                "success": False,
                "error": "Query cannot be empty"
            }), 400
        
        # Check if event store exists
        if not os.path.exists(EVENT_STORE_PATH):
            return jsonify({
                "success": False,
                "error": f"Event store not found at {EVENT_STORE_PATH}. Please process memory first using the Process Memory button."
            }), 404
        
        logger.info(f"Retrieving context for query: {user_query}")
        
        # Initialize retriever
        from oa_agent.retriever import ChatEventRetriever
        config = MemoryConfig()
        retriever = ChatEventRetriever(
            event_store_path=config.event_store_path,
            embedding_model_path=config.embedding_model_path,
            random_seed=config.event_random_seed,
            summary_max_chars=config.event_summary_max_chars,
        )
        
        # Retrieve top-k events
        retrieved = retriever.retrieve_top_k(user_query, top_k=config.event_top_k)
        context_block = retriever.format_events_for_prompt(retrieved, randomize=True)
        
        return jsonify({
            "success": True,
            "context": context_block or "",
            "retrieved_count": len(retrieved),
            "message": "Context retrieved successfully"
        })
    
    except Exception as e:
        logger.error(f"Error retrieving context: {e}", exc_info=True)
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


def main():
    # Load config and set up logging first
    config = MemoryConfig()
    setup_logging(config, log_filename=f"memory_server_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")
    
    port = int(os.environ.get('MEMORY_SERVER_PORT', 5555))
    logger.info(f"Starting memory processing server on http://localhost:{port}")
    logger.info(f"Event store will be saved to: {EVENT_STORE_PATH}")
    logger.info(f"Log directory: {config.logdir}")
    app.run(host='0.0.0.0', port=port, debug=False)


if __name__ == '__main__':
    main()
