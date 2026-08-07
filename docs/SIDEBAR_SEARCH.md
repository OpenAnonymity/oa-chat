# Sidebar Search

This document describes global chat search, its local privacy boundary, and the
index lifecycle.

## Search Scope

Global search matches complete, persisted chat text without per-message or
per-session character caps:

- Session titles.
- User prompt content, including both `message.scrubber.original` and
  `message.scrubber.redacted` when present.
- Visible assistant answer variants: normal content, `redactedResponse`, and an
  already available `restoredResponse`.

Search intentionally excludes system messages, `isLocalOnly` messages (including
Memory Agent status rows), reasoning traces, citations, and attachment contents.
Restoring an assistant response for search never triggers a network request; only
restored text already stored in the message can be indexed.

## Index and Matching

`chat/services/conversationSearch.js` owns an in-memory Orama full-text index.
Orama uses BM25 scoring and English tokenization for the current release. One
document is indexed per searchable message, plus a title document. Searches use
`distinctOn: sessionId`, so only the best matching message from each session is
returned.

Multi-term queries require every term to occur in the same visible message
document; locally stored scrubber variants for that message share the document.
Fuzzy edit-distance matching is disabled. Session titles are boosted for
match selection, but final session order is always `updatedAt` descending rather
than relevance order.

The previous bounded `session.conversationSearchText` field remains readable for
database compatibility, but it is no longer the source for global text search.
This removes the old 2,000-character message and 12,000-character session recall
limits.

## Build and Update Lifecycle

The index is memory-only. Original PII is already stored locally as scrubber
metadata; search does not create another persistent plaintext copy.

- App startup schedules an idle-time index build after IndexedDB opens.
- The build loads sessions and messages in parallel, inserts documents in bounded
  batches, and yields between batches so it does not block initial rendering.
- A search started before the idle build completes waits for that same build.
- Successful or cancelled-partial message completion, prompt edits,
  regeneration, imports, forks, title changes, star changes, restoration,
  deletion, and history clearing update or remove the affected session documents
  incrementally.
- Cross-tab storage changes invalidate the memory index; the next search rebuilds
  from IndexedDB.
- Same-tab backup imports invalidate the index during the session-list reload.
- Forks index the newly assigned fork message IDs so excerpt navigation remains
  exact.
- Local mutations that race an initial build are queued and replayed over the
  build snapshot before the index becomes ready.

Date filters use local calendar-day boundaries rather than fixed 24-hour offsets,
so searches remain correct across daylight-saving transitions.

## Result UI and Navigation

When a query is active, each matching session row expands to a fixed-height
search result showing:

- The normal session title.
- A `You`, `Assistant`, `Original prompt`, `Restored answer`, or `Chat title`
  source label.
- A centered excerpt with escaped, highlighted query terms.

Clicking an excerpt opens the session, scrolls to the exact message, and applies
a short focus outline. Clicking an original-prompt or stored restored-answer hit
explicitly switches that message to the matching local view before scrolling.
When anonymized and original variants both satisfy a query, the anonymized
variant is preferred; original/restored text is shown only when needed to match.
Clearing the query restores the normal compact sidebar rows.

Fixed result heights are included in sidebar virtualization calculations.
Starred and date filters are passed into the Orama query so filtered searches do
not first over-fetch irrelevant sessions.

## Performance Coverage

Unit coverage builds an index with 5,000 sessions and verifies that an indexed
two-term query completes within a conservative 500 ms test budget. In local runs,
the full test (data generation, index construction, and query assertion) completes
well below that budget for the query itself. The production UI performs only an
in-memory Orama lookup on the debounced keystroke path.
