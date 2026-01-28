#!/bin/bash

# Start the memory processing server
cd "$(dirname "$0")"
echo "Starting memory processing server on http://localhost:5555"
echo "Press Ctrl+C to stop"
echo ""
python scripts/server.py
