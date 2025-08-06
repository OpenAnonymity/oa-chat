#!/usr/bin/env python3
"""
Development script to run both Key Server and Web Server.
"""

import os
import sys
import asyncio
import subprocess
import signal
from pathlib import Path


def setup_environment():
    """Set up default environment variables for development."""
    env_defaults = {
        # Key Server (gRPC) - Uses Redis DB 1
        "VAULT_ADDR": "http://localhost:8200",
        "VAULT_TOKEN": "dev-token",
        "KEY_SERVER_REDIS_URL": "redis://localhost:6379/1",
        "KEY_SERVER_SOCKET": "/tmp/keyserver.sock",
        "KEY_CONFIG_FILE": "api_keys.csv",
        
        # Web Server - Uses Redis DB 0  
        "PROVIDER_FILE": "providers.yaml",
        "WEB_SERVER_REDIS_URL": "redis://localhost:6379/0",
        "WEB_SERVER_HOST": "0.0.0.0",
        "WEB_SERVER_PORT": "8000",
        "WEB_SERVER_JWT_SECRET": "your-secret-key-change-in-production",  # Explicit JWT secret for testing
        
        # Development flags
        "KEY_SERVER_RELOAD": "true",
        "WEB_SERVER_RELOAD": "true",
        
        # gRPC settings to suppress fork warnings and enable fork supporta
        "GRPC_ENABLE_FORK_SUPPORT": "true",
        "GRPC_POLL_STRATEGY": "poll",
        "GRPC_VERBOSITY": "ERROR",
    }
    
    for key, value in env_defaults.items():
        if key not in os.environ:
            os.environ[key] = value
            print(f"Set {key}={value}")


def check_prerequisites():
    """Check if required files exist."""
    # Detect if we're running from server/ directory or root directory
    current_dir = Path.cwd()
    if current_dir.name == "server":
        # Running from server/ directory
        providers_path = Path("backend/shared/providers")
        required_files = [
            "providers.yaml",
            "api_keys.csv"
        ]
    else:
        # Running from root directory  
        providers_path = Path("server/backend/shared/providers")
        required_files = [
            "server/providers.yaml",
            "server/api_keys.csv"
        ]
    
    # Check if providers directory is in the correct location
    if not providers_path.exists():
        print(f"❌ Providers directory not found at {providers_path}/")
        print(f"Make sure the providers directory exists at {providers_path.parent}/")
        return False
    
    missing_files = []
    for file_path in required_files:
        if not Path(file_path).exists():
            missing_files.append(file_path)
    
    if missing_files:
        print(f"❌ Missing required files: {', '.join(missing_files)}")
        print("Please create these files before running the services.")
        return False
    
    print("✅ All prerequisite files found")
    return True


def run_service(service_name, module_path):
    """Run a service using Python module execution."""
    print(f"Starting {service_name}...")
    
    # Set environment with proper Python path
    env = os.environ.copy()
    server_path = str(Path.cwd() / "server")
    env['PYTHONPATH'] = server_path
    
    return subprocess.Popen([
        sys.executable, "-m", module_path
    ], env=env, cwd="server")


def main():
    """Main function to orchestrate running both services."""
    print("🚀 LLMVPN Development Server")
    print("=" * 40)
    
    # Setup environment
    setup_environment()
    
    # Check prerequisites
    if not check_prerequisites():
        return 1
    
    # Create logs directory
    Path("logs").mkdir(exist_ok=True)
    
    processes = []
    
    try:
        # Start Key Server (gRPC)
        key_server = run_service("Key Server", "key_server")
        processes.append(("Key Server", key_server))
        
        # Wait a moment for Key Server to start
        asyncio.run(asyncio.sleep(2))
        
        # Start Web Server
        web_server = run_service("Web Server", "backend.main")
        processes.append(("Web Server", web_server))
        
        print("\n✅ Both services started!")
        print("\nEndpoints:")
        print(f"  Key Server:  unix:{os.environ.get('KEY_SERVER_SOCKET', '/tmp/keyserver.sock')} (gRPC)")
        print("  Web Server:  http://localhost:8000")
        print("  Swagger UI:  http://localhost:8000/docs")
        print("\n📂 Directory Structure:")
        print("  - key_server/     (Key management microservice)")
        print("  - backend/        (Main API server - refactored)")
        print("    ├── shared/     (Components used by both web & direct APIs)")
        print("    │   └── providers/  (LLM provider implementations)")
        print("    ├── web_api/    (React webapp interface)")
        print("    └── direct_api/ (Programmatic API access)")
        print("\n🧪 Testing:")
        print("  python test_integration.py")
        print("\nPress Ctrl+C to stop all services")
        
        # Wait for processes
        while True:
            for name, process in processes:
                if process.poll() is not None:
                    print(f"\n❌ {name} stopped unexpectedly")
                    return 1
            
            asyncio.run(asyncio.sleep(1))
            
    except KeyboardInterrupt:
        print("\n🛑 Stopping services...")
        
        # Terminate processes gracefully
        for name, process in processes:
            print(f"Stopping {name}...")
            process.terminate()
        
        # Wait for processes to stop
        for name, process in processes:
            try:
                process.wait(timeout=5)
                print(f"✅ {name} stopped")
            except subprocess.TimeoutExpired:
                print(f"🔪 Force killing {name}...")
                process.kill()
                process.wait()
        
        print("👋 All services stopped")
        return 0
    
    except Exception as e:
        print(f"\n❌ Error: {e}")
        
        # Cleanup processes
        for name, process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait()
        
        return 1


if __name__ == "__main__":
    sys.exit(main()) 