#!/usr/bin/env python3
"""
Generate JWT tokens using the EXACT same secret as the OpenAnonymity server.
For testing purposes.
"""

import jwt
from datetime import datetime, timedelta, timezone

# EXACT same secret as used by the server (from config.py default)
SERVER_JWT_SECRET = "your-secret-key-change-in-production"
SERVER_JWT_ALGORITHM = "HS256"

def generate_server_compatible_token(user_id: int):
    """Generate a JWT token that matches the server's exact validation requirements."""
    
    # Create payload with the exact structure the server expects
    payload = {
        "sub": str(user_id),  # Server expects string user ID in "sub" claim
        "iat": datetime.now(timezone.utc),  # Issued at
        "exp": datetime.now(timezone.utc) + timedelta(hours=24)  # Expires in 24 hours
    }
    
    # Use EXACT same secret and algorithm as server
    token = jwt.encode(payload, SERVER_JWT_SECRET, algorithm=SERVER_JWT_ALGORITHM)
    
    return token

if __name__ == "__main__":
    print("🔐 OpenAnonymity JWT Token Generator")
    print("=" * 50)
    print(f"🔑 Using server secret: {SERVER_JWT_SECRET}")
    print(f"🔧 Algorithm: {SERVER_JWT_ALGORITHM}")
    print("")
    
    # Generate tokens for common test user IDs
    test_users = [1, 123, 12345]
    
    for user_id in test_users:
        token = generate_server_compatible_token(user_id)
        print(f"✅ User ID {user_id}:")
        print(f"   Token: {token}")
        print(f"   Header: -H 'Authorization: Bearer {token}'")
        print("")
    
    print("🧪 Test Command (User ID 123):")
    token_123 = generate_server_compatible_token(123)
    print(f"""curl -X POST http://localhost:8000/api/v1/stateless-query \\
  -H "Authorization: Bearer {token_123}" \\
  -H "Content-Type: application/json" \\
  -d '{{
    "messages": [{{"role": "user", "content": "Hello!}}],
    "models": ["openai/gpt-4o"],
    "pii_removal": false,
    "obfuscate": false,
    "decoy": false
  }}'""")
    
    print("\n📝 Notes:")
    print("- These tokens use the server's default secret")
    print("- Tokens expire in 24 hours")
    print("- User ID is extracted from 'sub' claim")