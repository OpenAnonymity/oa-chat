"""
Hash generation utilities.
"""

import hashlib
from typing import Optional

from .async_time import get_current_timestamp


async def generate_endpoint_id(
    provider: str,
    model: str,
    key_id: str,
    session_id: Optional[str] = None,
    length: int = 20
) -> str:
    """
    Generate a unique endpoint ID.
    
    Args:
        provider: Provider name
        model: Model identifier
        key_id: Key identifier
        session_id: Optional session ID for session-specific endpoints
        length: Length of the generated ID
        
    Returns:
        Unique endpoint ID
    """
    current_time = await get_current_timestamp()
    timestamp = str(int(current_time))
    
    # Use session_id first 8 chars as consistent randomness within session
    if session_id:
        session_salt = session_id[:8]
    else:
        session_salt = "global00"
    
    # Combine all components
    hash_input = f"{provider}:{model}:{key_id}:{timestamp}:{session_salt}".encode('utf-8')
    hash_hex = hashlib.sha256(hash_input).hexdigest()
    
    return hash_hex[:length]
