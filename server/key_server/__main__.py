"""Key Server entry point."""

from .server import main
import asyncio

if __name__ == "__main__":
    asyncio.run(main()) 