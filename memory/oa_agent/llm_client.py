import os
import json
import requests
import logging
import time
from typing import Optional

from request_key import (
    load_ticket_file,
    request_key as redeem_ticket_key,
    save_ticket_file,
)

class LLMClient:
    '''Client for DeepSeek server or OpenRouter via request_key tickets.'''
    def __init__(self, model_name: str = "qwen/qwen-2.5-7b-instruct", 
                       temperature: float = 0.7, 
                       max_tokens: int = 4096,
                       server_type: str = "openrouter",
                       system_prompt: str = "",
                       top_p: float = 0.95,
                       top_k: int = 50,
                       logger: logging.Logger = None,
                       max_retries: int = 3,
                       retry_backoff_base: float = 2.0):
        self.server_type = server_type.lower()
        self._openrouter_key: Optional[str] = None
        self.model_name = model_name
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.system_prompt = system_prompt
        self.top_p = top_p
        self.top_k = top_k
        self.max_retries = max_retries
        self.retry_backoff_base = retry_backoff_base
        if not logger:
            self.logger = logging.getLogger(__name__)
        else:
            self.logger = logger

    def generate(self, prompt: str) -> str:
        if self.server_type == "openrouter":
            return self.call_openrouter(prompt)
        else:
            return self.call_server(prompt, self.system_prompt)

    def _ensure_openrouter_key(self) -> str:
        """Get or fetch an OpenRouter key via inference tickets."""
        if self._openrouter_key:
            return self._openrouter_key

        ticket_file = os.environ.get("TICKET_FILE", "tickets.json")
        tier = os.environ.get("TICKET_TIER", "1x")
        name = os.environ.get("TICKET_NAME", "OA-Script-Key")

        raw_data, tickets, nav_path = load_ticket_file(ticket_file)
        count = int(str(tier).lower().replace("x", ""))
        result, remaining = redeem_ticket_key(tickets, count=count, name=name)
        save_ticket_file(ticket_file, raw_data, nav_path, remaining)

        self._openrouter_key = result["key"]
        if self.logger:
            self.logger.info(
                "Obtained OpenRouter key via tickets | consumed=%s remaining=%s",
                result.get("tickets_consumed"),
                len(remaining),
            )
        return self._openrouter_key

    def call_openrouter(self, prompt: str) -> str:
        api_key = self._ensure_openrouter_key()
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

        referer = os.environ.get("OPENROUTER_SITE_URL")
        site_title = os.environ.get("OPENROUTER_SITE_TITLE")
        if referer:
            headers["HTTP-Referer"] = referer
        if site_title:
            headers["X-Title"] = site_title

        messages = []
        if self.system_prompt:
            messages.append({"role": "system", "content": self.system_prompt})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "top_p": self.top_p,
        }

        last_exception = None
        for attempt in range(self.max_retries):
            try:
                r = requests.post(
                    url,
                    headers=headers,
                    data=json.dumps(payload),
                    timeout=180,
                )
                if not r.ok:
                    # Log body to help debug 4xx/5xx (model name, key, etc.)
                    body = r.text
                    if self.logger:
                        self.logger.error(
                            "OpenRouter request failed | status=%s body=%s", r.status_code, body
                        )
                    r.raise_for_status()

                data = r.json()

                if "choices" in data:
                    content = data["choices"][0]["message"].get("content", "")
                    if self.logger:
                        self.logger.info("OpenRouter response len=%s", len(content))
                    return content

                raise RuntimeError(f"Unknown OpenRouter response format: {data}")

            except (requests.exceptions.ReadTimeout,
                    requests.exceptions.Timeout,
                    requests.exceptions.ConnectionError) as e:
                last_exception = e
                if attempt < self.max_retries - 1:
                    wait_time = self.retry_backoff_base ** attempt
                    if self.logger:
                        self.logger.warning(
                            "OpenRouter request failed with %s: %s. Retrying in %.1fs (attempt %s/%s)",
                            type(e).__name__, str(e), wait_time, attempt + 1, self.max_retries,
                        )
                    time.sleep(wait_time)
                else:
                    if self.logger:
                        self.logger.error(
                            "OpenRouter request failed after %s attempts: %s: %s",
                            self.max_retries, type(e).__name__, str(e),
                        )
                    raise

        if last_exception:
            raise last_exception

    
    def call_server(self, prompt: str, system_prompt: str = None) -> str:
        url = os.environ.get("DS_API_URL", "http://<SERVER_IP>:<PORT>/v1/messages")
        headers = {
            "Content-Type": "application/json",
        }
        
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        
        payload = {
            "model": self.model_name,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "chat_template_kwargs": {"thinking": True}
        }

        # Retry logic with exponential backoff
        last_exception = None
        for attempt in range(self.max_retries):
            try:
                r = requests.post(url, headers=headers, json=payload, timeout=180)
                r.raise_for_status()
                data = r.json()

                # Anthropic-style
                if "content" in data:
                    return data["content"][0]["text"]

                # OpenAI-style
                if "choices" in data:
                    if self.logger is not None:
                        self.logger.info(f"LLM Client Response: {data['choices'][0]['message']['content']}")
                        self.logger.info(f"LLM Client Reasoning: {data['choices'][0]['message']['reasoning_content']}")
                    return data["choices"][0]["message"]["content"]

                raise RuntimeError(f"Unknown response format: {data}")
            
            except (requests.exceptions.ReadTimeout, 
                    requests.exceptions.Timeout,
                    requests.exceptions.ConnectionError) as e:
                last_exception = e
                if attempt < self.max_retries - 1:
                    wait_time = self.retry_backoff_base ** attempt
                    if self.logger is not None:
                        self.logger.warning(
                            f"Request failed with {type(e).__name__}: {str(e)}. "
                            f"Retrying in {wait_time:.1f} seconds (attempt {attempt + 1}/{self.max_retries})"
                        )
                    time.sleep(wait_time)
                else:
                    if self.logger is not None:
                        self.logger.error(
                            f"Request failed after {self.max_retries} attempts: {type(e).__name__}: {str(e)}"
                        )
                    raise
        
        # This should never be reached, but just in case
        if last_exception:
            raise last_exception
