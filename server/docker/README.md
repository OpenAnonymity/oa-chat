# Docker Deployment

Containerized deployment for OpenAnonymity services.

## File Structure

```
docker/
├── docker-compose.dev.yml     # Development (Infrastructure only)
├── docker-compose.prod.yml    # Production (Full application stack)
├── Dockerfile.key-server      # Key Server container
├── Dockerfile.web-server      # Web Server container
├── env.example               # Environment template
└── redis.conf                # Redis configuration
```

## Development Mode

**Use Case**: Local development with services running natively
- Starts only **Redis** and **Vault** (infrastructure)
- Run Key Server and Web Server natively for easier debugging

```bash
# Start infrastructure
docker-compose -f docker/docker-compose.dev.yml up -d

# Verify services
redis-cli ping
curl -H "X-Vault-Token: dev-token" http://localhost:8200/v1/sys/health

# Run services locally
cd server
python run_services.py

# Stop infrastructure when done
docker-compose -f docker/docker-compose.dev.yml down
```

## Production Mode

**Use Case**: Full containerized deployment
- All services containerized with proper networking
- Production-ready configuration with health checks
- Persistent volumes for data

### Setup
```bash
# Configure environment
cp docker/env.example .env
# Edit .env with production values

# Prepare configuration
mkdir -p docker/config
cp api_keys.csv docker/config/
cp providers.yaml docker/config/
```

### Deploy
```bash
# Start full stack
docker-compose -f docker/docker-compose.prod.yml up -d --build

# Check all services
docker-compose -f docker/docker-compose.prod.yml ps

# View logs
docker-compose -f docker/docker-compose.prod.yml logs -f web-server
```

### Service Access
- **Web Server**: `http://localhost:8000`
- **API Documentation**: `http://localhost:8000/docs`
- **Vault UI**: `http://localhost:8200` (if enabled)
- **Redis**: `localhost:6379` (if exposed)

## Environment Configuration

**Example `.env` file:**
```bash
# Vault
VAULT_TOKEN=your-production-vault-token

# Redis
REDIS_PASSWORD=your-redis-password

# Web Server
WEB_SERVER_PORT=8000
WEB_SERVER_JWT_SECRET=your-jwt-secret-key
CORS_ORIGINS=https://yourdomain.com

# Key Server
KEY_CONFIG_FILE=/app/config/api_keys.csv
```

## Container Architecture

**Key Server Container:**
- Isolated gRPC service
- Vault and Redis connectivity
- Unix socket volume sharing
- Health checks enabled

**Web Server Container:**
- FastAPI application with Gunicorn
- Redis connection pooling
- Unix socket access to Key Server
- Multi-worker configuration for production

**Shared Volumes:**
- `key_server_socket`: Unix socket communication
- `config`: API keys and provider configuration
- `redis_data`, `vault_data`: Persistent storage

## Management Commands

### Health Checks
```bash
# Check all services
docker-compose -f docker/docker-compose.prod.yml ps

# Individual service health
curl http://localhost:8000/api/health
```

### Logs and Debugging
```bash
# Service logs
docker-compose -f docker/docker-compose.prod.yml logs key-server
docker-compose -f docker/docker-compose.prod.yml logs web-server

# Follow logs in real-time
docker-compose -f docker/docker-compose.prod.yml logs -f
```

### Updates and Restart
```bash
# Update services
docker-compose -f docker/docker-compose.prod.yml pull
docker-compose -f docker/docker-compose.prod.yml up -d --build

# Restart specific service
docker-compose -f docker/docker-compose.prod.yml restart web-server
```

## Troubleshooting

### Reset Environment
```bash
# WARNING: Destroys all data
docker-compose -f docker/docker-compose.prod.yml down -v
docker system prune -af --volumes

# Fresh start
docker-compose -f docker/docker-compose.prod.yml up -d --build
```

### Common Issues
```bash
# Check container logs
docker-compose logs web-server

# Verify socket communication
docker exec llmvpn-web-server ls -la /tmp/keyserver.sock

# Test Redis connectivity
docker exec llmvpn-redis redis-cli ping

# Check Vault status
curl http://localhost:8200/v1/sys/health
```

### Data Backup
```bash
# Backup Redis data
docker run --rm -v llm_vpn_redis_data:/data -v $(pwd):/backup \
  ubuntu tar czf /backup/redis-backup.tar.gz -C /data .

# Backup Vault data  
docker run --rm -v llm_vpn_vault_data:/data -v $(pwd):/backup \
  ubuntu tar czf /backup/vault-backup.tar.gz -C /data .
``` 