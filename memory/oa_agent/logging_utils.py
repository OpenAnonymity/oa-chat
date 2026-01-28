"""
Shared logging utilities for the memory system.
"""

import os
import logging
from config import MemoryConfig


def setup_logging(config: MemoryConfig, log_filename: str = "memory_server.log"):
    """
    Configure logging to both file and console using config's logdir.
    
    Args:
        config: MemoryConfig instance with logdir configured
        log_filename: Name of the log file (default: "memory_server.log")
    """
    # Create log directory if it doesn't exist
    os.makedirs(config.logdir, exist_ok=True)
    
    # Set up log file path
    log_file = os.path.join(config.logdir, log_filename)
    
    # Configure root logger with both file and console handlers
    root_logger = logging.getLogger()
    root_logger.setLevel(logging.INFO)
    
    # Remove existing handlers to avoid duplicates
    root_logger.handlers.clear()
    
    # File handler
    file_handler = logging.FileHandler(log_file, mode='a')
    file_handler.setLevel(logging.INFO)
    file_formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    file_handler.setFormatter(file_formatter)
    root_logger.addHandler(file_handler)
    
    # Console handler
    console_handler = logging.StreamHandler()
    console_handler.setLevel(logging.INFO)
    console_formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s"
    )
    console_handler.setFormatter(console_formatter)
    root_logger.addHandler(console_handler)
    
    logger = logging.getLogger(__name__)
    logger.info(f"Logging configured: file={log_file}, console enabled")
    return logger
