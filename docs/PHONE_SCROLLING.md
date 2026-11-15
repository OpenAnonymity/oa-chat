# Phone scrolling and model-picker interaction

The reported surface is the site added to an iPhone Home Screen. This change
targets touch scrolling and tap responsiveness, not provider response latency.
Authentication, ticket handling, wallets, inference transport and persisted data
are untouched.

## Changes and evidence

- Opening/closing the model picker formerly focused an editable input every
  time. Touch browsing now focuses the dialog and returns to its launcher;
  tapping search remains available. Desktop/hardware-keyboard use focuses search
  and returns to the composer. All three model shortcuts pass explicit keyboard
  intent; this does not depend on the focus-ring attribute surviving touch input.
- The list was fixed at 270px with compact rows. Phone/coarse-pointer layout
  uses up to 55dvh/420px, constrained to the available viewport with a fixed
  search header. Row and close targets are at least 44px; search text is 16px.
- Every opening replaced all model rows, including those prepared by warm
  rendering. It now computes current markup but reuses unchanged DOM. Pricing,
  pinned/disabled settings, selection and queries still invalidate rendered rows.
- Every phone scroll measured transcript/toolbar controls even though the
  floating toolbar is disabled at that width. The phone path now returns first.
- Navigation previously searched the message array once per DOM message and
  rewrote every indicator on each scroll event. ID lookup is linear, scroll
  bursts are coalesced, and unchanged indicators are not rewritten.

## Verification (2026-10-08)

`node --test test/ui/*.test.js test/components/*.test.js`: 368 tests passed.
New coverage includes focus races, retained rows versus changing prices, a
60-event scroll burst, hidden/programmatic navigation, linear lookup in a
600-element mixed chat, and zero phone toolbar geometry reads.

Local browser fixture: serve this repository and open
`/test/fixtures/phone-model-picker.html`. It imports the real model picker and
current modal markup/styles with 300 synthetic models. No account or inference
requests are performed. Browser checks passed at 390×844: dialog focus, 420px
list/44px rows/16px search, scroll to 2532px retained after reopening without
replacing rows, search/select model 299, and four pinned Council choices. A
simulated 280px visible viewport kept the entire dialog within that height.
At 1280×800 the list remained 270px, search received focus, and ArrowDown/Enter
selected a model and restored composer focus.
The explicit keyboard opening also focused search at phone width with
`data-keyboard-nav` absent, then restored composer focus after selection.
The required independent adversarial review approved after that shortcut
regression was fixed; all 30 directly affected tests passed separately.

The full release suite also caught a test-harness leak: the navigation test
created a top-level `document` stub that triggered relay-page initialization in
a later test. Browser globals are now installed per test and restored, including
their original absence. Running navigation and passkey-relay tests together
with `--test-isolation=none` passes all 12 tests. No relay/app code was changed.

This is a desktop browser at phone dimensions, not a real iPhone. It does not
measure iOS momentum, actual keyboard presentation, or whole-app frame rate.
After staging release, test Home Screen launch, fast list swipes, search with
the actual keyboard, tapping a row after scrolling, closing/reopening, long
conversation scrolling, and rotating the phone. Check light and dark themes.

## Keyboard and shared motion follow-up (2026-10-08)

- The HTML textarea had `autofocus`, and send/regeneration completion directly
  focused it. Phone startup/completion now leave the keyboard under user control;
  explicit taps and keyboard shortcuts still work. Clearing an accepted phone
  submission dismisses its keyboard only if the draft has not been replaced.
- Phone prompt positioning uses the space above the composer, reserving a reply
  preview. A tall photo may scroll partly out of view instead of leaving the
  entire answer hidden. Desktop keeps its quarter-height anchor.
- Visual-viewport events are coalesced to one frame; unchanged height, pan and
  keyboard attributes do not cause style mutations. Cleanup cancels the frame.
- Shared surface transitions are idempotent on refresh and reverse during rapid
  reopen. Logical close/inert behavior remains immediate. Settings is positioned
  before its entrance measurement. Reduced-motion cleanup is still immediate.
- Disclosure observation scans only newly inserted subtrees, including a new
  details element itself. It no longer rescans the parent transcript/body for
  each streamed insertion. Motion token overrides now follow recipe defaults;
  broad `transition: all` rules were narrowed to the painted properties.
- Commercial phone CSS separately reduces the composer fade and slides the
  half-width history rail with a transform, avoiding per-frame row reflow.

Synthetic fixture: `/test/fixtures/phone-keyboard-motion.html` exercises the real
shell/styles and UI helpers with a simulated visual viewport, photo-sized prompt,
menu/dialog open/close, rapid reopen and native disclosure. It does not start the
app, access an account, or send inference. Actual iOS keyboard animation and
Home Screen scrolling still require a real-phone check.

## Compact composer wrapping (2026-10-08)

The compact layout hid the scrubber shortcut but still reserved 150px for short
drafts and 64px for longer drafts. This made ordinary phone text wrap early and
change available width at 50 characters. The compact textarea now releases that
unused space for either hint class. The visible pending rewrite/preview controls
retain their more-specific 150px reservation; wide desktop hint layout is unchanged.

`/test/fixtures/composer-wrapping.html` imports the real shell/styles without
starting the app. Its layout assertions failed before the fix at 402px (two
lines with 150px blank space), then passed at 375, 390, 402 and 430px: the reported
sentence fits on one line in both hint states. Wide layouts at 768 and 1280px
retain 150/64px, and pending rewrite input and overlay retain matching 150px.
Light/dark and normal multiline typing were checked in the browser. Physical
iPhone keyboard behavior remains a user-assisted check.

Independent review found a breakpoint edge: restoring the desktop padding could
wrap an existing single-line draft without growing its height. The responsive
composer now calls its existing autosizer after compact CSS state changes, once
per transition. At viewport 590→592px (card 558→560), the preserved 48-character
draft grows from 24px to 48px; returning to compact shrinks it again. The fixture
keeps the draft intact on resizing, and the unit test guards callback ordering
and excludes height-only observer loops.

## Phone panels follow-up (2026-10-09)

The new panel/menu changes apply to phone Safari and the Home Screen app,
using the gate documented in [APP_STATE.md](APP_STATE.md). They do not change
laptop-browser or native-desktop layout. In the commercial integration, build
and serve `test/fixtures/phone-app-panels.html` as documented in
`oa-commercial/docs/PHONE_INTERACTIONS.md`. It exercises real panel and picker
components with synthetic state; it never logs in or requests inference.

Browser checks at 375×812 and 393×852 cover light/dark panel layout, pending and
active key rows, long station names, mutually exclusive rails, and settings
matching the composer width. Filtering three pinned models to one reduced the
list from 184px to 96px while search stayed at y=17px. Rotation 844→393 closes
the extra panel. A synthetic narrow laptop retains the original 340px settings
and width/border/transform transition; Electron is excluded as well.

These are browser geometry checks with simulated phone capabilities, not proof
of real iOS scroll performance. On a physical iPhone, check Safari and Home
Screen, keyboard open/close, quick panel swaps, search after swiping, rotation,
and light/dark themes before calling device validation complete.
