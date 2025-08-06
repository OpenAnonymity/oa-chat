"""
Shared Privacy Processor Service - Orchestrates privacy features processing logic.
Pure orchestration service - does NOT send messages.
Used by both Direct API and Web API processors to avoid code duplication.
"""

from typing import List, Dict, Optional, Any, Tuple
from loguru import logger
import uuid

from ..PI_removal import PIIRemovalService
from ..obfuscation import ObfuscationService
from ..decoy import DecoyService


class PrivacyProcessor:
    """
    Shared privacy processor that orchestrates PII removal, obfuscation, and decoy generation.
    Pure orchestration service - delegates message sending to QueryRouter.
    Used by both Direct API and Web API processors to avoid code duplication.
    """
    
    def __init__(
        self,
        pii_service: PIIRemovalService,
        obfuscation_service: ObfuscationService,
        decoy_service: DecoyService
    ):
        """
        Initialize privacy processor with required dependencies.
        
        Args:
            pii_service: PIIRemovalService instance for PII detection/removal
            obfuscation_service: ObfuscationService instance for message obfuscation
            decoy_service: DecoyService instance for decoy query generation
        """
        if pii_service is None:
            raise ValueError("pii_service is required")
        if obfuscation_service is None:
            raise ValueError("obfuscation_service is required")
        if decoy_service is None:
            raise ValueError("decoy_service is required")
        
        self.pii_service = pii_service
        self.obfuscation_service = obfuscation_service
        self.decoy_service = decoy_service
    
    async def process_request_privacy_features(
        self,
        messages: List[Dict[str, str]],
        pii_removal: bool,
        obfuscate: bool,
        decoy: bool,
        is_stateless: bool,
        session_id: Optional[str] = None
    ) -> Tuple[List[Dict[str, str]], Dict[str, Any]]:
        """
        Process a request through privacy features before sending to LLM.
        
        Args:
            messages: Original user messages in standard format
            pii_removal: Enable PII removal
            obfuscate: Enable obfuscation
            decoy: Enable decoy generation (flag only, actual generation handled by QueryRouter)
            is_stateless: Whether this is a stateless query
            session_id: Optional session ID for obfuscation mapping
            
        Returns:
            Tuple of (processed_messages, privacy_metadata)
        """
        processed_messages = [msg.copy() for msg in messages]  # Deep copy to avoid modifying original
        
        privacy_metadata = {
            "pii_detected": False,
            "obfuscated": False,
            "decoy_requested": decoy and is_stateless,
            "original_messages": messages  # Store full conversation for decoy generation
        }

        # 1. PII Removal
        if pii_removal:
            processed_messages, pii_detected = await self.pii_service.process_messages(processed_messages)
            privacy_metadata["pii_detected"] = pii_detected
            logger.debug(f"PII removal: detected={pii_detected}")
        
        # 2. Obfuscation
        if obfuscate:
            processed_messages = await self.obfuscation_service.obfuscate_messages(
                processed_messages, 
                session_id=session_id
            )
            privacy_metadata["obfuscated"] = True
            logger.debug("Message obfuscation completed")
        
        return processed_messages, privacy_metadata
    
    async def should_generate_decoys(
        self,
        messages: List[Dict[str, str]],
        decoy_requested: bool,
        is_stateless: bool
    ) -> bool:
        """
        Determine if decoy queries should be generated.
        
        Args:
            messages: Original user messages in standard format
            decoy_requested: Whether decoys were requested
            is_stateless: Whether this is a stateless query
            
        Returns:
            True if decoys should be generated
        """
        if not (decoy_requested and is_stateless):
            return False
        
        return await self.decoy_service.should_generate_decoy(messages, is_stateless=True)
    
    async def generate_decoy_queries(
        self,
        messages: List[Dict[str, str]],
        count: int = 2
    ) -> List[str]:
        """
        Generate decoy queries for privacy protection.
        
        Args:
            messages: Original user messages in standard format
            count: Number of decoy queries to generate
            
        Returns:
            List of decoy prompt strings
        """
        return await self.decoy_service.generate_decoy_queries(messages, count=count)
    
    async def process_response_privacy_features(
        self,
        response_content: str,
        obfuscate: bool,
        session_id: Optional[str] = None
    ) -> str:
        """
        Process response through privacy features after receiving from LLM.
        
        Args:
            response_content: Raw response content from LLM
            obfuscate: Whether obfuscation was enabled
            session_id: Optional session ID for obfuscation mapping
            
        Returns:
            Processed response content
        """
        processed_content = response_content
        
        # Deobfuscation
        if obfuscate:
            response_message = {"role": "assistant", "content": response_content}
            deobfuscated = await self.obfuscation_service.deobfuscate_response(
                response_message,
                session_id=session_id
            )
            processed_content = deobfuscated["content"]

        
        return processed_content
    
    def calculate_privacy_score(
        self,
        pii_removal: bool,
        obfuscate: bool,
        message_count: int = 1
    ) -> float:
        """Calculate privacy score based on enabled features and conversation length."""
        # TODO: Modify this, this is just a placeholder implementation

        base_score = 0.5  # Baseline
        
        if pii_removal:
            base_score += 0.2
        
        if obfuscate:
            base_score += 0.3
        
        # Adjust based on message count (more messages = slightly lower privacy)
        message_penalty = min(message_count * 0.01, 0.2)
        
        return max(0.0, min(1.0, base_score - message_penalty))
    
    def get_privacy_statistics(self) -> Dict[str, Any]:
        """Get combined privacy statistics from all services."""
        return {
            "pii_removal": self.pii_service.get_pii_statistics(),
            "obfuscation": self.obfuscation_service.get_obfuscation_statistics(),
            "decoy": self.decoy_service.get_decoy_statistics()
        } 