/**
 * TurnstileBubble — Cloudflare Turnstile verification in an anchored bubble popup.
 *
 * Renders Turnstile invisibly on init. When the caller needs a token, it calls
 * `requestToken()` which either returns immediately (if Turnstile resolved
 * invisibly) or shows a bubble anchored above the submit button and waits for
 * the user to complete the challenge.
 *
 * Usage:
 *   import TurnstileBubble from './TurnstileBubble.js';
 *
 *   const bubble = new TurnstileBubble();
 *   await bubble.init();                  // lazy-loads script + renders widget
 *   bubble.setAnchor(submitButtonEl);     // anchor the bubble to this element
 *   const token = await bubble.requestToken();  // resolves with token or null
 *   bubble.destroy();                     // full cleanup
 */

import { TURNSTILE_SITE_KEY } from '../config.js';

const SCRIPT_LOAD_TIMEOUT_MS = 10000;
// Unique global callback name for the ?onload= parameter.
// Cloudflare fires this only when the API is fully bootstrapped and ready
// to accept render() calls — polling for window.turnstile is unreliable
// because the stub object appears before the API is actually ready (600010).
const ONLOAD_CALLBACK = '__oa_turnstileReady';

// Bubble geometry
const BUBBLE_GAP = 8;
const BUBBLE_RADIUS = 12;
const BUBBLE_PADDING = 16;

class TurnstileBubble {
    constructor() {
        this._widgetId = null;
        this._token = null;
        this._anchor = null;
        this._needsInteraction = false;
        this._initPromise = null;
        this._initFailed = false;
        this._destroyed = false;

        // DOM
        this._backdrop = null;
        this._bubble = null;
        this._widgetContainer = null;
        this._scriptEl = null;
        this._dismissTimer = null;
        this._visible = false;

        // Listeners
        this._resizeHandler = null;
        this._scrollHandler = null;

        // Promise resolvers for requestToken() callers waiting on interaction
        this._pendingResolve = null;
    }

    // =========================================================================
    // Public API
    // =========================================================================

    /** Lazy-load the Turnstile script and render the widget (invisible). */
    async init() {
        this._initFailed = false;
        this._initPromise = (async () => {
            await this._ensureTurnstileScript();
            if (this._destroyed) return;
            this._createBubbleDOM();
            if (this._destroyed) return;
            this._renderWidget();
        })().catch((err) => {
            this._initFailed = true;
            this._initPromise = null;
            throw err;
        });
        await this._initPromise;
    }

    /** Set the element the bubble should anchor above when shown. */
    setAnchor(el) {
        this._anchor = el;
    }

    /**
     * Request a Turnstile token.
     * - If already available (invisible pass), resolves immediately.
     * - If Turnstile needs interaction, shows the bubble and resolves once
     *   the user completes the challenge (or null on error/timeout).
     */
    async requestToken() {
        // Wait for init to finish if still in progress
        if (this._initPromise) {
            try { await this._initPromise; } catch (_) { return null; }
        }

        // Token already available — return immediately
        if (this._token) return this._token;

        // Turnstile flagged this session as needing interaction — show the bubble
        if (this._needsInteraction) {
            this._show();
            // Resolve any previous pending caller with null before replacing
            this._resolvePending(null);
            return new Promise((resolve) => {
                this._pendingResolve = resolve;
            });
        }

        // Widget still running its invisible check — wait for a callback to fire.
        // Resolve any previous pending caller with null before replacing.
        this._resolvePending(null);
        return new Promise((resolve) => {
            this._pendingResolve = resolve;
            const maxWait = 30000;
            const interval = 200;
            let elapsed = 0;
            const poll = setInterval(() => {
                // Already resolved by a Turnstile callback (success, error, or timeout)
                if (!this._pendingResolve) {
                    clearInterval(poll);
                    return;
                }
                elapsed += interval;
                if (this._token) {
                    clearInterval(poll);
                    this._resolvePending(this._token);
                } else if (this._needsInteraction) {
                    clearInterval(poll);
                    this._show();
                    // _pendingResolve is already set — bubble callback will resolve it
                } else if (elapsed >= maxWait) {
                    clearInterval(poll);
                    this._resolvePending(null);
                }
            }, interval);
        });
    }

    /** Return the current token synchronously, or null. */
    getToken() {
        return this._token || null;
    }

    /** Whether initialization failed and this instance should be recreated. */
    hasInitFailed() {
        return this._initFailed;
    }

    /** Reset the widget so a fresh token is generated on the next requestToken() call. */
    resetToken() {
        this._token = null;
        this._needsInteraction = false;
        if (this._widgetId != null && typeof window.turnstile !== 'undefined') {
            try { window.turnstile.reset(this._widgetId); } catch (_) { /* noop */ }
        }
    }

