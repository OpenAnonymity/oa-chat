# Sidebar Search

This document describes the chat sidebar search behavior and the size/accuracy
tradeoffs behind it.

## What Gets Searched

Sidebar search checks three session fields:

- `session.title`: the visible chat title.
- `session.titleSearchText`: the legacy first-user-prompt text, only for
  non-manual titles.
- `session.conversationSearchText`: a bounded text index built from non-local
  user and assistant messages.

The app does not load every message for every keystroke. It searches session
records first, and only lazily builds `conversationSearchText` for older
sessions that do not have it yet.

Sidebar filters also operate at the session-record level:

- `session.starred`: toggled from the star button on each sidebar row.
- `session.updatedAt` / `session.createdAt`: used for quick date filters and
  the exact-date picker.

Star and date filters do not load messages. When any sidebar criterion is
active, the app scans session records from IndexedDB so older sessions outside
the currently paged sidebar are still included.

## Cap Policy

The index size is controlled by constants in `chat/app.js`:

- `SESSION_CONTENT_SEARCH_MAX_CHARS = 12000`: max indexed text per session.
- `SESSION_CONTENT_SEARCH_MESSAGE_MAX_CHARS = 2000`: max indexed text per
  individual message.

Index construction is intentionally simple:

1. Convert each non-local user/assistant message to plain searchable text.
2. Collapse whitespace.
3. Truncate each message to 2k characters.
4. Keep the first searchable message.
5. Fill the remaining 12k session budget from the newest messages backward.

This preserves the first prompt, which is often title-like context, plus recent
turns, which are usually what users remember when searching.

## Matching Rules

Search uses literal/token matching, not arbitrary fuzzy subsequence matching.

- Exact substring matches succeed.
- Multi-word queries require every query term to match some token.
- A single term matches exact tokens, token substrings for terms of length 3+,
  and token prefixes for terms of length 2+.

Do not reintroduce broad subsequence matching for conversation content. It
causes false positives such as `meaning` matching scattered characters across
`means. In ... GPU`.

Star/date filters are applied before text matching. Lazy
`conversationSearchText` backfill only runs for sessions that already pass those
session-level filters and only when a text query is present.

## Efficiency Tradeoff

The current approach stores up to about 12k characters per session in IndexedDB.
That is more storage than title-only search, but it avoids loading every message
for every query and keeps search latency predictable.

The downside is bounded recall: very long chats may not match content from the
middle of the conversation if it falls outside the first-message-plus-recent-turns
window. A more accurate alternative would be an inverted index or semantic index,
but that would add more code, storage, migration work, and update complexity.
