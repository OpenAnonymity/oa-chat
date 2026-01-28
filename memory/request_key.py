#!/usr/bin/env python3
"""
Request API key using inference tickets.

This script implements the `request_key` workflow from oa-fastchat, allowing you
to redeem Privacy Pass tickets for ephemeral API keys.

Usage:
    python request_key.py                               # show available tiers
    python request_key.py tickets.json                  # request key with 1 ticket
    python request_key.py tickets.json --tier 3x       # request key with 3 tickets
    python request_key.py tickets.json --json          # output as JSON

Ticket file format (exported from oa-fastchat):
    {
        "data": {
            "tickets": {
                "active": [{"finalized_ticket": "...", ...}, ...]
            }
        }
    }

Requirements: pip install requests
"""

import argparse
import json
import sys
from pathlib import Path

import requests

# Open Anonymity org server base URL
ORG_API_BASE = "https://org.openanonymity.ai"


# =============================================================================
# Core Functions (can be imported and used elsewhere)
# =============================================================================

def fetch_tiers():
    """
    Fetch model-to-ticket-cost mapping from the org server.

    Returns:
        dict: {model_id: ticket_cost} e.g. {"anthropic/claude-3-haiku": 1, ...}
              Empty dict on error.
    """
    try:
        r = requests.get(f"{ORG_API_BASE}/chat/model-tickets", timeout=10)
        return r.json() if r.ok else {}
    except:
        return {}


def load_ticket_file(path):
    """
    Load ticket file and return both raw data and active tickets.

    Returns:
        tuple: (raw_data, active_tickets, path_to_active_list)
               path_to_active_list is a list of keys to navigate to the active array
    """
    raw = json.loads(Path(path).read_text())
    data = raw
    nav_path = []  # Track navigation path for later update

    if isinstance(data, dict):
        if "data" in data:
            nav_path.append("data")
            data = data["data"]
        if "tickets" in data:
            nav_path.append("tickets")
            data = data["tickets"]
        if "active" in data:
            nav_path.append("active")
            data = data["active"]

    tickets = data if isinstance(data, list) else []

    # Filter to active only
    active = [
        t for t in tickets
        if t.get("finalized_ticket")
        and not t.get("consumed_at")
        and t.get("status", "").lower() not in ("archived", "consumed", "used")
    ]
    return raw, active, nav_path


def save_ticket_file(path, raw_data, nav_path, remaining_tickets):
    """
    Save updated ticket file with remaining active tickets.
    """
    # Navigate to the active list location and update it
    if not nav_path:
        # Raw array format - just save remaining
        Path(path).write_text(json.dumps(remaining_tickets, indent=2))
        return

    # Navigate and update nested structure
    target = raw_data
    for key in nav_path[:-1]:
        target = target[key]
    target[nav_path[-1]] = remaining_tickets

    Path(path).write_text(json.dumps(raw_data, indent=2))


def load_tickets(path):
    """Load active tickets from file (convenience wrapper)."""
    _, active, _ = load_ticket_file(path)
    return active


def request_key_once(tickets, count=1, name="OA-Script-Key"):
    """
    Single attempt to request an API key. Returns (result, error_data).
    On success: (result_dict, None)
    On already-spent error: (None, error_dict with 'failed_index')
    On other error: raises RuntimeError
    """
    if len(tickets) < count:
        raise ValueError(f"Need {count} tickets, have {len(tickets)}")

    tokens = ",".join(t["finalized_ticket"] for t in tickets[:count])
    auth = f"InferenceTicket token{'s' if count > 1 else ''}={tokens}"

    r = requests.post(
        f"{ORG_API_BASE}/api/request_key",
        headers={"Content-Type": "application/json", "Authorization": auth},
        json={"name": name},
        timeout=30,
    )

    data = r.json()

    if not r.ok:
        # Check if it's a spent ticket error we can retry
        is_spent = (
            data.get("error_code") == "TICKET_ALREADY_SPENT"
            or "already spent" in str(data).lower()
        )
        if is_spent:
            failed_idx = data.get("failed_ticket", {}).get("index", 0)
            return None, {"failed_index": failed_idx, "raw": data}
        raise RuntimeError(data.get("detail") or data.get("error") or data)

    return {
        "key": data["key"],
        "tickets_consumed": data.get("tickets_consumed", count),
        "expires_at": data.get("expires_at"),
        "station_id": data["station_id"],
    }, None


def request_key(tickets, count=1, name="OA-Script-Key"):
    """
    Request an API key, automatically retrying if tickets are already spent.

    Args:
        tickets: List of ticket objects (from load_tickets)
        count: Number of tickets to redeem (determines model tier access)
        name: Identifier for the key (for logging/tracking)

    Returns:
        tuple: (result_dict, remaining_tickets)
               result_dict has: key, tickets_consumed, expires_at, station_id
               remaining_tickets: tickets not yet consumed (for saving back)

    Raises:
        ValueError: Not enough tickets
        RuntimeError: API request failed (non-retryable)
    """
    remaining = list(tickets)
    skipped = 0

    while len(remaining) >= count:
        attempt_tickets = remaining[:count]
        result, error = request_key_once(attempt_tickets, count, name)

        if result:
            # Success - return result and remaining tickets (minus the ones just used)
            return result, remaining[count:]

        # Ticket was already spent - remove it and retry
        failed_idx = error["failed_index"]
        skipped += 1
        print(f"Ticket {skipped} already spent, trying next...", file=sys.stderr)
        remaining.pop(failed_idx)

    raise ValueError(f"Not enough valid tickets. Need {count}, but all remaining were spent.")


# =============================================================================
# CLI
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Request API key using inference tickets",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Run without arguments to see available tiers.",
    )
    parser.add_argument("ticket_file", nargs="?", help="Ticket JSON file (exported from oa-fastchat)")
    parser.add_argument("--tier", default="1x", help="Tickets to use: 1x, 2x, 3x, etc. (default: 1x)")
    parser.add_argument("--name", default="OA-Script-Key", help="Key name for identification")
    parser.add_argument("--tiers", action="store_true", help="Show available tiers")
    parser.add_argument("--json", action="store_true", help="Output result as JSON")
    args = parser.parse_args()

    # Show available tiers (default when no ticket file provided)
    if args.tiers or not args.ticket_file:
        tiers = fetch_tiers()
        if not tiers:
            print("Could not fetch tiers from server")
            return
        available = sorted(set(tiers.values()))
        print("Available tiers:", ", ".join(f"{t}x" for t in available))
        return

    # Request a key
    try:
        raw_data, tickets, nav_path = load_ticket_file(args.ticket_file)
        count = int(args.tier.lower().replace("x", ""))
        result, remaining = request_key(tickets, count, args.name)

        # Update ticket file with remaining valid tickets
        save_ticket_file(args.ticket_file, raw_data, nav_path, remaining)

        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(f"OpenRouter API Key:\n{result['key']}")
            print(f"================================================")
            print(f"Tickets used: {result['tickets_consumed']}")
            print(f"Expires: {result['expires_at']}")
            print(f"Remaining: {len(remaining)}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
