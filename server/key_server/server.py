"""
Key Server - gRPC service over Unix Domain Sockets.
Simplified implementation using the new KeyManager.
"""

import os

# Set gRPC environment variables before importing gRPC
# This ensures proper fork support and suppresses fork warnings
os.environ.setdefault("GRPC_ENABLE_FORK_SUPPORT", "true")
os.environ.setdefault("GRPC_POLL_STRATEGY", "poll")
os.environ.setdefault("GRPC_VERBOSITY", "ERROR")

import asyncio
from typing import Optional
from loguru import logger

import grpc
from grpc import aio

# Import generated protobuf messages
from . import keyserver_pb2
from . import keyserver_pb2_grpc
from google.protobuf.empty_pb2 import Empty

from .internal.initializer import Initializer
from .internal.key_manager import KeyManager


class KeyServerServicer(keyserver_pb2_grpc.KeyServerServicer):
    """gRPC Key Server Service Implementation."""
    
    def __init__(self):
        self.key_manager: Optional[KeyManager] = None
        
    async def initialize(self):
        """Initialize the key server."""
        logger.info("Initializing gRPC Key Server...")
        
        initializer = Initializer()
        await initializer.initialize()
        
        self.key_manager = KeyManager(initializer)
        await self.key_manager.initialize()
        
        # Load keys if config exists
        key_file = os.getenv("KEY_CONFIG_FILE", "api_keys.csv")
        if os.path.exists(key_file):
            await self.key_manager.ingest_keys_from_file(key_file)
            logger.info(f"Loaded keys from {key_file}")
        
        logger.info("gRPC Key Server initialized")
    
    async def SelectKeysForSession(self, request, context):
        """Select API keys for a session based on intelligent routing."""
        try:
            if not self.key_manager:
                logger.error("Key manager not initialized")
                return keyserver_pb2.SelectKeysResponse(
                    success=False,
                    error="Key server not initialized"
                )
            
            # Models are now simple strings in "provider/model" format
            models = list(request.models)
            
            logger.info(f"SelectKeysForSession: session={request.session_id}, user={request.user_id}, models={models}")
            
            # Call key manager's intelligent selection
            selected_keys = await self.key_manager.select_keys_for_session(
                session_id=request.session_id,
                user_id=request.user_id,
                models=models,
                count_per_model=request.count_per_model or 1
            )
            
            # Convert to protobuf response
            response_keys = []
            for key_info in selected_keys:
                response_keys.append(keyserver_pb2.SelectedKey(
                    key_id=key_info["key_id"],
                    provider=key_info["provider"],
                    model=key_info["model"],
                    api_key=key_info["api_key"],
                    tokens_hour=key_info["tokens_hour"],
                    tokens_total=key_info["tokens_total"],
                    status=key_info["status"]
                ))
            
            logger.info(f"Selected {len(response_keys)} keys for session {request.session_id}")
            return keyserver_pb2.SelectKeysResponse(
                success=True,
                keys=response_keys
            )
            
        except Exception as e:
            logger.error(f"SelectKeysForSession error: {str(e)}")
            return keyserver_pb2.SelectKeysResponse(
                success=False,
                error=str(e)
            )

    async def ReleaseKey(self, request, context):
        """Release any key allocated to a session."""
        try:
            await self.key_manager.release_key(request.session_id)
            return Empty()
            
        except Exception as e:
            logger.error(f"ReleaseKey error: {e}")
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(str(e))
            return Empty()
    
    async def ReloadKeys(self, request, context):
        """Reload keys from configuration file."""
        try:
            file_path = request.file_path or os.getenv("KEY_CONFIG_FILE", "api_keys.csv")
            
            await self.key_manager.ingest_keys_from_file(file_path)
            stats = await self.key_manager.get_pool_stats()
            
            # Convert stats to protobuf format
            pools = {}
            for pool_key, pool_stats in stats.items():
                pools[pool_key] = pool_stats.get('available', 0)
            
            return keyserver_pb2.ReloadKeysResponse(
                success=True,
                pools=pools
            )
            
        except Exception as e:
            logger.error(f"ReloadKeys error: {e}")
            return keyserver_pb2.ReloadKeysResponse(
                success=False,
                error=str(e)
            )
    
    async def GetStats(self, request, context):
        """Get server statistics."""
        try:
            pool_stats = await self.key_manager.get_pool_stats()
            runtime_stats = await self.key_manager.get_runtime_stats()
            
            # Convert to protobuf format - only expose available counts
            pool_stats_pb = {}
            for pool_key, stats in pool_stats.items():
                pool_stats_pb[pool_key] = keyserver_pb2.PoolStats(
                    available=stats.get('available', 0)
                )
            
            runtime_stats_pb = keyserver_pb2.RuntimeStats(
                total_requests=runtime_stats.get('total_requests', 0),
                successful_requests=runtime_stats.get('successful_requests', 0),
                failed_requests=runtime_stats.get('failed_requests', 0),
                uptime_seconds=runtime_stats.get('uptime_seconds', 0.0)
            )
            
            return keyserver_pb2.StatsResponse(
                success=True,
                pool_stats=pool_stats_pb,
                runtime_stats=runtime_stats_pb
            )
            
        except Exception as e:
            logger.error(f"GetStats error: {e}")
            return keyserver_pb2.StatsResponse(
                success=False,
                error=str(e)
            )
    
    async def GetDetailedStats(self, request, context):
        """Get detailed per-key statistics."""
        try:
            detailed_stats = await self.key_manager.get_detailed_pool_stats()
            runtime_stats = await self.key_manager.get_runtime_stats()
            
            # Convert to protobuf format - expose individual key stats
            pool_detailed_stats_pb = {}
            for pool_key, key_list in detailed_stats.items():
                key_stats_pb = []
                for key_info in key_list:
                    key_stats_pb.append(keyserver_pb2.KeyStats(
                        key_id=key_info['key_id'],
                        tokens_hour=key_info['tokens_hour'],
                        tokens_total=key_info['tokens_total'],
                        last_used=key_info['last_used'] or 0
                    ))
                
                pool_detailed_stats_pb[pool_key] = keyserver_pb2.PoolKeyStats(
                    keys=key_stats_pb
                )
            
            runtime_stats_pb = keyserver_pb2.RuntimeStats(
                total_requests=runtime_stats.get('total_requests', 0),
                successful_requests=runtime_stats.get('successful_requests', 0),
                failed_requests=runtime_stats.get('failed_requests', 0),
                uptime_seconds=runtime_stats.get('uptime_seconds', 0.0)
            )
            
            return keyserver_pb2.DetailedStatsResponse(
                success=True,
                pool_detailed_stats=pool_detailed_stats_pb,
                runtime_stats=runtime_stats_pb
            )
            
        except Exception as e:
            logger.error(f"GetDetailedStats error: {e}")
            return keyserver_pb2.DetailedStatsResponse(
                success=False,
                error=str(e)
            )
    
    async def TrackUsage(self, request, context):
        """Track token usage for a specific key."""
        try:
            await self.key_manager.track_key_usage(request.key_id, request.tokens_used)
            
            return keyserver_pb2.TrackUsageResponse(success=True)
            
        except Exception as e:
            logger.error(f"TrackUsage error: {e}")
            return keyserver_pb2.TrackUsageResponse(
                success=False,
                error=str(e)
            )
    
    async def Health(self, request, context):
        """Health check endpoint."""
        try:
            # Simple health check - verify key manager is initialized
            healthy = self.key_manager is not None
            
            return keyserver_pb2.HealthResponse(
                success=True,
                healthy=healthy
            )
        except Exception as e:
            logger.error(f"Health check error: {e}")
            return keyserver_pb2.HealthResponse(
                success=False,
                healthy=False
            )


