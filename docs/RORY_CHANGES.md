# Rory's Changes

Tracking features added and fixes made on the `rorycai/work_trial` branch.

## Completed

### #8 — Memory + System Prompt sections in the right panel
- **Date:** 2026-04-28
- **Status:** ✅ Implemented (v1: read-only browsing + click-to-edit; **deferred**: extraction-write activity)
- **Type:** Feature
- **Files:**
  - `chat/components/RightPanel.js` — adds two new collapsible-region sections **between the existing top section and the Activity Timeline**, in this order: Memory (flex-basis 26%, min-height 110px), System Prompt (flex-basis 18%, min-height 90px). Each has its own header (label + open-editor button) and an internally-scrollable body. New methods: `loadMemorySectionData()`, `computeUsedMemoryFiles()`, `getDirectoryStructureForRightPanel()`, `renderMemorySectionHTML()`, `renderSystemPromptSectionHTML()`, `getFileBaseName()`, `refreshMemorySection({reloadFiles})`, `refreshSystemPromptSection()`, `attachMemoryAndPromptSectionListeners()`. Also imports `memoryFileSystem` from `services/memoryInstances.js` (same shared instance the Memory Editor uses).
  - `chat/app.js` — refresh hooks fire from: `setSessionSystemPrompt` (active preset changed), `saveSystemPromptPreset` / `deleteSystemPromptPreset` (preset list changed), end of `runMemoryAugmentFlow` after `ciPromptDraft` is written (used-files set changed), end of `runPostTurnMemoryExtraction` (memory tree may have new files).
  - `chat/components/MemoryEditor.js` — `_loadFileTree()` now also calls `app.rightPanel.refreshMemorySection({ reloadFiles: true })` so creating/saving/deleting/renaming files inside the Memory Editor reflects in the right panel without needing a session switch.
  - `chat/styles.css` — `.rp-mem-row`, `.rp-mem-icon`, `.rp-mem-chevron`, `.rp-mem-label`, `.rp-mem-row-used`, `.rp-mem-row-dir-used`, `.rp-mem-used-dot`, with light + dark variants. The "used in this session" highlight uses the same green accent as `.user-data-highlight` for visual consistency.
- **Memory section behavior:**
  - Lists the entire memory tree from `memoryFileSystem.exportAll()` (same source as Memory Editor; `_tree.md` filtered out, sorted lexicographically).
  - Folders are inferred from path prefix before first `/` (matches the storage layout).
  - Highlighting is **the latest retrieval only, not cumulative** — files referenced by the most recent message with `ciPromptDraft.memoryFiles` get a green-tinted background, an accent-colored icon, and a small dot at the end of the row. The parent folder of any used file is also visually weighted (bold label). When the user sends a new turn that triggers another retrieval, the previous turn's highlights drop out.
  - Folder expansion is **derived from highlights**: each compute resets `memoryTreeExpandedDirs` to exactly the set of directories that contain a highlighted file. Folders without highlights stay closed. Manual click on a folder still toggles, but the next compute (session switch / new memory bubble / Memory Editor file write) resets to the derived state.
  - Click a file row → opens the Memory Editor focused on that file via `memoryEditor.openToFile(path)`.
  - Header pencil button → opens the Memory Editor without a specific file focus.
  - Empty states: "Loading memory…" before first load, "No memory files yet" once `exportAll()` returns nothing.
