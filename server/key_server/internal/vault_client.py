"""
Vault Secret Reader for Key Server.
"""

import hvac
from typing import Optional
from loguru import logger


class VaultSecretReader:
    """
    Handles reading secrets from Vault KV v2 store.
    """
    
    def __init__(self, vault_client: hvac.Client):

        self.vault_client = vault_client
        logger.info("VaultSecretReader initialized")
    
    def read_secret(self, path: str, key: str = "api_key") -> str:
        """
        Read a secret from Vault KV v2.
        
        Args:
            path: Vault path (e.g., "llm/OpenAI/gpt-4o/key123")
            key: Key name within the secret (defaults to "api_key")
            
        Returns:
            The secret value as a string
            
        Raises:
            Exception: If secret cannot be read or doesn't exist
        """
        try:
            response = self.vault_client.secrets.kv.v2.read_secret_version(
                path=path,
                mount_point="secret"
            )
            
            if not response or 'data' not in response or 'data' not in response['data']:
                raise Exception(f"Secret not found at path: {path}")
            
            secret_data = response['data']['data']
            
            if key not in secret_data:
                raise Exception(f"Key '{key}' not found in secret at path: {path}")
            
            api_key = secret_data[key]
            
            return api_key
            
        except Exception as e:
            logger.error(f"Failed to read secret from {path}: {str(e)}")
            raise
    
    def write_secret(self, path: str, secret_data: dict) -> None:
        """
        Write a secret to Vault KV v2.
        
        Args:
            path: Vault path (e.g., "llm/OpenAI/gpt-4o/key123")
            secret_data: Dictionary containing the secret data
            
        Raises:
            Exception: If secret cannot be written
        """
        try:
            self.vault_client.secrets.kv.v2.create_or_update_secret(
                path=path,
                secret=secret_data,
                mount_point="secret"
            )
            
        except Exception as e:
            logger.error(f"Failed to write secret to {path}: {str(e)}")
            raise
    
    def delete_secret(self, path: str) -> None:
        """
        Delete a secret from Vault KV v2.
        
        Args:
            path: Vault path (e.g., "llm/OpenAI/gpt-4o/key123")
            
        Raises:
            Exception: If secret cannot be deleted
        """
        try:
            self.vault_client.secrets.kv.v2.delete_metadata_and_all_versions(
                path=path,
                mount_point="secret"
            )
            
        except Exception as e:
            logger.error(f"Failed to delete secret from {path}: {str(e)}")
            raise
    
    def secret_exists(self, path: str) -> bool:
        try:
            response = self.vault_client.secrets.kv.v2.read_secret_version(
                path=path,
                mount_point="secret"
            )
            return response is not None and 'data' in response
        except Exception:
            return False 