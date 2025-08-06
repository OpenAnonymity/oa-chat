"""
Async-safe cryptographically secure random utilities.
Replaces synchronous random operations that can block the event loop.
"""

import secrets
import asyncio
from typing import List, TypeVar

T = TypeVar('T')


async def secure_choice(choices: List[T]) -> T:
    """Cryptographically secure random choice from a list."""
    if not choices:
        raise ValueError("Cannot choose from empty list")
    
    # Use secrets for cryptographically secure randomness
    index = secrets.randbelow(len(choices))
    return choices[index]


async def secure_random() -> float:
    """Cryptographically secure random float between 0.0 and 1.0."""
    # Generate 53 random bits for high-precision float
    # This matches the precision of Python's random.random()
    return secrets.randbits(53) / (1 << 53)


async def secure_randint(min_value: int, max_value: int) -> int:
    """Cryptographically secure random integer in range [min_value, max_value]."""
    if min_value > max_value:
        raise ValueError("min_value cannot be greater than max_value")
    
    # Calculate range and use secrets.randbelow for security
    range_size = max_value - min_value + 1
    return min_value + secrets.randbelow(range_size)


async def secure_uniform(min_value: float, max_value: float) -> float:
    """Cryptographically secure random float in range [min_value, max_value)."""
    if min_value >= max_value:
        raise ValueError("min_value must be less than max_value")
    
    # Generate secure random float and scale to range
    random_float = await secure_random()
    return min_value + random_float * (max_value - min_value)


async def secure_shuffle(items: List[T]) -> List[T]:
    """Cryptographically secure in-place shuffle of a list."""
    # Fisher-Yates shuffle with cryptographically secure randomness
    for i in range(len(items) - 1, 0, -1):
        j = secrets.randbelow(i + 1)
        items[i], items[j] = items[j], items[i]
    
    return items


async def secure_sample(population: List[T], k: int) -> List[T]:
    """Cryptographically secure random sample from population without replacement."""
    if k < 0:
        raise ValueError("Sample size cannot be negative")
    if k > len(population):
        raise ValueError("Sample size cannot be larger than population")
    
    if k == 0:
        return []
    
    # Create a copy to avoid modifying the original
    pop_copy = population.copy()
    result = []
    
    for _ in range(k):
        index = secrets.randbelow(len(pop_copy))
        result.append(pop_copy.pop(index))
    
    return result 