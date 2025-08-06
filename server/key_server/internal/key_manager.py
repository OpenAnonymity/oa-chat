"""
Key Manager - Key server management with key selection and retrieval.

TODO: will need some discussion here on if we should move all the key selection logic to the web server and just use the key server as a map to get the API keys.
"""

import uuid
import csv
import yaml
import asyncio
import random
import time
import hashlib
from pathlib import Path
from typing import Optional, Dict, List, Tuple, Set
from loguru import logger
import os

from .initializer import Initializer
from .vault_client import VaultSecretReader
from .redis_client import RedisClient


class KeyManager:
    """
    Responsibilities:
    1. Key allocation
    2. Key storage and retrieval
    3. Statistics collection
    """
    
    def __init__(self, initializer: Initializer):
        self.initializer = initializer
        self._vault_reader: Optional[VaultSecretReader] = None
        self._redis: Optional[RedisClient] = None
        self._start_time = time.time()
        self._stats = {
            "total_requests": 0,
            "successful_requests": 0,
            "failed_requests": 0
        }
        
        logger.info("KeyManager initialized")
    
    async def initialize(self) -> None:
        """Initialize all components."""
        try:
            self._vault_reader = VaultSecretReader(self.initializer.vault_client)
            self._redis = RedisClient(self.initializer.redis)
            
            logger.info("KeyManager components initialized successfully")
            
        except Exception as e:
            logger.error(f"KeyManager initialization failed: {str(e)}")
            raise
    
    # ==================== INTELLIGENT KEY SELECTION ====================
    
    #  For chatbot UI session, where currently we let user to pick proxy endpoint among a few selected ones.
    async def select_keys_for_session(
        self, 
        session_id: str, 
        user_id: int, 
        models: List[str],  # Now accepts "provider/model" strings
        count_per_model: int = 1
    ) -> List[Dict[str, any]]:
        """
        Intelligently select API keys for a session based on user history and usage patterns.
        
        Args:
            session_id: Session identifier
            user_id: User identifier for history tracking
            models: List of "provider/model" strings
            count_per_model: Number of keys to select per model
            
        Returns:
            List of selected key information with pre-generated endpoint IDs
        """
        try:
            logger.info(f"Selecting keys for session {session_id}, user {user_id}, models: {models}")
            selected_keys = []
            
            for model_string in models:
                # Parse "provider/model" string
                try:
                    if '/' not in model_string:
                        logger.warning(f"Invalid model format: {model_string}, expected 'provider/model'")
                        continue
                    
                    provider, model = model_string.split('/', 1)
                    provider = provider.strip()
                    model = model.strip()
                    
                    if not provider or not model:
                        logger.warning(f"Empty provider or model in: {model_string}")
                        continue
                        
                except Exception as e:
                    logger.warning(f"Error parsing model string {model_string}: {str(e)}")
                    continue
                
                # Get available keys for this provider:model
                available_keys = await self._redis.get_all_active_keys(provider, model)
                if not available_keys:
                    logger.warning(f"No keys available for {provider}:{model}")
                    continue
                
                # Select keys intelligently
                selected_for_model = await self._intelligent_key_selection(
                    session_id=session_id,
                    user_id=user_id,
                    provider=provider,
                    model=model,
                    available_keys=available_keys,
                    count=min(count_per_model, len(available_keys))
                )
                
                # For each selected key, get full details and generate endpoint ID
                for key_id in selected_for_model:
                    # Get API key from Vault
                    api_key = await self._get_api_key_from_vault(provider, model, key_id)
                    if not api_key:
                        logger.error(f"Failed to retrieve API key for {key_id}")
                        continue
                    
                    # Get usage stats
                    usage_stats = await self._redis.get_key_usage_stats(key_id)
                    
                    # Web server will generate endpoint ID - don't generate here
                    
                    # Determine status based on usage
                    status = self._determine_key_status(usage_stats["tokens_hour"])
                    
                    selected_keys.append({
                        "key_id": key_id,
                        "provider": provider,
                        "model": model,
                        "api_key": api_key,
                        # endpoint_id will be generated by web server
                        "tokens_hour": usage_stats["tokens_hour"],
                        "tokens_total": usage_stats["tokens_total"],
                        "status": status
                    })
            
            logger.info(f"Selected {len(selected_keys)} keys for session {session_id}")
            return selected_keys
            
        except Exception as e:
            logger.error(f"Error selecting keys for session: {str(e)}")
            return []
    
    async def _intelligent_key_selection(
        self,
        session_id: str,
        user_id: int,
        provider: str,
        model: str,
        available_keys: List[str],
        count: int
    ) -> List[str]:
        """
        Intelligently select keys based on multiple factors.
        
        This is a placeholder for more sophisticated selection logic that could include:
        - User key usage history analysis
        - Key rotation policies
        - Load balancing
        - Cost optimization
        - Rate limit avoidance
        """
        # For now, implement weighted selection based on current usage
        weighted_keys = []
        
        for key_id in available_keys:
            # Get current usage stats
            usage_stats = await self._redis.get_key_usage_stats(key_id)
            tokens_hour = usage_stats["tokens_hour"]
            
            # Calculate weight (lower usage = higher weight)
            if tokens_hour == 0:
                weight = 100.0  # Unused keys get highest weight
            elif tokens_hour < 1000:
                weight = 50.0   # Lightly used keys
            elif tokens_hour < 5000:
                weight = 20.0   # Moderately used keys
            else:
                weight = 5.0    # Heavily used keys
            
            # Check user history (placeholder for real implementation)
            # In production, this would check if user has used this key recently
            # and potentially reduce weight to encourage rotation
            
            weighted_keys.append({
                "key_id": key_id,
                "weight": weight,
                "tokens_hour": tokens_hour
            })
        
        # Sort by weight (descending) and tokens_hour (ascending)
        weighted_keys.sort(key=lambda x: (-x["weight"], x["tokens_hour"]))
        
        # Select top 'count' keys
        selected = [item["key_id"] for item in weighted_keys[:count]]
        
        # Update session weights for future routing
        for key_id in selected:
            await self._redis.set_key_weight(session_id, key_id, 100.0)
        
        logger.debug(f"Selected keys for {provider}:{model}: {selected}")
        return selected
    
    def _determine_key_status(self, tokens_hour: int) -> str:
        """Determine key status based on hourly usage."""
        if tokens_hour == 0:
            return "Available"
        elif tokens_hour < 1000:
            return "Standby"
        elif tokens_hour < 5000:
            return "Active"
        else:
            return "RateLimited"

    async def _get_api_key_from_vault(self, provider: str, model: str, key_id: str) -> Optional[str]:
        """Retrieve API key from Vault."""
        try:
            vault_path = f"llm/{provider}/{model}/{key_id}"
            api_key = await asyncio.get_event_loop().run_in_executor(
                None, 
                self._vault_reader.read_secret, 
                vault_path, 
                "api_key"
            )
            return api_key
        except Exception as e:
            logger.error(f"Error retrieving API key from Vault: {str(e)}")
            return None
    
    async def release_key(self, session_id: str) -> None:
        """Release any key allocated to a session."""
        try:
            await self._redis.reset_key_weights_for_session(session_id)
            logger.info(f"Released key for session: {session_id}")
        except Exception as e:
            logger.error(f"Error releasing key for session {session_id}: {str(e)}")
            raise
    
    # ==================== KEY STORAGE ====================
    
    async def ingest_keys_from_file(self, file_path: str) -> None:
        """Ingest API keys from config file and store them in Vault + Redis."""
        try:
            logger.info(f"Starting key ingestion from file: {file_path}")
            
            if not os.path.exists(file_path):
                raise FileNotFoundError(f"Key config file not found: {file_path}")
            
            # Parse file based on extension
            if file_path.endswith('.csv'):
                key_data = await self._parse_csv_keys(file_path)
            elif file_path.endswith(('.yaml', '.yml')):
                key_data = await self._parse_yaml_keys(file_path)
            else:
                raise ValueError(f"Unsupported file format: {file_path}")
            
            # Store keys and update Redis pools
            await self._store_keys_and_update_pools(key_data)
            
            logger.info(f"Successfully ingested keys from {file_path}")
            
        except Exception as e:
            logger.error(f"Error ingesting keys from {file_path}: {str(e)}")
            raise
    
    async def _parse_csv_keys(self, file_path: str) -> Dict[Tuple[str, str], List[str]]:
        """Parse API keys from CSV file."""
        stored_keys = {}
        
        with open(file_path, 'r') as file:
            reader = csv.DictReader(file)
            
            for row in reader:
                provider = row.get('provider', '').strip()
                model = row.get('model', '').strip()
                api_key = row.get('api_key', '').strip()
                
                if not all([provider, model, api_key]):
                    continue
                
                # Generate unique key ID and store in Vault
                key_id = str(uuid.uuid4())
                vault_path = f"llm/{provider}/{model}/{key_id}"
                secret_data = {"api_key": api_key}
                
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    self._vault_reader.write_secret,
                    vault_path,
                    secret_data
                )
                
                # Track stored keys
                pool_key = (provider, model)
                if pool_key not in stored_keys:
                    stored_keys[pool_key] = []
                stored_keys[pool_key].append(key_id)
        
        return stored_keys
    
    async def _parse_yaml_keys(self, file_path: str) -> Dict[Tuple[str, str], List[str]]:
        """Parse API keys from YAML file."""
        stored_keys = {}
        
        with open(file_path, 'r') as file:
            data = yaml.safe_load(file)
            
            for key_entry in data.get('keys', []):
                provider = key_entry.get('provider', '').strip()
                model = key_entry.get('model', '').strip()
                api_key = key_entry.get('api_key', '').strip()
                
                if not all([provider, model, api_key]):
                    continue
                
                # Generate unique key ID and store in Vault
                key_id = str(uuid.uuid4())
                vault_path = f"llm/{provider}/{model}/{key_id}"
                secret_data = {"api_key": api_key}
                
                await asyncio.get_event_loop().run_in_executor(
                    None,
                    self._vault_reader.write_secret,
                    vault_path,
                    secret_data
                )
                
                # Track stored keys
                pool_key = (provider, model)
                if pool_key not in stored_keys:
                    stored_keys[pool_key] = []
                stored_keys[pool_key].append(key_id)
        
        return stored_keys
    
    async def _store_keys_and_update_pools(self, key_data: Dict[Tuple[str, str], List[str]]) -> None:
        """Store keys in Redis pools."""
        try:
            # Clear existing pools first
            for (provider, model), key_ids in key_data.items():
                await self._redis.clear_key_pool(provider, model)
                
                # Add all keys to the pool
                for key_id in key_ids:
                    await self._redis.add_key_to_pool(provider, model, key_id)
                
                logger.info(f"Updated pool {provider}:{model} with {len(key_ids)} keys")
                
        except Exception as e:
            logger.error(f"Error updating Redis pools: {str(e)}")
            raise
    
    # ==================== STATISTICS ====================
    
    async def get_pool_stats(self) -> Dict[str, Dict[str, int]]:
        """Get basic pool statistics."""
        try:
            stats = {}
            
            # Get all pool keys
            all_keys = await self._redis.redis.keys("keys:*")
            
            for key in all_keys:
                key_str = key.decode() if isinstance(key, bytes) else key
                # Extract provider:model from "keys:provider:model"
                parts = key_str.split(":", 2)
                if len(parts) == 3:
                    provider, model = parts[1], parts[2]
                    pool_key = f"{provider}:{model}"
                    
                    # Count available keys
                    available_count = await self._redis.redis.scard(key_str)
                    stats[pool_key] = {"available": available_count}
            
            return stats
            
        except Exception as e:
            logger.error(f"Error getting pool stats: {str(e)}")
            return {}
    
    async def get_detailed_pool_stats(self) -> Dict[str, List[Dict]]:
        """Get detailed per-key statistics."""
        try:
            detailed_stats = {}
            
            # Get all pool keys
            all_keys = await self._redis.redis.keys("keys:*")
            
            for key in all_keys:
                key_str = key.decode() if isinstance(key, bytes) else key
                parts = key_str.split(":", 2)
                if len(parts) == 3:
                    provider, model = parts[1], parts[2]
                    pool_key = f"{provider}:{model}"
                    
                    # Get all key IDs in this pool
                    key_ids = await self._redis.get_all_active_keys(provider, model)
                    
                    # Get usage stats for each key
                    key_stats = []
                    for key_id in key_ids:
                        usage_stats = await self._redis.get_key_usage_stats(key_id)
                        key_stats.append({
                            "key_id": key_id,
                            "tokens_hour": usage_stats["tokens_hour"],
                            "tokens_total": usage_stats["tokens_total"],
                            "last_used": usage_stats["last_used"]
                        })
                    
                    detailed_stats[pool_key] = key_stats
            
            return detailed_stats
            
        except Exception as e:
            logger.error(f"Error getting detailed pool stats: {str(e)}")
            return {}
    
    async def get_runtime_stats(self) -> Dict[str, any]:
        """Get runtime statistics."""
        try:
            active_sessions = await self._redis.get_active_sessions()
            uptime = time.time() - self._start_time
            
            return {
                "total_requests": self._stats["total_requests"],
                "successful_requests": self._stats["successful_requests"],
                "failed_requests": self._stats["failed_requests"],
                "uptime_seconds": uptime,
                "active_sessions": len(active_sessions)
            }
            
        except Exception as e:
            logger.error(f"Error getting runtime stats: {str(e)}")
            return {}
    
    # ==================== TOKEN TRACKING ====================
    
    async def track_key_usage(self, key_id: str, tokens_used: int) -> None:
        """Track token usage for a specific key."""
        try:
            await self._redis.track_key_usage(key_id, tokens_used)
            logger.debug(f"Tracked {tokens_used} tokens for key {key_id}")
        except Exception as e:
            logger.error(f"Error tracking key usage: {str(e)}")
            raise 