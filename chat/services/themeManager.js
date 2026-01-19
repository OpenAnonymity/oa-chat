import preferencesStore, { PREF_KEYS } from './preferencesStore.js';

const PREFERENCE_SYSTEM = 'system';
const VALID_PREFERENCES = new Set(['light', 'dark', PREFERENCE_SYSTEM]);

class ThemeManager {
    constructor() {
        this.preference = PREFERENCE_SYSTEM;
        this.mediaQuery = null;
        this.mediaListener = null;
        this.listeners = new Set();
        this.initialized = false;
    }

    init() {
        if (this.initialized || typeof window === 'undefined') {
            return;
        }

        this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        this.mediaListener = () => {
            if (this.preference === PREFERENCE_SYSTEM) {
                this.applyTheme();
                this.notify();
            }
        };

        // Support older browsers
        if (typeof this.mediaQuery.addEventListener === 'function') {
            this.mediaQuery.addEventListener('change', this.mediaListener);
        } else if (typeof this.mediaQuery.addListener === 'function') {
            this.mediaQuery.addListener(this.mediaListener);
        }

        preferencesStore.getPreference(PREF_KEYS.theme).then((storedPreference) => {
            if (storedPreference && VALID_PREFERENCES.has(storedPreference)) {
                this.preference = storedPreference;
                this.applyTheme();
                this.notify();
            }
        });

        // Listen for preference changes (e.g., from import or multi-tab sync)
        preferencesStore.onChange((key, value) => {
            if (key !== PREF_KEYS.theme) return;
            if (value && VALID_PREFERENCES.has(value) && value !== this.preference) {
                this.preference = value;
                this.applyTheme();
                this.notify();
            }
        });

        this.applyTheme();
        this.notify();
        this.initialized = true;
    }

    applyTheme() {
        const root = document.documentElement;
        if (!root) return;

        const effectiveTheme = this.getEffectiveTheme();

        // Disable transitions during theme switch for instant color change
        root.classList.add('switching-theme');

        root.setAttribute('data-theme', effectiveTheme);
        root.setAttribute('data-theme-preference', this.preference);

        if (effectiveTheme === 'dark') {
            root.classList.add('dark');
        } else {
            root.classList.remove('dark');
        }

        if (effectiveTheme === 'light') {
            root.classList.add('theme-light');
            root.classList.remove('theme-dark');
        } else {
            root.classList.add('theme-dark');
            root.classList.remove('theme-light');
        }

        // Re-enable transitions after a frame (colors already applied)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                root.classList.remove('switching-theme');
            });
        });
    }

    setPreference(preference) {
        if (!VALID_PREFERENCES.has(preference)) {
            preference = PREFERENCE_SYSTEM;
        }

        if (this.preference === preference) {
            return;
        }

        this.preference = preference;
        preferencesStore.savePreference(PREF_KEYS.theme, preference);
        this.applyTheme();
        this.notify();
    }

    getPreference() {
        return this.preference;
    }

    getEffectiveTheme() {
        if (this.preference === PREFERENCE_SYSTEM) {
            return this.mediaQuery && this.mediaQuery.matches ? 'dark' : 'light';
        }
        return this.preference;
    }

    onChange(listener) {
        if (typeof listener !== 'function') return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify() {
        const preference = this.preference;
        const effective = this.getEffectiveTheme();
        this.listeners.forEach((listener) => {
            try {
                listener(preference, effective);
            } catch (error) {
                console.error('Theme listener failed:', error);
            }
        });
    }
}

const themeManager = new ThemeManager();
export default themeManager;
