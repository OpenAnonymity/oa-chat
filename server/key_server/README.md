# Key Server

Secure gRPC microservice for intelligent API key management with encryption and load balancing.

## Architecture

- **Secure Storage**: API keys encrypted in HashiCorp Vault
- **Smart Allocation**: Usage-based key selection with load balancing
- **Session Isolation**: Per-session key tracking and management
- **Zero Network Exposure**: Unix domain sockets only
- **Redis State**: Key allocation state and usage statistics

## Quick Start

### Start Server
```bash
cd server
python -m key_server
```

**Server Details:**
- **Socket**: `/tmp/keyserver.sock`
- **Protocol**: gRPC over Unix domain socket
- **Storage**: Vault (encryption) + Redis (state)

### Client Usage
```python
from backend.shared.clients.key_client import KeyClient

client = KeyClient("/tmp/keyserver.sock")

# Intelligent key selection for session
keys = await client.select_keys_for_session(
    session_id="session_123",
    user_id=456,
    models=["openai/gpt-4o", "anthropic/claude-3-7-sonnet-20250219"],
    count_per_model=2  # Get 2 keys per model for redundancy
)

# Release session resources
await client.release_key("session_123")
```

## Configuration

### Environment Variables
```bash
export KEY_SERVER_SOCKET="/tmp/keyserver.sock"
export KEY_CONFIG_FILE="api_keys.csv"
export VAULT_ADDR="http://localhost:8200"
export VAULT_TOKEN="dev-token"
export KEY_SERVER_REDIS_URL="redis://localhost:6379/1"
```

### API Keys File
**Format**: `api_keys.csv`
```csv
provider,model,api_key
OpenAI,gpt-4o,sk-your-openai-key
Anthropic,claude-3-7-sonnet-20250219,sk-ant-your-key
DeepSeek,deepseek-reasoner,your-deepseek-key
XAI,grok-3-beta,your-xai-key
Together,meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo,your-together-key
```

Keys are automatically encrypted and stored in Vault on server start.

## Key Features

### Intelligent Key Selection
**Load Balancing Algorithm:**
- **Unused keys**: Highest priority (weight 100.0)
- **Light usage** (<1K tokens/hour): High priority (weight 50.0)  
- **Moderate usage** (<5K tokens/hour): Medium priority (weight 20.0)
- **Heavy usage** (≥5K tokens/hour): Low priority (weight 5.0)

**Selection Logic:**
1. Analyze current usage statistics
2. Apply weighted selection favoring less-used keys
3. Consider user rotation patterns (future enhancement)
4. Allocate keys with session tracking

### Session Management
- **Session Isolation**: Each session gets dedicated key allocation
- **Automatic Cleanup**: Expired sessions release keys automatically  
- **Usage Tracking**: Per-key token consumption monitoring
- **Status Reporting**: Real-time key availability and health

## gRPC API

### Primary Method: `SelectKeysForSession`
```protobuf
message SelectKeysRequest {
  string session_id = 1;
  int32 user_id = 2;
  repeated string models = 3;      // Format: "provider/model"
  int32 count_per_model = 4;       // Keys per model (default: 1)
}

message SelectKeysResponse {
  bool success = 1;
  repeated SelectedKey keys = 2;
  string error = 3;
}
```

### Management Methods
- `TrackUsage`: Record token consumption for billing/limits
- `GetStats`: Retrieve usage statistics and pool health
- `ReloadKeys`: Reload keys from configuration file
- `ReleaseKey`: Free session-allocated keys
- `Health`: Service health check

## Security Features

**Encryption**: All API keys encrypted at rest in Vault
**Access Control**: Unix socket permissions restrict access
**Audit Trail**: All key access logged with session tracking
**Rotation Ready**: Built for future key rotation support

## Troubleshooting

```bash
# Check server socket
ls -la /tmp/keyserver.sock

# Test Vault connection
curl -H "X-Vault-Token: $VAULT_TOKEN" $VAULT_ADDR/v1/sys/health

# Test Redis (database 1)
redis-cli -n 1 ping
redis-cli -n 1 keys "keys:*"  # Check key pools

# View server logs
tail -f logs/keyserver.log

# Test gRPC connection
python -c "
from backend.shared.clients.key_client import KeyClient
import asyncio
async def test():
    client = KeyClient('/tmp/keyserver.sock')
    health = await client.health_check()
    print(f'Health: {health}')
asyncio.run(test())
"
```