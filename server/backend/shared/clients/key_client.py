"""
Key Client for communicating with the Key Server microservice via gRPC over Unix Domain Sockets.
"""

import os

# Set gRPC environment variables before importing gRPC
# This ensures proper fork support and suppresses fork warnings
os.environ.setdefault("GRPC_ENABLE_FORK_SUPPORT", "true")
os.environ.setdefault("GRPC_POLL_STRATEGY", "poll")
os.environ.setdefault("GRPC_VERBOSITY", "ERROR")

import asyncio
from typing import Optional, Dict, Any, Tuple, List
from loguru import logger

import grpc
from grpc import aio

# Import generated protobuf messages and stub
from key_server import keyserver_pb2
from key_server import keyserver_pb2_grpc
from google.protobuf.empty_pb2 import Empty


class KeyClient:
    """gRPC client for communicating with the Key Server."""
    
    def __init__(self, socket_path: str = None):
        """
        Initialize with Key Server socket path.
        
        Args: socket_path: Path to Key Server Unix socket (default: /tmp/keyserver.sock)
        """
        self.socket_path = socket_path or os.getenv("KEY_SERVER_SOCKET", "/tmp/keyserver.sock")
        self.channel: Optional[aio.Channel] = None
        self.stub: Optional[keyserver_pb2_grpc.KeyServerStub] = None
        logger.info(f"gRPC KeyClient initialized for socket: {self.socket_path}")
    
    async def _get_stub(self):
        """Get or create gRPC stub."""
        if not self.stub:
            # Create channel to Unix domain socket
            self.channel = aio.insecure_channel(f"unix:{self.socket_path}")
            self.stub = keyserver_pb2_grpc.KeyServerStub(self.channel)
        
        return self.stub
    
    async def select_keys_for_session(
        self, 
        session_id: str, 
        user_id: int, 
        models: List[str],  # Now expects "provider/model" strings
        count_per_model: int = 1
    ) -> Optional[List[Dict[str, Any]]]:
        """Select API keys for a session using intelligent routing."""
        try:
            # Models are now simple strings, pass directly to protobuf
            request = keyserver_pb2.SelectKeysRequest(
                session_id=session_id,
                user_id=user_id,
                models=models,  # Direct assignment of string list
                count_per_model=count_per_model
            )
            
            stub = await self._get_stub()
            response = await stub.SelectKeysForSession(request, timeout=10.0)
            
            if response.success:
                # Convert protobuf response to dict format
                selected_keys = []
                for key in response.keys:
                    try:
                        selected_keys.append({
                            "key_id": key.key_id,
                            "provider": key.provider,
                            "model": key.model,
                            "api_key": key.api_key,
                            "tokens_hour": key.tokens_hour,
                            "tokens_total": key.tokens_total,
                            "status": key.status
                        })
                    except AttributeError as attr_err:
                        logger.error(f"AttributeError accessing protobuf key fields: {attr_err}")
                        logger.error(f"Available attributes: {dir(key)}")
                        raise
                
                logger.debug(f"Selected {len(selected_keys)} keys for session {session_id}")
                return selected_keys
            else:
                logger.warning(f"Failed to select keys for session {session_id}: {response.error}")
                return None
                
        except grpc.RpcError as e:
            logger.error(f"gRPC error selecting keys for session: {e.code()}: {e.details()}")
            logger.error(f"Request was: session_id={session_id}, user_id={user_id}, models={models}")
            return None
        except Exception as e:
            logger.error(f"Error selecting keys for session: {str(e)}")
            logger.error(f"Exception type: {type(e)}")
            logger.error(f"Request was: session_id={session_id}, user_id={user_id}, models={models}")
            import traceback
            logger.error(f"Full traceback: {traceback.format_exc()}")
            return None
    
    async def release_key(self, session_id: str) -> bool:
        """Release any key allocated to a session."""
        try:
            # Create protobuf request
            request = keyserver_pb2.ReleaseKeyRequest(session_id=session_id)
            
            # Make gRPC call
            stub = await self._get_stub()
            await stub.ReleaseKey(request, timeout=5.0)
            
            return True
                
        except grpc.RpcError as e:
            logger.error(f"gRPC error releasing key: {e.code()}: {e.details()}")
            return False
        except Exception as e:
            logger.error(f"Error releasing key: {str(e)}")
            return False
    
    async def reload_keys(self, file_path: str = None) -> Dict[str, Any]:
        """Request server to reload keys from file."""
        try:
            request = keyserver_pb2.ReloadKeysRequest(file_path=file_path or "")
            
            stub = await self._get_stub()
            response = await stub.ReloadKeys(request, timeout=30.0)
            
            result = {
                "success": response.success,
                "pools": dict(response.pools) if response.success else {}
            }
            
            if not response.success:
                result["error"] = response.error
            
            return result
                
        except grpc.RpcError as e:
            logger.error(f"gRPC error reloading keys: {e.code()}: {e.details()}")
            return {"success": False, "error": f"gRPC error: {e.details()}"}
        except Exception as e:
            logger.error(f"Error reloading keys: {str(e)}")
            return {"success": False, "error": str(e)}

    # TODO: will be replaced with better traffic montioring (matrics)
    async def get_stats(self) -> Dict[str, Any]:
        """
        Get server statistics.
        
        Returns:
            Response dictionary with pool and runtime stats.
            Only exposes available counts for security reasons.
        """
        try:
            request = Empty()
            
            stub = await self._get_stub()
            response = await stub.GetStats(request, timeout=3.0)
            
            # Convert protobuf response to dict
            pool_stats = {}
            for pool_key, stats in response.pool_stats.items():
                pool_stats[pool_key] = {
                    "available": stats.available
                }
            
            runtime_stats = {
                "total_requests": response.runtime_stats.total_requests,
                "successful_requests": response.runtime_stats.successful_requests,
                "failed_requests": response.runtime_stats.failed_requests,
                "uptime_seconds": response.runtime_stats.uptime_seconds
            }
            
            result = {
                "success": response.success,
                "pool_stats": pool_stats,
                "runtime_stats": runtime_stats
            }
            
            if not response.success:
                result["error"] = response.error
            
            return result
                
        except grpc.RpcError as e:
            logger.error(f"gRPC error getting stats: {e.code()}: {e.details()}")
            return {"success": False, "error": f"gRPC error: {e.details()}"}
        except Exception as e:
            logger.error(f"Error getting stats: {str(e)}")
            return {"success": False, "error": str(e)}
    
    async def health_check(self) -> bool:
        """Check if server is healthy."""
        try:
            request = Empty()
            
            stub = await self._get_stub()
            response = await stub.Health(request, timeout=5.0)
            
            return response.success and response.healthy
                
        except grpc.RpcError as e:
            logger.error(f"gRPC health check failed: {e.code()}: {e.details()}")
            return False
        except Exception as e:
            logger.error(f"Health check failed: {str(e)}")
            return False
    
    async def close(self) -> None:
        """Close gRPC channel to free resources."""
        if self.channel:
            await self.channel.close()
            logger.debug("KeyClient gRPC channel closed")
            self.channel = None
            self.stub = None
    
 