class KeyServer:
    """gRPC Key Server with Unix Domain Socket support."""
    
    def __init__(self):
        self.socket_path = os.getenv("KEY_SERVER_SOCKET", "/tmp/keyserver.sock")
        self.server: Optional[aio.Server] = None
        self.servicer = KeyServerServicer()
        
    async def initialize(self):
        """Initialize the server."""
        await self.servicer.initialize()
    

    async def serve(self):
        """Start the gRPC server."""
        logger.info(f"Starting gRPC server on unix:{self.socket_path}")
        
        # Remove existing socket
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        
        try:
            # Create gRPC server
            self.server = aio.server()
            
            # Add servicer to server
            keyserver_pb2_grpc.add_KeyServerServicer_to_server(self.servicer, self.server)
            
            # Listen on Unix domain socket
            listen_addr = f"unix:{self.socket_path}"
            self.server.add_insecure_port(listen_addr)
            
            logger.info(f"gRPC server listening on {listen_addr}")
            
            # Start server
            await self.server.start()
            await self.server.wait_for_termination()
            
        except Exception as e:
            logger.error(f"gRPC server error: {e}")
            raise
        finally:
            if os.path.exists(self.socket_path):
                os.unlink(self.socket_path)
    
    async def stop(self):
        """Stop the server."""
        if self.server:
            await self.server.stop(grace=5.0)


async def main():
    """Run the server."""
    logger.add("logs/keyserver.log", rotation="1 day", retention="7 days")
    
    server = KeyServer()
    await server.initialize()
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main()) 