- **System Prompt section behavior:**
  - Lists "Default" (no preset) followed by all saved presets from `app.state.systemPromptPresets`.
  - The active preset for the current session (`session.systemPromptId`) gets the same "used" highlight + dot. When `systemPromptId` is null, "Default" is highlighted instead.
  - Click a preset row → opens the existing system-prompt editor modal (#22) and immediately calls `selectSystemPromptForEdit(presetId)` so the editor lands on that preset. Clicking "Default" just opens the modal in its empty state.
  - Header `+` button → opens the editor modal without a specific preset focus.
- **Layout / scoping:**
  - Both sections use percentage-based `flex-basis` so their height is a stable fraction of the right panel rather than growing with content. Each has internal `overflow-y: auto`.
  - Both sections re-render on `onSessionChange` because the highlighted set is session-scoped (current session's used files / active preset).
- **Why v1 doesn't surface extraction writes:** the `nanomem` ingest tool loop currently does not expose the list of files it wrote during post-turn extraction back to root (the result is just `{status, writeCalls}`), so per-message "files written" diffs would need an upstream change. The right-panel Memory section already refreshes after extraction succeeds, so newly-written files do appear in the tree — just without a "written this session" highlight. Tracked in `RORY_CHANGES.md` for future expansion.

### #26 — About modal + customizable keyboard-shortcuts modal
- **Date:** 2026-04-28
- **Status:** ✅ Implemented (final UI: diagram-led, content-sized)
- **Type:** Feature
- **Files:**
  - `chat/services/shortcutManager.js` *(new)* — single source of truth for global shortcut bindings. Defaults `{ newChat: ⌘/, modelPicker: ⌘K, searchFocus: ⌘⇧F, memoryEditor: ⌘⇧M, shortcuts: ? }`. Persists user overrides to `localStorage` (`oa-shortcuts`). Platform-aware: the `mod` modifier resolves to Cmd on macOS and Ctrl elsewhere. API: `matches(event, actionId)`, `get`, `getAll`, `set`, `reset`, `resetAll`, `subscribe`, plus statics `eventToBinding`, `format`, `bindingsEqual`, `actionIds`, `labelFor`, `defaultFor`.
  - `chat/components/AboutModal.js` *(renamed from HelpModal)* — intro modal only. Sections: *What is oa-chat?*, *How it works*, *Features*, *Learn more*. **No shortcuts section** — that lives in ShortcutsModal now.
  - `chat/components/ShortcutsModal.js` *(new)* — two-section modal. Top: customizable global actions, each row has the action name, current binding chips, *Edit* and *Reset* buttons. Bottom: read-only contextual shortcuts (chat input, edit textarea, memory editor, model picker, anywhere). Header has a *Reset all* button. Click *Edit* on a row to enter capture mode: a capture-phase keydown listener intercepts the next combo before it reaches `app.js`'s bubble-phase handler. Conflicts with another action are surfaced inline and the change is rejected until the user picks a non-conflicting combo. Esc cancels capture; the modal's outer Esc-to-close handler is suppressed while capture is active.
  - `chat/index.html` — drops the previous `#help-btn` / `#help-modal`; adds `#about-btn` (info-circle icon) and `#shortcuts-btn` (terminal-prompt icon) to the right toolbar in that order, both before `#share-btn`. Adds matching `#about-modal` and `#shortcuts-modal` placeholder divs.
  - `chat/app.js` — imports both modals + `shortcutManager`. The global keyboard handler now routes through `shortcutManager.matches(event, actionId)` for all five customizable actions. A `shortcutCanFireWhileTyping` helper skips dispatch for no-mod/no-alt bindings while the active element is an input/textarea/contentEditable, so a plain `?` or `/` doesn't fire mid-message. `Cmd+Z` (file-paste undo) intentionally stays hardcoded — we don't want to let users rebind the platform's standard undo combo.
- **Behavior:**
  - **About button** (info-circle icon, leftmost of the two) opens the intro modal. No global shortcut by default.
  - **Shortcuts button** (terminal-prompt icon, between About and Share) opens the customize panel. Default shortcut: `?`. Tooltip displays "Keyboard shortcuts (?)".
  - **Click Edit on a row** → row shows "Press a new combo… (Esc to cancel)". Press any combo → if it conflicts with another action, the row shows a red "Conflicts with X" message and waits for a different press; otherwise it's saved immediately and the modal re-renders. Pressing Esc returns the row to its previous binding without changes.
  - **Click Reset on a row** → reverts that row to its default binding. The button is dimmed/inert when the binding is already at default.
  - **Click Reset all** in the header → confirm dialog, then revert every customizable action.
  - Saved bindings persist across sessions in `localStorage` (`oa-shortcuts`). Defaults take over for any action not in the stored object — handy for forward-compatibility when new actions are added.
- **Scope notes:**
  - Only the five global modal/focus shortcuts are customizable. Contextual shortcuts (Enter to send, Cmd+Enter to confirm edits, model-picker arrow nav, memory-editor Cmd+S, etc.) are intentionally not customizable — they're tightly coupled to widgets and changing them would break expected typing/editing behavior.
  - Capture uses a **capture-phase** listener (`addEventListener('keydown', handler, true)`) so a press during rebinding intercepts the key before app.js's bubble-phase global handler routes it to the previously-bound action. Without this, rebinding `⌘K` to something else would briefly trigger the model picker.
  - Conflicts are blocked at save time, not silently overwritten. The user must explicitly pick a different combo or reset the conflicting action first. This avoids "I rebound X and now Y is broken with no way to know" surprises.
  - When new customizable actions are added: register them in `DEFAULT_SHORTCUTS` + `ACTION_LABELS` + `ACTION_ORDER` in `shortcutManager.js`, then dispatch via `matchAction(e, 'newId')` in `app.js`. The ShortcutsModal picks them up automatically. Update the read-only `CONTEXTUAL_SHORTCUTS` table in `ShortcutsModal.js` for any new contextual shortcuts.
  - External links open in a new tab with `rel="noopener noreferrer"`.
- **Final UI direction (Rory refinement):**
  - **AboutModal:** 560px frame (down from 720), `max-height: min(86vh, 720px)` so the modal sizes to its content rather than enforcing a fixed height. The gradient hero was replaced by an inline `You → OA org → Provider` flow diagram with a "blind sig" lock badge over the first arrow, so the architectural promise is legible at a glance instead of buried in prose. Features collapse to a denser 2-column icon grid (`What's inside`); resources collapse to a row of pill-shaped links. Outer padding is `px-[18px] py-[14px]`; section gaps use `mb-[14px]`. Section labels are `text-[10px] uppercase tracking-[0.08em]` again — the diagram + flow copy carry the visual weight, so the labels don't need to.
  - **ShortcutsModal:** kept the 720×760 frame and the customizable/built-in two-section layout. Per-row Reset stays hidden until the row is non-default, the customized count badge stays in the section header, and the keycap chip styling (gradient + bottom shadow) is unchanged.
  - **Toolbar buttons:** `#about-btn` and `#shortcuts-btn` are `h-10 w-10` with `h-6 w-6` SVGs (kept from the bigger-icons pass).

### #22 — Per-session system prompt presets
- **Date:** 2026-04-28
- **Status:** ✅ Implemented
- **Type:** Feature
- **Files:**
  - `chat/db.js` — bumps version to 5; adds `systemPromptPresets` object store with `updatedAt` index; adds `getAllSystemPromptPresets`, `saveSystemPromptPreset`, `deleteSystemPromptPreset`.
  - `chat/app.js` — adds `state.systemPromptPresets` (in-memory cache), preset CRUD (`saveSystemPromptPreset`, `deleteSystemPromptPreset`), `getActiveSystemPromptPreset(session)`, `setSessionSystemPrompt(sessionId, presetId)`, and the picker/modal controllers (`setupSystemPromptControls`, `renderSystemPromptPickerMenu`, `openSystemPromptModal`, `renderSystemPromptList`, `selectSystemPromptForEdit`, `handleSaveSystemPrompt`, `handleDeleteSystemPrompt`, `renderCurrentSystemPrompt`). Loads presets at app init. Hooks `renderCurrentSystemPrompt()` after session-switch render. `processMessagesWithFiles` prepends the active preset as a system message before sending.
  - `chat/index.html` — picker button (`#system-prompt-picker-btn`) + dropdown (`#system-prompt-picker-menu`) placed in the input bottom-actions bar right after the model picker; editor modal (`#system-prompt-modal`) with sidebar list + name/content editor.
  - `chat/styles.css` — `.has-preset` accent border on the picker button when a non-default preset is active.
- **Behavior:**
  - The hardcoded default system prompt in `api.js` is **still always sent** with every API call. Presets are **additive** — when a session has a preset selected, its content is prepended as an extra `system` message in `processMessagesWithFiles`. Final order on the wire: `[hardcoded_default, preset_content, ...conversation]`.
  - Per session: each session stores a `systemPromptId` field (default `null` = "Default" / no preset). Switching sessions updates the picker label to the right preset.
  - Picker dropdown shows: ✓ Default, ✓ each saved preset, separator, "Manage prompts..." entry that opens the editor modal. Selecting an item persists `session.systemPromptId` immediately and closes the dropdown.
  - Editor modal: left sidebar lists presets, "New Prompt" creates one. Right pane has a name input, multi-line content textarea, Save/Delete buttons. Save creates or updates; Delete removes the preset and clears `systemPromptId` from any sessions that referenced it.
- **Empty by default:** No seeded presets — users add their own.

### #14 + #15 — Pin and Archive sessions
- **Date:** 2026-04-28
- **Status:** ✅ Implemented
- **Type:** Feature
- **Files:**
  - `chat/app.js` — adds `showArchived` state, `togglePinSession`, `toggleArchiveSession`, `setShowArchived`, `updateArchivedToggleUI`; updates `getFilteredSessions`; wires up the archived toggle button.
  - `chat/components/Sidebar.js` — adds Pin/Archive menu items in `buildSessionHTML`, click handlers in `ensureEventListeners`, "Pinned" group at the top in `groupSessionsByDate` with `groupOrder` updated.
  - `chat/index.html` — adds `#toggle-archived-btn` between the search input and the sessions list.
  - `chat/styles.css` — `.archived-toggle-btn` styles incl. pressed state.
- **Data model:** sessions now carry two flags persisted to IndexedDB: `pinned: boolean` (default false) and `archived: boolean` (default false). No schema migration needed — flags default to falsy when missing.
- **Behavior:**
  - **Pin:** Session menu → *Pin* / *Unpin*. Pinned sessions render in a "Pinned" group at the very top of the sidebar regardless of date, with a small pin icon next to the title. Pinning is suppressed in archived view (it doesn't make sense for archived sessions).
  - **Archive:** Session menu → *Archive* / *Unarchive*. Archived sessions are hidden from the main list. If the user archives the currently-open session, the app switches to the next active session (or creates a new one if none exist). Archiving also clears `pinned` so a session doesn't sit "pinned" inside the archive.
  - **Archived view toggle:** A small button below the search input toggles between "Archived" (showing only archived sessions) and "Active chats" (back to normal). The button reflects state via `aria-pressed` and `.archived-toggle-btn[aria-pressed="true"]` styling.
- **Filter logic:** `getFilteredSessions` applies an `archivedFilter` first based on `showArchived`. Combined with the existing fuzzy title search and the remote search merge — both paths re-apply the archived filter so the toggle works during search too.

### #31 — Position new user message at 30% from top when conversation fills the design location
- **Date:** 2026-04-28
- **Status:** ✅ Implemented
- **Type:** UX improvement
- **Files:** `chat/app.js`
  - `scrollUserMessageToTop` — rewritten with the new logic
  - `switchSession` — clears `minHeight` on session switch
  - `updateScrollButtonVisibility` — doesn't unset `isAutoScrollPaused` while the spacer is active
- **Behavior (per requirements):**
  - **Design location:** 30% from the top of the chat area (`chatHeight * 0.3`).
  - **Rule 1 — short conversation, no adjustment:** if the new user message naturally lands at or above the 30% mark (`messageTop <= designLocation`), `scrollUserMessageToTop` returns early. No scroll, no spacer.
  - **Rule 2 — long conversation, scroll to design location:** if the previous content fills past the 30% mark, the message is scrolled so its top sits at exactly 30% from the top. A `minHeight` is applied to `#messages-container` so the scroll target is reachable, and `chatArea.scrollTo({ behavior: 'instant' })` snaps it there. No further adjustment runs even when the response below grows long.
- **Conflict resolution with existing logic:**
  - `updateScrollButtonVisibility` previously unset `isAutoScrollPaused` whenever it computed `isAtBottom = true`. Because our minHeight is set tightly (`desiredScrollTop + chatHeight`), the snap leaves us "at the bottom" of the artificial scroll area, which would have re-enabled auto-scroll. The ResizeObserver on the input container then would have called `scrollToBottom()` on every keystroke and dragged the user message away from the design location. Fix: the check now skips `isAutoScrollPaused = false` when `messages-container.style.minHeight` is set.
  - `switchSession` now clears `messages-container.style.minHeight` so a session-switch doesn't inherit the previous session's spacer.
- **What is intentionally left untouched:**
  - The 50ms `setTimeout` + 2× `requestAnimationFrame` wrapper in send/regenerate (it ensures the new message is fully laid out before measuring `offsetTop`).
  - The ResizeObserver's `scrollToBottom()` call (still runs, but is gated by `isAutoScrollPaused` which now stays paused while our spacer is active).
  - The original page-load `scrollToBottom(true)` and the user-clicked scroll-to-bottom button.

### #10 + #11 — Memory Editor create-flow: no flicker, focused-folder insertion
- **Date:** 2026-04-28 (refined same day after user feedback on the v1 implementation)
- **Status:** ✅ Implemented
- **Type:** Bug fix / UX
- **Files:** `chat/components/MemoryEditor.js`
- **Behavior:**
  - **Focused folder concept.** The sidebar tracks `focusedDir` — the folder the user is "in":
    - Expanding a folder sets it as focused. Collapsing the focused folder clears focus.
    - Selecting a file in a folder sets that folder as focused. Selecting a root-level file clears focus.
    - Clicking blank sidebar space clears focus. Clicking the inline create input does not.
    - Renames track to the new name; deletes clear focus if the deleted folder was focused.
  - **Visual marker.** The focused folder's row gets an inset 3px accent stripe on its left edge (`--color-accent-primary`). The marker is applied both via static render and surgically (`_setFocusedDir`) when focus changes between renders.
  - **No-flicker create flow.** Clicking *New File* / *New Folder* and clicking elsewhere to cancel are now surgical DOM operations — no full `render()`. The new entry's input row is injected into the existing sidebar; blur/Escape removes only that wrapper. This addresses the v1 issue where clicking either button caused the modal to flash from a full innerHTML reset.
  - **New File insertion target.** With a focused folder, the new-file input renders nested *inside* that folder's children container (matching IDE conventions), with no prefix in the input value — the user types only the filename. `_createNewFile` prepends the focused folder before writing. With no focus, the input renders at root and accepts a full path.
  - **New Folder always top-level.** Folders are flat one-level by storage design (`_getDirectoryStructure` only splits at first `/`), so the new-folder input always lives at the root of the sidebar regardless of focus. After Enter, focus moves to the just-created folder and the file-step input renders nested inside it (using a "phantom dir" entry in `_renderSidebar` so the empty folder has a children container before the first file lands).
  - **Cancel rules unchanged.** Blur and Escape both cancel; only Enter creates.
- **Implementation:**
  - State: new `this.focusedDir` (string | null), reset on `open()` and `close()`.
  - Render: `_renderSidebar` accepts a phantom dir for `focusedDir` not in storage; the new-file input markup is emitted inside `[data-dir-children="${focusedDir}"]` if focused, else at root after rootFiles. New-folder input always at root. Shared markup builder `_renderInlineCreateInput(kind, indent)` so static render and surgical inject stay in lockstep.
  - Surgical helpers: `_injectCreateInputDom(kind)` inserts the wrapper into the right container (auto-expanding the focused folder if collapsed); `_removeInlineCreateInput()` removes it and resets state; `_setFocusedDir(dir)` toggles the inline `box-shadow` accent without re-rendering.
  - Wiring: unified `_wireCreateInput(input, kind)` handles Enter (create), Escape (surgical cancel), and deferred-blur cancel. The defer + `inputEl.isConnected` guard from v1 is preserved so a click on a sibling header button (e.g. *New Folder* while typing in the *New File* input) reaches its own click handler before the wrapper is torn down.
  - `_startNewFile`/`_startNewFolder` skip `render()` and call `_injectCreateInputDom` directly. The exception is when `files.length === 0` (the empty-state placeholder occupies the sidebar) — in that case a single render is needed to swap to the normal sidebar shell.
  - `_createNewFile` strips leading slashes and prepends `focusedDir` before writing; `_createNewFolder` sets `focusedDir = name` so the file-step input lands inside the new folder.
- **Caveat for nested folders:** Typing `subdir/foo` in a focused-folder input writes `personal/subdir/foo.md`, which the flat sidebar renders as a file named `subdir/foo.md` inside `personal`. True nested folder rendering would require upgrading `_getDirectoryStructure` to a tree.

### #12 — Hide Memory Agent bubble when no memory was used
- **Date:** 2026-04-24
- **Status:** ✅ Implemented and committed (`140dec9`)
- **Type:** UX improvement
- **Files:** `chat/app.js`
- **Description:** When memory retrieval finds nothing relevant, the Memory Agent bubble is deleted from both IndexedDB and the DOM instead of showing the noise message *"Sending prompt without added context."* The user sees no memory UI at all when nothing was retrieved — the message sends silently as if memory mode wasn't on.
- **Bubbles that still appear (intentionally):**
  - Ticket-availability errors (*"Memory mode needs 2 available inference tickets..."*)
  - User-cancelled retrievals (*"Memory retrieval cancelled."*)
  - Actual error conditions (*"Memory retrieval unavailable..."*)
- **Implementation:** In `runMemoryAugmentFlow`, when `result?.reviewPrompt`, `result?.apiPrompt`, or `memoryFiles.length` is missing, call `chatDB.deleteMessage(retrievalMessage.id)` and remove the DOM element with `messageEl.remove()`.

## Pending

Tasks ranked by user-friendliness priority.

### P1 — High-impact, frequently used

- **#17** — Add full-text search across all messages
  - Currently search only matches session titles. Extend to search inside message content across all sessions, with snippet matches in context.

- **#25** — Add suggested follow-up questions below responses
  - After each assistant response, show 2-3 suggested follow-up questions.

- **#5** — Clearer UI for memory usage display and editing
  - Improve how memory usage is displayed — make it more obvious what memory was retrieved, what was included in the prompt, and allow easier editing of the augmented prompt. (Per-fact × in retrieval bubble was implemented and reverted on 2026-04-28; user found it noisy. Future direction TBD.)

- **#8 (follow-up)** — Surface extraction writes in the Memory section
  - The right-panel Memory section now highlights files **read** during retrieval. Files **written** during post-turn extraction need a `nanomem` change to expose write-paths in the ingest result before root can highlight/diff them. Once exposed, store per-session write history and add a second highlight tier (e.g., "written this session") to the right panel.

### P2 — Useful, but not daily friction

- **#13** — Add folders/projects for grouping sessions
  - Group related sessions into folders or projects with shared context/custom instructions per project (like ChatGPT's Projects).

- **#28** — Add slash commands in input
  - Slash commands like `/code`, `/translate`, `/summarize`, `/explain`. Could open a dropdown when the user types "/".

- **#16** — Add bulk actions on sessions
  - Multi-select sessions in sidebar for bulk delete/export/archive operations.

- **#29** — Add Markdown/HTML conversation export formats
  - Currently only PDF (per-conversation) and JSON (global) export exist. Add per-conversation export to Markdown and HTML.

- **#19** — Add conversation outline / table of contents
  - Auto-generate an outline from headers in long chats so users can jump between sections.

- **#23** — Add custom GPTs / personas
  - Different presets with different system prompts and tools. Users could create personas like "Code Reviewer", "Translator", "Writing Coach" and start sessions with one of them.

- **#2** — Discuss duplicate extraction across turns in the same session
  - Post-turn extraction sends the full session conversation every turn with no hard deduplication check. The LLM agent and exact-text compaction are the only defenses. Consider OA tracking which messages were already extracted (not just session-level `memoryProcessedAt`).

- **#3** — Manual memory editing improvements on Memory page
  - Direct input of new memory facts, topic selection UI, conflict detection/resolution when editing.

- **#9** — Add per-statement delete button on retrieval prompt preview
  - Add a small close/delete icon on each `[[user_data]]` block so individual facts can be removed without editing the raw prompt text.

### P3 — Lower priority / specialized

- **#20** — Add multiple regeneration variants side-by-side
  - Generate N variants of an assistant response and view them side-by-side.

- **#21** — Add interactive multiple-choice prompts from assistant
  - Support structured choice/option responses where the user can click to pick from options. Would need a way for the model to emit choice markers and the UI to render them as clickable buttons.

- **#24** — Add code interpreter / canvas
  - Interactive code/text editor that the assistant can iterate on (like ChatGPT's Canvas).

- **#18** — Add jump-to-date navigation in long conversations
  - For long conversations, allow jumping to a specific date or time period.

- **#27** — Add markdown editor toolbar in input
  - Toolbar buttons for bold/italic/code/links/lists in the chat input.

- **#30** — Improve density toggle from flat mode to true compact/comfortable
  - Currently only a "flat mode" toggle exists. Add a proper density toggle with compact/comfortable options that adjusts message spacing, padding, and font sizes.
