# Interaction performance pass — 2026-10-08

Built on the unshipped [phone picker/scroll changes](PHONE_SCROLLING.md), at
chat base `475296c`. Scope is client UI scheduling and
interaction bugs. No account, wallet, cryptographic, inference routing,
network timeout, or data format changes.

## Findings and fixes

1. **Thinking kept doing work when no new text arrived.** Single and Council
   reveal intervals converted text to HTML and replaced it every 16ms even after
   catching up. They now sleep until the next buffered update. Thinking remains
   visible; append, correction and final-settle behavior are preserved. The
   single-response path also stops if the target is no longer in the DOM.
2. **Scroll-button state could get stuck.** A quick hide/show reversal did not
   cancel the old hide callback, and repeated scroll checks queued more hides.
   The visibility helper now owns one cancellable timer. The old component
   `display: inline-flex` also overrode Tailwind's `.hidden`; the component now
   explicitly hides when that class is present.
3. **Interrupted jump-to-bottom could poll forever.** The click-pending flag
   suppressed the button until exact bottom, even if the user interrupted the
   jump or an ongoing response kept extending it. The wait now ends on manual
   input, chat change, detach, bottom or 15 checks (100ms intervals). Browser
   background throttling can delay timers, but no unbounded polling remains.
4. **Searching a large indexed history could block input.** Once every record
   had an index, the search loop could scan the whole collection synchronously.
   It yields every 50 records and stops stale work before sorting or after a
   yield. All matching, result limits and lazy indexing remain the same.

## Verification

- `node --test test/ui/*.test.js test/components/*.test.js test/application/*.test.js`:
  **668 passed** (includes the earlier phone fixes).
- Regression tests cover fade reversal/repeated hides; nine scroll-wait exit
  paths; real-controller history search ordering, input scheduling and stale
  cancellation; both reasoning renderers stopping, resuming, escaping corrected
  text and cleaning up after detach.
- `test/fixtures/interaction-performance.html` uses the real ChatArea methods
  and scroll-button helper with synthetic text, not a signed-in session.
- Local browser at 390×844: **0 text rewrites during a 1.2-second idle window**,
  both displays resumed with appended text, and zero reveal timers remained
  after catching up. An otherwise identical fixture using ChatArea from the
  base revision made **150 text rewrites** in that window and kept two timers
  running. This measures that specific idle workload, not total app speed.
- Browser checks confirmed reversal leaves the button visible and a completed
  hide removes it from layout. No UI/account data was read and no inference was
  sent. Real iPhone Home Screen performance and keyboard/momentum behavior still
  need device testing; local viewport sizing is not an iPhone simulator.
- The updated fixture also passed at 1280×800 with no browser warnings/errors.
  Fresh adversarial review approved the final diff and independently passed
  143 relevant tests, with no actionable findings.

Useful staging checks: let a thinking model pause between chunks, scroll back
through a long response, tap jump-to-bottom then interrupt it with a swipe,
reverse direction near the bottom repeatedly, and search/clear search in a
large chat history. Repeat in single-model and Council views.