    /** Tear down everything — widget, DOM, listeners, and the Turnstile script itself. */
    destroy() {
        this._destroyed = true;
        this._removePositionListeners();
        this._resolvePending(null);
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
            this._dismissTimer = null;
        }
        if (this._widgetId != null && typeof window.turnstile !== 'undefined') {
            try { window.turnstile.remove(this._widgetId); } catch (_) { /* noop */ }
        }
        this._widgetId = null;
        this._token = null;
        this._anchor = null;
        this._needsInteraction = false;
        this._visible = false;
        this._backdrop?.remove();
        this._backdrop = null;
        this._bubble?.remove();
        this._bubble = null;
        this._widgetContainer = null;

        // Remove only the script tag we injected. Do not touch the shared
        // `window.turnstile` singleton or global challenge iframes here; those
        // may be in use by another widget elsewhere in the app.
        this._scriptEl?.remove();
        this._scriptEl = null;
    }

    // =========================================================================
    // Script loader
    // =========================================================================

    _ensureTurnstileScript() {
        // If the onload callback already fired, the API is ready.
        if (window[ONLOAD_CALLBACK] === true) return Promise.resolve();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                delete window[ONLOAD_CALLBACK];
                reject(new Error('Turnstile script failed to load'));
            }, SCRIPT_LOAD_TIMEOUT_MS);

            // If another instance already injected the script, just wait for
            // the shared onload callback.  Otherwise inject it now.
            if (!document.querySelector(`script[src*="challenges.cloudflare.com/turnstile"]`)) {
                const script = document.createElement('script');
                script.src = `https://challenges.cloudflare.com/turnstile/v0/api.js?onload=${ONLOAD_CALLBACK}&render=explicit`;
                script.async = true;
                script.defer = true;
                document.head.appendChild(script);
                this._scriptEl = script;
            }

            // Cloudflare calls window[ONLOAD_CALLBACK]() when the API is
            // fully bootstrapped.  We replace the function with `true` so
            // future callers can resolve synchronously above.
            const prev = window[ONLOAD_CALLBACK];
            window[ONLOAD_CALLBACK] = () => {
                clearTimeout(timeout);
                window[ONLOAD_CALLBACK] = true;
                // If a previous instance also registered a callback, call it.
                if (typeof prev === 'function') prev();
                resolve();
            };
        });
    }

    // =========================================================================
    // DOM construction
    // =========================================================================

    _createBubbleDOM() {
        this._backdrop?.remove();
        this._bubble?.remove();

        // Semi-transparent backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'turnstile-backdrop';
        backdrop.style.cssText = [
            'display:none', 'position:fixed', 'inset:0', 'z-index:9999',
            'background:rgba(0,0,0,0.18)',
            'backdrop-filter:blur(2px)', '-webkit-backdrop-filter:blur(2px)',
        ].join(';');
        backdrop.addEventListener('click', () => this._dismiss());
        this._backdrop = backdrop;

        // Bubble — starts offscreen with opacity:0 and pointer-events:none
        // instead of display:none so the container retains layout dimensions.
        // Turnstile needs a layoutable container to render its iframe (600010).
        const bubble = document.createElement('div');
        bubble.className = 'turnstile-bubble';
        bubble.style.cssText = [
            'position:fixed', 'z-index:10000',
            'left:-9999px', 'top:-9999px',
            'opacity:0', 'pointer-events:none',
            `border-radius:${BUBBLE_RADIUS}px`,
            `padding:${BUBBLE_PADDING}px`,
            'background:hsl(var(--color-background) / 0.85)',
            'backdrop-filter:blur(20px) saturate(1.2)',
            '-webkit-backdrop-filter:blur(20px) saturate(1.2)',
            'border:1px solid hsl(var(--color-border))',
            'box-shadow:0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.08)',
            'font-family:inherit', 'font-size:12px',
        ].join(';');
        this._bubble = bubble;

        // Widget render target — scaled down to match the app's text proportions.
        // Turnstile normal size is 300×65; scale to ~85% so "Verify you are human"
        // visually matches the welcome panel's 12–14px text.
        const WIDGET_SCALE = 0.85;
        const widgetContainer = document.createElement('div');
        widgetContainer.className = 'turnstile-widget';
        const scaledW = Math.round(300 * WIDGET_SCALE);
        const scaledH = Math.round(65 * WIDGET_SCALE);
        widgetContainer.style.cssText = [
            `transform:scale(${WIDGET_SCALE})`,
            'transform-origin:top left',
            `width:${300}px`,
            `height:${65}px`,
        ].join(';');
        // Size the bubble exactly to the scaled widget + equal padding on all sides
        bubble.style.width = `${scaledW + BUBBLE_PADDING * 2}px`;
        bubble.style.height = `${scaledH + BUBBLE_PADDING * 2}px`;
        bubble.style.overflow = 'hidden';
        this._widgetContainer = widgetContainer;

        bubble.appendChild(widgetContainer);
        document.body.appendChild(backdrop);
        document.body.appendChild(bubble);
    }

    // =========================================================================
    // Widget rendering
    // =========================================================================

    _renderWidget() {
        if (!this._widgetContainer) return;

        const isDark = document.documentElement.classList.contains('dark');
        this._token = null;
        this._needsInteraction = false;

        this._widgetId = window.turnstile.render(this._widgetContainer, {
            sitekey: TURNSTILE_SITE_KEY,
            theme: isDark ? 'dark' : 'light',
            size: 'normal',
            appearance: 'interaction-only',
            language: 'auto',
            callback: (token) => {
                this._token = token;
                this._needsInteraction = false;
                // Resolve before dismiss — _dismiss() also calls _resolvePending(null),
                // but it's a no-op once _pendingResolve is already cleared.
                this._resolvePending(token);
                this._dismiss();
            },
            'expired-callback': () => {
                this._token = null;
            },
            'error-callback': () => {
                this._token = null;
                this._needsInteraction = false;
                this._resolvePending(null);
                this._dismiss();
            },
            'timeout-callback': () => {
                // Challenge timed out without producing a token.
                // Resolve pending callers with null and return false to
                // stop Cloudflare's automatic retry — the caller will
                // show "Verification failed" and the user can retry.
                this._token = null;
                this._needsInteraction = false;
                this._resolvePending(null);
                this._dismiss();
                return false;
            },
            'before-interactive-callback': () => {
                // Don't show yet — just flag that interaction is needed.
                // If a submit is already waiting, show immediately instead of
                // waiting for the requestToken() poll loop to notice.
                this._needsInteraction = true;
                if (this._pendingResolve) {
                    this._show();
                }
            },
            'after-interactive-callback': () => {
                this._needsInteraction = false;
            },
        });
    }

    // =========================================================================
    // Show / dismiss / position
    // =========================================================================

    _show() {
        if (!this._bubble || !this._backdrop) return;
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
            this._dismissTimer = null;
        }
        if (this._visible) {
            this._position();
            this._addPositionListeners();
            return;
        }
        this._visible = true;
        this._backdrop.style.display = 'block';
        this._bubble.style.pointerEvents = 'auto';
        this._bubble.style.opacity = '0';
        // Position after layout, then animate in
        requestAnimationFrame(() => {
            this._position();
            requestAnimationFrame(() => {
                if (this._bubble) {
                    this._bubble.style.transition = 'opacity 0.15s ease-out';
                    this._bubble.style.opacity = '1';
                }
            });
        });
        this._addPositionListeners();
    }

    _dismiss() {
        if (!this._bubble || !this._backdrop) return;
        this._visible = false;
        this._removePositionListeners();
        this._resolvePending(null);
        this._bubble.style.opacity = '0';
        this._bubble.style.pointerEvents = 'none';
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
        }
        this._dismissTimer = setTimeout(() => {
            if (this._backdrop) this._backdrop.style.display = 'none';
            // Move bubble offscreen when fully faded
            if (this._bubble) {
                this._bubble.style.left = '-9999px';
                this._bubble.style.top = '-9999px';
            }
            this._dismissTimer = null;
        }, 150);
    }

    /** Position centered above the anchor element. */
    _position() {
        if (!this._bubble || !this._anchor) return;

        const anchorRect = this._anchor.getBoundingClientRect();
        const bubbleRect = this._bubble.getBoundingClientRect();
        const vw = window.innerWidth;

        // Place directly above the anchor
        let top = anchorRect.top - bubbleRect.height - BUBBLE_GAP;
        top = Math.max(8, top);

        // Center on the anchor's horizontal midpoint, clamp to viewport
        const anchorMidX = anchorRect.left + anchorRect.width / 2;
        let left = anchorMidX - bubbleRect.width / 2;
        left = Math.max(8, Math.min(left, vw - bubbleRect.width - 8));

        this._bubble.style.left = `${Math.round(left)}px`;
        this._bubble.style.top = `${Math.round(top)}px`;
    }

    _addPositionListeners() {
        if (this._resizeHandler) return;
        this._resizeHandler = () => this._position();
        this._scrollHandler = () => this._position();
        window.addEventListener('resize', this._resizeHandler);
        window.addEventListener('scroll', this._scrollHandler, true);
    }

    _removePositionListeners() {
        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
            this._resizeHandler = null;
        }
        if (this._scrollHandler) {
            window.removeEventListener('scroll', this._scrollHandler, true);
            this._scrollHandler = null;
        }
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    _resolvePending(value) {
        if (this._pendingResolve) {
            this._pendingResolve(value);
            this._pendingResolve = null;
        }
    }
}

export default TurnstileBubble;
