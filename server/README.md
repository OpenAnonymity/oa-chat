# Backend Services

Privacy-focused LLM routing with **two microservices**: Key Server (gRPC) and Web Server (FastAPI).

## Architecture

**Key Server**: Secure API key management over Unix sockets
- HashiCorp Vault encryption for API keys
- Redis-based key allocation with intelligent routing
- Session isolation and usage tracking
- Zero network exposure (Unix socket only)

**Web Server**: FastAPI application with dual API design
- **Web API** (`/api/web/*`): React webapp interface
- **Direct API** (`/api/v1/*`): Programmatic access with JWT auth
- Privacy features: PII removal, obfuscation, decoy generation
- Connection pooling, no global state, per-request dependencies

## Quick Start

### Prerequisites
```bash
# Start Redis and Vault
docker-compose -f docker/docker-compose.dev.yml up -d

# Production: Full containerized deployment
docker-compose -f docker/docker-compose.prod.yml up -d --build

# Check services are running
docker-compose -f docker/docker-compose.dev.yml ps

# Test connections
redis-cli ping  # Should return "PONG"
curl -H "X-Vault-Token: dev-token" http://localhost:8200/v1/sys/health

# Stop services when done
docker-compose -f docker/docker-compose.dev.yml down
```

**Option B: Individual Docker Containers**
```bash
# Start Redis
docker run --name llmvpn-redis -p 6379:6379 -d redis:7-alpine

# Start Vault  
docker run --name llmvpn-vault -p 8200:8200 -d \
  --cap-add=IPC_LOCK \
  -e 'VAULT_DEV_ROOT_TOKEN_ID=dev-token' \
  -e 'VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200' \
  hashicorp/vault:1.15
```

### Install and Run
```bash
# Install dependencies
pip install -r requirements.txt
python run_services.py
```

This starts both services:
- **Key Server**: Unix socket at `/tmp/keyserver.sock`
- **Web Server**: HTTP at `http://localhost:8000`

## Manual Start (Development)

```bash
# Terminal 1 - Key Server
python -m key_server

# Terminal 2 - Web Server  
python -m backend.main
```

## Environment Configuration

```bash
# Key Server
export KEY_SERVER_SOCKET="/tmp/keyserver.sock"
export KEY_CONFIG_FILE="api_keys.csv"
export VAULT_ADDR="http://localhost:8200"
export VAULT_TOKEN="dev-token"
export KEY_SERVER_REDIS_URL="redis://localhost:6379/1"

# Web Server
export WEB_SERVER_REDIS_URL="redis://localhost:6379/0"
export WEB_SERVER_PORT="8000"
export PROVIDER_FILE="providers.yaml"
export WEB_SERVER_JWT_SECRET="your-secret-key"
```

## API Endpoints

### Web API (React Webapp)
```bash
POST /api/web/initialize-session    # Create new session
PUT  /api/web/session/models        # Update session models  
POST /api/web/generate              # Send messages with privacy features
GET  /api/web/session/{id}          # Get session info
```

### Direct API (Programmatic Access)
**Authentication**: Bearer JWT token required
```bash
POST /api/v1/stateless-query        # Independent queries (new endpoint each time)
POST /api/v1/stateful-query         # Conversation sessions (persistent endpoints)
```

### Shared Utilities
```bash
GET /api/providers                  # Available models and providers
GET /api/health                     # Health check with uptime
```

## Privacy Features

**Stateless Mode**: Maximum privacy
- New endpoint for each query
- Immediate endpoint release after response
- No conversation tracking

**Stateful Mode**: Session-based
- Persistent endpoint binding
- Conversation context preservation
- Session-based privacy controls

## Production Deployment

```bash
# Full containerized stack
docker-compose -f docker/docker-compose.prod.yml up -d --build

# Gunicorn for production (4+ workers recommended)
gunicorn backend.main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:8000
```

## Troubleshooting

```bash
# Check Redis (separate databases)
redis-cli -n 0 ping  # Web server
redis-cli -n 1 ping  # Key server

# Check Vault
curl http://localhost:8200/v1/sys/health

# Check services
curl http://localhost:8000/api/health
ls -la /tmp/keyserver.sock

# View logs
tail -f logs/keyserver.log
``` 