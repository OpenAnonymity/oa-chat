/**
 * SmoothProgress — requestAnimationFrame-based progress bar with trickle interpolation.
 *
 * Designed for use with innerHTML-replacing components. After each render cycle
 * destroys the old progress bar DOM, SmoothProgress re-acquires the element by
 * a stable data attribute and continues its rAF loop seamlessly.
 *
 * Algorithm:
 * - On start: immediately shows a small initial value (~2%) for instant feedback
 * - On real updates: displayed value snaps directly to target (no artificial easing
 *   that would make progress appear faster than actual work done)
 * - Between updates: slowly trickles forward, capped at target + 3%
 * - On complete (100%): quickly eases to finish
 */

class SmoothProgress {
    constructor(options = {}) {
        this.barSelector = options.barSelector || '[data-smooth-progress]';
        this.textSelector = options.textSelector || '[data-smooth-progress-text]';

        // Animation state
        this._target = 0;
        this._displayed = 0;
        this._animationId = null;
        this._lastFrameTime = 0;
        this._trickling = false;
        this._running = false;
        this._finished = false;
    }

    start() {
        this.stop();
        this._target = 2;
        this._displayed = 2;
        this._trickling = true;
        this._running = true;
        this._finished = false;
        this._startAnimation();
    }

    set(percent) {
        if (!this._running) return;
        const clamped = Math.max(0, Math.min(100, percent));
        this._target = clamped;
        this._trickling = true;

        if (clamped >= 100) {
            this._finished = true;
            this._trickling = false;
            // Don't snap _displayed — let _tick() ease smoothly to 100%
        } else {
            // Track target directly — the displayed value always equals
            // actual progress. Never go backward (trickle may have advanced
            // _displayed slightly beyond the new target).
            const prev = this._displayed;
            this._displayed = Math.max(this._displayed, clamped);
            // Apply to DOM immediately so progress is visible even when
            // the loop completes faster than the next rAF fires.
            if (this._displayed !== prev) {
                this._applyToDOM();
            }
        }
    }

    getDisplayed() {
        return this._displayed;
    }

    getDisplayedRounded() {
        return Math.round(this._displayed);
    }

    stop() {
        this._running = false;
        this._trickling = false;
        this._finished = false;
        this._target = 0;
        this._displayed = 0;
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
    }

    _startAnimation() {
        if (this._animationId) return;
        this._lastFrameTime = performance.now();
        this._animationId = requestAnimationFrame((t) => this._tick(t));
    }

    _tick(timestamp) {
        if (!this._running) {
            this._animationId = null;
            return;
        }

        // Delta-time normalization: scale relative to 16ms (60fps baseline)
        const delta = Math.min(timestamp - this._lastFrameTime, 50);
        const dtFactor = delta / 16;
        this._lastFrameTime = timestamp;

        const prevDisplayed = this._displayed;

        if (this._finished && this._displayed < this._target) {
            // Finishing: ease quickly to 100%
            const increment = (this._target - this._displayed) * 0.25 * dtFactor;
            this._displayed = Math.min(this._target, this._displayed + Math.max(increment, 0.1));
        } else if (this._trickling && this._displayed >= this._target) {
            // Between updates: slowly creep forward, but cap at target + 3%
            // so trickle never overshoots into the next phase's range.
            const trickleMax = this._target + 3;
            if (this._displayed < trickleMax) {
                const remaining = (trickleMax - this._displayed) / trickleMax;
                const trickle = 0.15 * remaining * remaining * dtFactor;
                this._displayed = Math.min(trickleMax, this._displayed + trickle);
            }
        }
        // When _displayed < _target and not finishing, set() has already
        // updated _displayed directly — no easing needed in the tick loop.

        // Clamp precision
        this._displayed = Math.round(this._displayed * 100) / 100;

        if (this._displayed !== prevDisplayed) {
            this._applyToDOM();
        }

        // Stop loop if finished and fully caught up
        if (this._finished && this._displayed >= 99.9) {
            this._displayed = 100;
            this._applyToDOM();
            this._animationId = null;
            return;
        }

        this._animationId = requestAnimationFrame((t) => this._tick(t));
    }

    _applyToDOM() {
        const bar = document.querySelector(this.barSelector);
        if (bar) {
            bar.style.width = `${this._displayed}%`;
        }
        const text = document.querySelector(this.textSelector);
        if (text) {
            text.textContent = `${Math.round(this._displayed)}% complete`;
        }
    }
}

export default SmoothProgress;
