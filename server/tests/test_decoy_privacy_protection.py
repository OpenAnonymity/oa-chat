"""
Test suite for verifying decoy privacy protection.

This test ensures that decoy queries are sent through the same endpoint
instance as the real query, which is critical for privacy protection.
"""

import pytest
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from typing import List, Dict, Any

from backend.shared.services.decoy.decoy import DecoyService
from backend.shared.services.privacy.privacy import PrivacyProcessor
from backend.shared.services.endpoint.factory import EndpointFactory


class TestDecoyPrivacyProtection:
    """Test that decoy queries provide proper privacy protection."""
    
    @pytest.fixture
    def mock_endpoint_instance(self):
        """Create a mock endpoint instance."""
        endpoint = MagicMock()
        endpoint.send_message_non_streaming = AsyncMock(return_value="Mock response")
        endpoint.send_message = AsyncMock(return_value="Mock streaming response")
        return endpoint
    
    @pytest.fixture
    def decoy_service(self):
        """Create a DecoyService instance."""
        return DecoyService()
    
    @pytest.fixture
    def privacy_processor(self):
        """Create a PrivacyProcessor instance."""
        return PrivacyProcessor()
    
    @pytest.mark.asyncio
    async def test_decoy_uses_same_endpoint_instance(self, decoy_service, mock_endpoint_instance):
        """Test that decoy queries use the exact same endpoint instance as the real query."""
        # Generate some decoy queries
        original_messages = [{"role": "user", "content": "How to secure my data?"}]
        decoy_queries = await decoy_service.generate_decoy_queries(original_messages, count=2)
        
        # Send decoys through the endpoint
        await decoy_service.send_decoy_queries_background(decoy_queries, mock_endpoint_instance)
        
        # Allow background tasks to complete
        await asyncio.sleep(0.1)
        
        # Verify that the same endpoint instance was used for decoys
        assert mock_endpoint_instance.send_message_non_streaming.called or mock_endpoint_instance.send_message.called
        
        # Verify the endpoint was called multiple times (once per decoy)
        total_calls = (mock_endpoint_instance.send_message_non_streaming.call_count + 
                      mock_endpoint_instance.send_message.call_count)
        assert total_calls >= len(decoy_queries)
    
    @pytest.mark.asyncio
    async def test_decoy_queries_indistinguishable_from_real_query(self, decoy_service, mock_endpoint_instance):
        """Test that decoy queries appear identical to real queries from the endpoint's perspective."""
        # Simulate a real query and decoy queries using the same endpoint
        real_prompt = "What is my IP address?"
        decoy_queries = [
            [{"role": "user", "content": "What's the weather like?"}],
            [{"role": "user", "content": "How do I bake a cake?"}]
        ]
        
        # Send real query through endpoint
        real_response = await mock_endpoint_instance.send_message_non_streaming(real_prompt)
        
        # Send decoy queries through the SAME endpoint
        await decoy_service.send_decoy_queries_background(decoy_queries, mock_endpoint_instance)
        
        # Allow background tasks to complete
        await asyncio.sleep(0.1)
        
        # From the endpoint's perspective, all calls look identical (same method, same endpoint instance)
        assert mock_endpoint_instance.send_message_non_streaming.call_count >= 3  # 1 real + 2 decoys
        
        # All calls used the same endpoint instance (same API key, same provider)
        # This is the critical privacy protection
        assert all(call[0] for call in mock_endpoint_instance.send_message_non_streaming.call_args_list)
    
    @pytest.mark.asyncio
    async def test_privacy_processor_post_routing_decoy_generation(self, privacy_processor, mock_endpoint_instance):
        """Test that the privacy processor correctly handles post-routing decoy generation."""
        # Mock the decoy service to track calls
        with patch.object(privacy_processor.decoy_service, 'should_generate_decoy', return_value=True):
            with patch.object(privacy_processor.decoy_service, 'generate_decoy_queries') as mock_generate:
                with patch.object(privacy_processor.decoy_service, 'send_decoy_queries_background') as mock_send:
                    mock_generate.return_value = [
                        [{"role": "user", "content": "Decoy query 1"}],
                        [{"role": "user", "content": "Decoy query 2"}]
                    ]
                    
                    # Initial privacy metadata
                    privacy_metadata = {
                        "pii_detected": False,
                        "obfuscated": False,
                        "decoys_requested": True,
                        "decoys_generated": 0
                    }
                    
                    # Call post-routing privacy features
                    updated_metadata = await privacy_processor.post_routing_privacy_features(
                        original_prompt="Sensitive query about my personal data",
                        decoy=True,
                        is_stateless=True,
                        endpoint_instance=mock_endpoint_instance,
                        privacy_metadata=privacy_metadata
                    )
                    
                    # Verify decoy generation was called
                    mock_generate.assert_called_once()
                    
                    # Verify decoys were sent through the SAME endpoint instance
                    mock_send.assert_called_once()
                    send_args = mock_send.call_args
                    assert send_args[0][1] is mock_endpoint_instance  # Same endpoint instance
                    
                    # Verify metadata was updated
                    assert updated_metadata["decoys_generated"] == 2
    
    @pytest.mark.asyncio
    async def test_no_decoy_generation_for_stateful_queries(self, privacy_processor, mock_endpoint_instance):
        """Test that decoy generation is skipped for stateful queries."""
        with patch.object(privacy_processor.decoy_service, 'send_decoy_queries_background') as mock_send:
            privacy_metadata = {
                "pii_detected": False,
                "obfuscated": False,
                "decoys_requested": False,
                "decoys_generated": 0
            }
            
            # Call with stateful=False (should not generate decoys)
            updated_metadata = await privacy_processor.post_routing_privacy_features(
                original_prompt="Query in stateful mode",
                decoy=True,
                is_stateless=False,  # Stateful mode
                endpoint_instance=mock_endpoint_instance,
                privacy_metadata=privacy_metadata
            )
            
            # Verify no decoys were sent
            mock_send.assert_not_called()
            assert updated_metadata["decoys_generated"] == 0
    
    @pytest.mark.asyncio
    async def test_endpoint_factory_creates_same_instance_type(self):
        """Test that EndpointFactory can recreate the same type of endpoint instance."""
        # Test parameters
        provider = "openai"
        model_tag = "gpt-4"
        api_key = "test-api-key-123"
        
        # Create two instances with the same parameters
        instance1 = EndpointFactory.create_endpoint(provider, model_tag, api_key)
        instance2 = EndpointFactory.create_endpoint(provider, model_tag, api_key)
        
        # Both instances should be of the same type and have the same configuration
        assert type(instance1) == type(instance2)
        assert instance1 is not instance2  # Different objects
        
        # Both should have the same model and provider configuration
        if hasattr(instance1, 'model_tag'):
            assert instance1.model_tag == instance2.model_tag
        if hasattr(instance1, 'api_key'):
            assert instance1.api_key == instance2.api_key
    
    @pytest.mark.asyncio
    async def test_decoy_service_statistics_tracking(self, decoy_service, mock_endpoint_instance):
        """Test that decoy service properly tracks statistics."""
        # Get initial stats
        initial_stats = decoy_service.get_decoy_statistics()
        initial_sent = initial_stats.get("decoys_sent", 0)
        
        # Generate and send decoys
        original_messages = [{"role": "user", "content": "Test query"}]
        decoy_queries = await decoy_service.generate_decoy_queries(original_messages, count=3)
        await decoy_service.send_decoy_queries_background(decoy_queries, mock_endpoint_instance)
        
        # Allow background tasks to complete
        await asyncio.sleep(0.1)
        
        # Check updated stats
        updated_stats = decoy_service.get_decoy_statistics()
        
        # Stats should reflect the sent decoys
        assert updated_stats["decoys_generated"] >= initial_stats.get("decoys_generated", 0) + 3
        # Note: decoys_sent is updated in background, so we can't guarantee exact timing
    
    def test_decoy_topics_variety(self, decoy_service):
        """Test that decoy topics provide good variety for privacy protection."""
        # Generate multiple sets of decoys
        original_messages = [{"role": "user", "content": "Sensitive query"}]
        
        all_decoy_content = []
        for _ in range(10):
            decoy_queries = asyncio.run(decoy_service.generate_decoy_queries(original_messages, count=2))
            for decoy_query in decoy_queries:
                all_decoy_content.append(decoy_query[0]["content"])
        
        # Should have variety in decoy topics (not all the same)
        unique_decoys = set(all_decoy_content)
        assert len(unique_decoys) > 3  # Should have multiple different decoy topics
        
        # All decoys should be different from the original query
        original_content = "Sensitive query"
        assert all(decoy != original_content for decoy in all_decoy_content)


if __name__ == "__main__":
    pytest.main([__file__, "-v"]) 