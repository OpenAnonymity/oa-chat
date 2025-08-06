"""
Token counting service using tiktoken for accurate token estimation.
Supports multiple LLM providers with proper encoding selection.
"""

import tiktoken
from typing import Dict, Tuple, Optional
from loguru import logger


class TokenCounter:
    """Service for counting tokens across different LLM providers."""
    
    # Provider-specific model mappings to tiktoken encodings
    PROVIDER_ENCODINGS = {
        "OpenAI": {
            "gpt-4o": "o200k_base",
            "gpt-4o-mini": "o200k_base", 
            "gpt-4-turbo": "cl100k_base",
            "gpt-4": "cl100k_base",
            "gpt-3.5-turbo": "cl100k_base",
            "text-embedding-ada-002": "cl100k_base",
            "text-embedding-3-small": "cl100k_base",
            "text-embedding-3-large": "cl100k_base",
            "text-davinci-002": "p50k_base",
            "text-davinci-003": "p50k_base",
            "davinci": "r50k_base"
        },
        "Anthropic": {
            # Anthropic uses a similar tokenization to OpenAI's cl100k_base
            "claude-3-opus-20240229": "cl100k_base",
            "claude-3-sonnet-20240229": "cl100k_base", 
            "claude-3-haiku-20240307": "cl100k_base",
            "claude-3-5-sonnet-20240620": "cl100k_base",
            "claude-3-5-sonnet-20241022": "cl100k_base",
            "claude-3-5-haiku-20241022": "cl100k_base"
        },
        "Together": {
            # Most Together models use cl100k_base or similar
            "meta-llama/Llama-3-70b-chat": "cl100k_base",
            "meta-llama/Llama-3-8b-chat": "cl100k_base",
            "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": "cl100k_base",
            "mistralai/Mixtral-8x7B-Instruct-v0.1": "cl100k_base"
        },
        "Google": {
            # Google models use similar tokenization
            "gemini-pro": "cl100k_base",
            "gemini-1.5-pro": "cl100k_base",
            "gemini-1.5-flash": "cl100k_base"
        },
        "XAI": {
            # XAI models likely use similar tokenization to OpenAI
            "grok-beta": "cl100k_base",
            "grok-vision-beta": "cl100k_base"
        },
        "DeepSeek": {
            # DeepSeek models use similar tokenization
            "deepseek-chat": "cl100k_base",
            "deepseek-coder": "cl100k_base"
        }
    }
    
    def __init__(self):
        """Initialize the token counter with cached encodings."""
        self._encodings = {}
        logger.info("TokenCounter initialized")
    
    def _get_encoding(self, encoding_name: str) -> tiktoken.Encoding:
        """Get cached encoding instance."""
        if encoding_name not in self._encodings:
            try:
                self._encodings[encoding_name] = tiktoken.get_encoding(encoding_name)
                logger.debug(f"Loaded tiktoken encoding: {encoding_name}")
            except Exception as e:
                logger.error(f"Failed to load encoding {encoding_name}: {e}")
                # Fallback to cl100k_base
                self._encodings[encoding_name] = tiktoken.get_encoding("cl100k_base")
                logger.warning(f"Using cl100k_base fallback for {encoding_name}")
        
        return self._encodings[encoding_name]
    
    def _get_encoding_for_model(self, provider: str, model: str) -> str:
        """Get the appropriate encoding name for a provider/model combination."""
        provider_mappings = self.PROVIDER_ENCODINGS.get(provider, {})
        
        # Try exact model match first
        if model in provider_mappings:
            return provider_mappings[model]
        
        # Try partial matching for model families
        for model_pattern, encoding in provider_mappings.items():
            if model_pattern.lower() in model.lower() or model.lower() in model_pattern.lower():
                return encoding
        
        # Default fallback to cl100k_base (most compatible)
        logger.warning(f"No specific encoding found for {provider}:{model}, using cl100k_base")
        return "cl100k_base"
    
    def count_prompt_tokens(self, prompt: str, provider: str, model: str) -> int:
        """
        Count tokens in a prompt string.
        
        Args:
            prompt: The input prompt text
            provider: LLM provider name (e.g., "OpenAI", "Anthropic")
            model: Model name (e.g., "gpt-4o", "claude-3-sonnet")
            
        Returns:
            Number of tokens in the prompt
        """
        try:
            encoding_name = self._get_encoding_for_model(provider, model)
            encoding = self._get_encoding(encoding_name)
            
            token_count = len(encoding.encode(prompt))
            logger.debug(f"Prompt tokens for {provider}:{model}: {token_count}")
            return token_count
            
        except Exception as e:
            logger.error(f"Error counting prompt tokens for {provider}:{model}: {e}")
            # Rough fallback estimation (4 chars per token average)
            fallback_count = max(1, len(prompt) // 4)
            logger.warning(f"Using fallback token count: {fallback_count}")
            return fallback_count
    
    def count_completion_tokens(self, completion: str, provider: str, model: str) -> int:
        """
        Count tokens in a completion string.
        
        Args:
            completion: The output completion text
            provider: LLM provider name
            model: Model name
            
        Returns:
            Number of tokens in the completion
        """
        try:
            encoding_name = self._get_encoding_for_model(provider, model)
            encoding = self._get_encoding(encoding_name)
            
            token_count = len(encoding.encode(completion))
            logger.debug(f"Completion tokens for {provider}:{model}: {token_count}")
            return token_count
            
        except Exception as e:
            logger.error(f"Error counting completion tokens for {provider}:{model}: {e}")
            # Rough fallback estimation
            fallback_count = max(1, len(completion) // 4)
            logger.warning(f"Using fallback token count: {fallback_count}")
            return fallback_count
    
    def count_total_tokens(self, prompt: str, completion: str, provider: str, model: str) -> Tuple[int, int, int]:
        """
        Count tokens for both prompt and completion.
        
        Args:
            prompt: The input prompt text
            completion: The output completion text  
            provider: LLM provider name
            model: Model name
            
        Returns:
            Tuple of (prompt_tokens, completion_tokens, total_tokens)
        """
        prompt_tokens = self.count_prompt_tokens(prompt, provider, model)
        completion_tokens = self.count_completion_tokens(completion, provider, model)
        total_tokens = prompt_tokens + completion_tokens
        
        logger.debug(f"Token breakdown for {provider}:{model} - prompt: {prompt_tokens}, completion: {completion_tokens}, total: {total_tokens}")
        return prompt_tokens, completion_tokens, total_tokens
    
    def estimate_tokens_from_usage(self, usage_dict: Dict) -> int:
        """
        Extract total tokens from API response usage dict.
        
        Args:
            usage_dict: Usage dictionary from API response
            
        Returns:
            Total token count, or 0 if not available
        """
        if not usage_dict:
            return 0
            
        # Try different possible field names
        total_tokens = usage_dict.get('total_tokens', 0)
        if total_tokens > 0:
            return total_tokens
            
        # Calculate from prompt + completion if available
        prompt_tokens = usage_dict.get('prompt_tokens', usage_dict.get('input_tokens', 0))
        completion_tokens = usage_dict.get('completion_tokens', usage_dict.get('output_tokens', 0))
        
        return prompt_tokens + completion_tokens


# Global token counter instance
token_counter = TokenCounter() 