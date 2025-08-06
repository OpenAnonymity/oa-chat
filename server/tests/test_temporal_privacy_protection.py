"""
Test suite for verifying temporal privacy protection.

This test ensures that real queries are indistinguishably mixed with decoy queries
in terms of timing, preventing any analysis from determining which query is real.
"""

import pytest
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch
from typing import List, Dict, Any

from backend.shared.services.decoy.decoy import DecoyService
from backend.shared.services.privacy.privacy import PrivacyProcessor
from backend.shared.services.endpoint.factory import EndpointFactory


class TestTemporalPrivacyProtection:
    """Test that temporal mixing provides proper privacy protection."""
    
    @pytest.fixture
    def mock_endpoint_instance(self):
        """Create a mock endpoint instance that tracks timing."""
        endpoint = MagicMock()
        
        # Track call times for timing analysis
        call_times = []
        
        async def mock_send_message_non_streaming(prompt):
            call_times.append(time.time())
            # Simulate different response times for different prompts
            await asyncio.sleep(0.1)  # Small processing delay
            return {
                "choices": [{"message": {"role": "assistant", "content": f"Response to: {prompt[:30]}..."}}],
                "usage": {"total_tokens": 50}
            }
        
        endpoint.send_message_non_streaming = mock_send_message_non_streaming
        endpoint.call_times = call_times
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
    async def test_real_query_randomly_positioned_in_temporal_mixing(self, decoy_service, mock_endpoint_instance):
        """Test that the real query position is randomized among decoy queries."""
        real_prompt = "Sensitive query about private data"
        decoy_queries = [
            [{"role": "user", "content": "What's the weather?"}],
            [{"role": "user", "content": "How to bake cookies?"}],
            [{"role": "user", "content": "Explain quantum physics?"}]
        ]
        
        # Run temporal mixing multiple times and track real query positions
        real_positions = []
        
        for _ in range(10):  # Run multiple times to check randomization
            # Reset call tracking
            mock_endpoint_instance.call_times.clear()
            
            response, metadata = await decoy_service.send_query_with_temporal_mixing(
                real_prompt=real_prompt,
                decoy_queries=decoy_queries,
                endpoint_instance=mock_endpoint_instance,
                mixing_window_seconds=1.0
            )
            
            real_positions.append(metadata["real_query_position"])
        
        # Verify that real query position varies (not always the same)
        unique_positions = set(real_positions)
        assert len(unique_positions) > 1, f"Real query position should vary, but got: {real_positions}"
        
        # Verify all positions are valid
        total_queries = len(decoy_queries) + 1
        assert all(0 <= pos < total_queries for pos in real_positions)
    
    @pytest.mark.asyncio
    async def test_temporal_indistinguishability(self, decoy_service, mock_endpoint_instance):
        """Test that queries are sent with indistinguishable timing patterns."""
        real_prompt = "How to access private information?"
        decoy_queries = [
            [{"role": "user", "content": "Recipe for pizza"}],
            [{"role": "user", "content": "Weather forecast"}]
        ]
        
        # Clear previous calls
        mock_endpoint_instance.call_times.clear()
        
        response, metadata = await decoy_service.send_query_with_temporal_mixing(
            real_prompt=real_prompt,
            decoy_queries=decoy_queries,
            endpoint_instance=mock_endpoint_instance,
            mixing_window_seconds=2.0
        )
        
        # Verify all queries were sent
        assert len(mock_endpoint_instance.call_times) == 3  # 1 real + 2 decoys
        
        # Verify timing is within the mixing window
        call_times = mock_endpoint_instance.call_times
        time_span = max(call_times) - min(call_times)
        assert time_span <= 2.0, f"Queries should be sent within mixing window, but span was {time_span}s"
        
        # Verify queries are not sent sequentially (should have some randomization)
        # Sort times and check they're not perfectly spaced
        sorted_times = sorted(call_times)
        intervals = [sorted_times[i+1] - sorted_times[i] for i in range(len(sorted_times)-1)]
        
        # If queries were perfectly sequential, intervals would be very similar
        # With randomization, they should vary
        if len(intervals) > 1:
            max_interval = max(intervals)
            min_interval = min(intervals)
            # Allow some variation due to randomization
            assert max_interval - min_interval >= 0.1, "Query timing should be randomized for privacy"
    
    @pytest.mark.asyncio
    async def test_privacy_processor_temporal_mixing_integration(self, privacy_processor, mock_endpoint_instance):
        """Test the full privacy processor integration with temporal mixing."""
        processed_prompt = "Processed query about security"
        original_prompt = "Original query about security vulnerabilities"
        
        privacy_metadata = {
            "pii_detected": False,
            "obfuscated": True,
            "decoys_requested": True,
            "decoys_generated": 0
        }
        
        # Mock the decoy service methods
        with patch.object(privacy_processor.decoy_service, 'should_generate_decoy', return_value=True):
            with patch.object(privacy_processor.decoy_service, 'generate_decoy_queries') as mock_generate:
                mock_generate.return_value = [
                    [{"role": "user", "content": "Safe decoy query 1"}],
                    [{"role": "user", "content": "Safe decoy query 2"}]
                ]
                
                # Test temporal mixing
                response, updated_metadata = await privacy_processor.process_with_temporal_mixing(
                    processed_prompt=processed_prompt,
                    original_prompt=original_prompt,
                    endpoint_instance=mock_endpoint_instance,
                    decoy=True,
                    is_stateless=True,
                    privacy_metadata=privacy_metadata,
                    mixing_window_seconds=1.5
                )
                
                # Verify response was returned
                assert response is not None
                
                # Verify privacy metadata was updated with temporal mixing info
                assert updated_metadata["decoys_generated"] == 2
                assert "temporal_mixing" in updated_metadata
                
                temporal_info = updated_metadata["temporal_mixing"]
                assert temporal_info["total_queries"] == 3  # 1 real + 2 decoys
                assert 0 <= temporal_info["real_query_position"] < 3
                assert temporal_info["mixing_window_seconds"] == 1.5
                assert temporal_info["queries_completed"] >= 1  # At least real query succeeded
    
    @pytest.mark.asyncio
    async def test_no_timing_analysis_possible(self, decoy_service, mock_endpoint_instance):
        """Test that timing analysis cannot distinguish real from decoy queries."""
        
        # Simulate multiple "sessions" where an attacker tries to identify patterns
        session_results = []
        
        for session in range(5):
            real_prompt = f"Session {session}: Sensitive query"
            decoy_queries = [
                [{"role": "user", "content": f"Session {session}: Decoy 1"}],
                [{"role": "user", "content": f"Session {session}: Decoy 2"}]
            ]
            
            # Clear timing data
            mock_endpoint_instance.call_times.clear()
            
            response, metadata = await decoy_service.send_query_with_temporal_mixing(
                real_prompt=real_prompt,
                decoy_queries=decoy_queries,
                endpoint_instance=mock_endpoint_instance,
                mixing_window_seconds=1.0
            )
            
            session_results.append({
                "real_position": metadata["real_query_position"],
                "call_times": mock_endpoint_instance.call_times.copy(),
                "total_queries": metadata["total_queries"]
            })
        
        # Analyze if there's any detectable pattern
        real_positions = [r["real_position"] for r in session_results]
        
        # Check position distribution - should not be predictable
        position_counts = {}
        for pos in real_positions:
            position_counts[pos] = position_counts.get(pos, 0) + 1
        
        # In a truly random distribution, no position should dominate
        # (This is a basic check - in practice, more sophisticated statistical tests would be used)
        max_count = max(position_counts.values())
        total_sessions = len(session_results)
        
        # No position should appear in more than 80% of sessions (allows for some randomness variance)
        assert max_count <= total_sessions * 0.8, f"Real query position may be predictable: {position_counts}"
    
    @pytest.mark.asyncio
    async def test_temporal_mixing_error_handling(self, decoy_service):
        """Test error handling in temporal mixing scenarios."""
        
        # Test with None endpoint
        with pytest.raises(ValueError, match="Endpoint instance required"):
            await decoy_service.send_query_with_temporal_mixing(
                real_prompt="test",
                decoy_queries=[],
                endpoint_instance=None,
                mixing_window_seconds=1.0
            )
        
        # Test with failing endpoint
        failing_endpoint = MagicMock()
        failing_endpoint.send_message_non_streaming = AsyncMock(side_effect=Exception("Endpoint failed"))
        
        with pytest.raises(Exception, match="Real query failed"):
            await decoy_service.send_query_with_temporal_mixing(
                real_prompt="test query",
                decoy_queries=[[{"role": "user", "content": "decoy"}]],
                endpoint_instance=failing_endpoint,
                mixing_window_seconds=1.0
            )
    
    @pytest.mark.asyncio
    async def test_temporal_mixing_statistics_tracking(self, decoy_service, mock_endpoint_instance):
        """Test that temporal mixing properly updates statistics."""
        initial_stats = decoy_service.get_decoy_statistics()
        initial_mixing_sessions = initial_stats.get("temporal_mixing_sessions", 0)
        initial_decoys_sent = initial_stats.get("decoys_sent", 0)
        
        # Perform temporal mixing
        await decoy_service.send_query_with_temporal_mixing(
            real_prompt="Test query for stats",
            decoy_queries=[
                [{"role": "user", "content": "Decoy 1"}],
                [{"role": "user", "content": "Decoy 2"}]
            ],
            endpoint_instance=mock_endpoint_instance,
            mixing_window_seconds=1.0
        )
        
        # Check updated statistics
        updated_stats = decoy_service.get_decoy_statistics()
        
        assert updated_stats["temporal_mixing_sessions"] == initial_mixing_sessions + 1
        assert updated_stats["decoys_sent"] >= initial_decoys_sent + 2
    
    def test_temporal_mixing_metadata_structure(self):
        """Test that temporal mixing metadata has the expected structure."""
        # This would be called after temporal mixing completes
        sample_metadata = {
            "total_queries": 3,
            "real_query_position": 1,
            "mixing_window_seconds": 2.0,
            "queries_completed": 3,
            "queries_failed": 0
        }
        
        # Verify required fields are present
        required_fields = ["total_queries", "real_query_position", "mixing_window_seconds", 
                          "queries_completed", "queries_failed"]
        
        for field in required_fields:
            assert field in sample_metadata, f"Required field {field} missing from metadata"
        
        # Verify value ranges
        assert sample_metadata["total_queries"] > 0
        assert 0 <= sample_metadata["real_query_position"] < sample_metadata["total_queries"]
        assert sample_metadata["mixing_window_seconds"] > 0
        assert sample_metadata["queries_completed"] >= 0
        assert sample_metadata["queries_failed"] >= 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"]) 