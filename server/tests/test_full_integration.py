"""
Full integration tests for Key Server with real Redis and Vault.
Requires Redis and Vault to be running.
"""

import os
import csv
import json
import asyncio
import tempfile
import subprocess
import pytest
from pathlib import Path
from loguru import logger

from backend.shared.clients import KeyClient


@pytest.mark.integration
class TestFullIntegration:
    """
    Full integration tests requiring Redis and Vault.
    
    Run with: pytest -m integration
    """
    
    @pytest.fixture(scope="class")
    def test_config_file(self):
        """Create temporary API keys config file."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False) as f:
            writer = csv.writer(f)
            writer.writerow(['provider', 'model', 'api_key'])
            # Add test keys
            writer.writerow(['openai', 'gpt-4', 'sk-test-openai-key-123'])
            writer.writerow(['anthropic', 'claude-3-sonnet', 'sk-ant-test-key-456'])
            config_file = f.name
        
        yield config_file
        
        # Cleanup
        os.unlink(config_file)
    
    @pytest.fixture(scope="class")
    async def socket_path(self):
        """Create temporary socket path."""
        with tempfile.NamedTemporaryFile(delete=False) as f:
            socket_path = f.name + ".sock"
        
        # Clean up any existing socket
        if os.path.exists(socket_path):
            os.unlink(socket_path)
            
        yield socket_path
        
        # Cleanup
        if os.path.exists(socket_path):
            os.unlink(socket_path)
    
    @pytest.fixture(scope="class")
    async def running_key_server(self, socket_path, test_config_file):
        """Start real Key Server with Redis and Vault."""
        
        # Set environment variables
        original_env = {}
        test_env = {
            "KEY_SERVER_SOCKET": socket_path,
            "KEY_CONFIG_FILE": test_config_file,
            "KEY_SERVER_REDIS_URL": os.getenv("TEST_KEY_SERVER_REDIS_URL", "redis://localhost:6379/2"),  # Use separate test DB for key server
            "VAULT_ADDR": os.getenv("TEST_VAULT_ADDR", "http://localhost:8200"),
            "VAULT_TOKEN": os.getenv("TEST_VAULT_TOKEN", "dev-token")
        }
        
        for key, value in test_env.items():
            original_env[key] = os.getenv(key)
            os.environ[key] = value
        
        try:
            # Start server in separate subprocess to avoid event loop conflicts
            import subprocess
            
            env = os.environ.copy()
            env.update(test_env)
            
            logger.info(f"Starting server subprocess with socket: {socket_path}")
            server_process = subprocess.Popen(
                ["python", "-m", "key_server"],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True
            )
            
            # Store process for cleanup
            server = server_process
            
            # Wait specifically for socket file to exist and be ready
            import time
            timeout = 15.0
            start_time = time.time()
            while not os.path.exists(socket_path) and (time.time() - start_time) < timeout:
                await asyncio.sleep(0.1)
            
            if not os.path.exists(socket_path):
                raise Exception(f"Socket file not created after {timeout}s: {socket_path}")
            
            logger.info(f"Socket file created: {socket_path}")
            
            # Wait for server to actually be ready by testing health check
            max_retries = 50  # 5 seconds of retries
            for attempt in range(max_retries):
                try:
                    test_client = KeyClient(socket_path)
                    healthy = await asyncio.wait_for(test_client.health_check(), timeout=1.0)
                    if healthy:
                        logger.info("Server health check passed - server is ready")
                        break
                    else:
                        logger.debug(f"Health check failed, attempt {attempt + 1}/{max_retries}")
                except Exception as e:
                    logger.debug(f"Connection attempt {attempt + 1}/{max_retries} failed: {e}")
                
                await asyncio.sleep(0.1)
            else:
                raise Exception(f"Server not accepting connections after {max_retries} attempts")
            
            yield server
            
            # Cleanup
            logger.info("Stopping server subprocess...")
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    logger.warning("Server didn't terminate, killing...")
                    server.kill()
                    server.wait()
            
            # Force cleanup socket if it still exists
            if os.path.exists(socket_path):
                try:
                    os.unlink(socket_path)
                    logger.info(f"Cleaned up socket file: {socket_path}")
                except OSError:
                    pass
                
        finally:
            # Restore environment
            for key, value in original_env.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
    
    @pytest.mark.asyncio
    async def test_session_key_selection(self, socket_path, running_key_server):
        """Test key selection using session-based API."""
        
        client = KeyClient(socket_path)
        
        # Test 1: Select keys for OpenAI and Anthropic models
        selected_keys = await client.select_keys_for_session(
            session_id="test-session-1001",
            user_id=1001,
            models=["openai/gpt-4", "anthropic/claude-3-sonnet"],
            count_per_model=1
        )
        
        assert selected_keys is not None
        assert len(selected_keys) == 2
        
        # Check OpenAI key
        openai_key = next((k for k in selected_keys if k['provider'] == 'openai'), None)
        assert openai_key is not None
        assert openai_key['model'] == 'gpt-4'
        assert openai_key['api_key'].startswith("sk-test-openai-key-")
        print(f"Retrieved OpenAI key: {openai_key['api_key']}")
        
        # Check Anthropic key
        anthropic_key = next((k for k in selected_keys if k['provider'] == 'anthropic'), None)
        assert anthropic_key is not None
        assert anthropic_key['model'] == 'claude-3-sonnet'
        assert anthropic_key['api_key'].startswith("sk-ant-test-key-")
        print(f"Retrieved Anthropic key: {anthropic_key['api_key']}")
    
    @pytest.mark.asyncio
    async def test_session_management(self, socket_path, running_key_server):
        """Test session-based key management."""
        
        client = KeyClient(socket_path)
        session_id = "test-session-2001"
        
        # Select keys for session
        selected_keys = await client.select_keys_for_session(
            session_id=session_id,
            user_id=2001,
            models=["openai/gpt-4"],
            count_per_model=2  # Get 2 keys for redundancy
        )
        
        assert selected_keys is not None
        assert len(selected_keys) == 2
        
        for key in selected_keys:
            assert key['provider'] == 'openai'
            assert key['model'] == 'gpt-4'
            assert key['api_key'].startswith("sk-test-openai-key-")
        
        print(f"Session {session_id} selected {len(selected_keys)} keys")
        
        # Release session
        success = await client.release_key(session_id)
        assert success is True
    
    @pytest.mark.asyncio
    async def test_nonexistent_provider(self, socket_path, running_key_server):
        """Test request for non-existent provider/model."""
        
        client = KeyClient(socket_path)
        
        selected_keys = await client.select_keys_for_session(
            session_id="test-session-3001",
            user_id=3001,
            models=["nonexistent/invalid"],
            count_per_model=1
        )
        
        assert selected_keys is None or len(selected_keys) == 0
    
    @pytest.mark.asyncio
    async def test_concurrent_requests(self, socket_path, running_key_server):
        """Test concurrent key selection requests."""
        
        client = KeyClient(socket_path)
        
        # Create multiple concurrent requests
        tasks = []
        for i in range(5):
            task = client.select_keys_for_session(
                session_id=f"test-session-{4000 + i}",
                user_id=4000 + i,
                models=["openai/gpt-4"],
                count_per_model=1
            )
            tasks.append(task)
        
        # Wait for all requests
        results = await asyncio.gather(*tasks)
        
        # All should succeed
        for i, selected_keys in enumerate(results):
            assert selected_keys is not None, f"Request {i} failed"
            assert len(selected_keys) == 1
            assert selected_keys[0]['api_key'].startswith("sk-test-openai-key-")
        
        print(f"Concurrent requests completed: {len(results)} sessions with keys")


@pytest.mark.unit  
class TestUnitTests:
    """Fast unit tests that don't require external services."""
    
    @pytest.mark.asyncio
    async def test_client_socket_error_handling(self):
        """Test client behavior with socket errors."""
        client = KeyClient("/nonexistent/path/socket.sock")
        
        selected_keys = await client.select_keys_for_session(
            session_id="test-session-9999",
            user_id=9999,
            models=["test/test"],
            count_per_model=1
        )
        assert selected_keys is None
        
        result = await client.release_key("test-session-9999")
        assert result is False


if __name__ == "__main__":
    # Run unit tests by default
    pytest.main([__file__, "-m", "unit", "-v"])
    
    # To run integration tests:
    # pytest test_full_integration.py -m integration -v 