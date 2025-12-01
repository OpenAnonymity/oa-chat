const STORAGE_KEY = 'oa-theme-preference';
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

        const storedPreference = this.safeReadPreference();
        if (storedPreference && VALID_PREFERENCES.has(storedPreference)) {
            this.preference = storedPreference;
        }

        this.applyTheme();
        this.notify();
        this.initialized = true;
    }

    safeReadPreference() {
        try {
            return localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            console.warn('Unable to read stored theme preference:', error);
            return null;
        }
    }

    safeStorePreference(value) {
        try {
            if (value === PREFERENCE_SYSTEM) {
                localStorage.removeItem(STORAGE_KEY);
            } else {
                localStorage.setItem(STORAGE_KEY, value);
            }
        } catch (error) {
            console.warn('Unable to persist theme preference:', error);
        }
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
        this.safeStorePreference(preference);
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
