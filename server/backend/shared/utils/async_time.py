"""
Async-safe time utilities.
Replaces synchronous time operations that can block the event loop.
"""

import asyncio
from datetime import datetime, timezone
from typing import Optional


async def get_current_timestamp() -> float:
    """
    Get current UTC timestamp asynchronously.
    
    Returns:
        Current timestamp as float (seconds since epoch)
    """
    # Use loop time for high precision and async safety
    loop = asyncio.get_event_loop()
    return loop.time()


async def get_utc_now() -> datetime:
    """
    Get current UTC datetime asynchronously.
    
    Returns:
        Current UTC datetime object
    """
    return datetime.now(timezone.utc)


async def get_hour_bucket() -> str:
    """
    Get current hour bucket for session hashing.
    
    Returns:
        String representation of current hour timestamp
    """
    now = await get_utc_now()
    hour_timestamp = int(now.timestamp() // 3600)
    return str(hour_timestamp)


async def get_iso_timestamp() -> str:
    """
    Get current UTC timestamp in ISO format.
    
    Returns:
        ISO formatted timestamp string
    """
    now = await get_utc_now()
    return now.isoformat()


async def sleep_random(min_seconds: float, max_seconds: float) -> None:
    """
    Sleep for a random duration between min and max seconds.
    
    Args:
        min_seconds: Minimum sleep duration
        max_seconds: Maximum sleep duration
        
    Raises:
        ValueError: If min_seconds > max_seconds or either is negative
    """
    if min_seconds < 0 or max_seconds < 0:
        raise ValueError("Sleep duration cannot be negative")
    if min_seconds > max_seconds:
        raise ValueError("min_seconds cannot be greater than max_seconds")
    
    # Use secrets for cryptographically secure randomness
    import secrets
    
    # Generate random float in range [0, 1)
    random_float = secrets.randbits(53) / (1 << 53)
    
    # Scale to desired range
    sleep_duration = min_seconds + random_float * (max_seconds - min_seconds)
    
    await asyncio.sleep(sleep_duration)


async def timeout_after(seconds: float, coro):
    """
    Execute a coroutine with a timeout.
    
    Args:
        seconds: Timeout duration in seconds
        coro: Coroutine to execute
        
    Returns:
        Result of the coroutine
        
    Raises:
        asyncio.TimeoutError: If the coroutine doesn't complete within the timeout
    """
    return await asyncio.wait_for(coro, timeout=seconds)


async def measure_execution_time(coro):
    """
    Measure the execution time of a coroutine.
    
    Args:
        coro: Coroutine to measure
        
    Returns:
        Tuple of (result, execution_time_seconds)
    """
    start_time = await get_current_timestamp()
    result = await coro
    end_time = await get_current_timestamp()
    
    execution_time = end_time - start_time
    return result, execution_time


async def schedule_delayed_execution(delay_seconds: float, coro):
    """
    Schedule a coroutine to execute after a delay.
    
    Args:
        delay_seconds: Delay before execution
        coro: Coroutine to execute
        
    Returns:
        Task object for the scheduled execution
    """
    async def delayed_execution():
        await asyncio.sleep(delay_seconds)
        return await coro
    
    return asyncio.create_task(delayed_execution())


async def batch_with_delays(coroutines: list, delay_between: float):
    """
    Execute coroutines in sequence with delays between them.
    
    Args:
        coroutines: List of coroutines to execute
        delay_between: Delay between executions in seconds
        
    Returns:
        List of results from all coroutines
    """
    results = []
    
    for i, coro in enumerate(coroutines):
        if i > 0:  # Add delay before all but the first coroutine
            await asyncio.sleep(delay_between)
        
        result = await coro
        results.append(result)
    
    return results


async def get_elapsed_time(start_timestamp: float) -> float:
    """
    Get elapsed time since a start timestamp.
    
    Args:
        start_timestamp: Starting timestamp from get_current_timestamp()
        
    Returns:
        Elapsed time in seconds
    """
    current_time = await get_current_timestamp()
    return current_time - start_timestamp 