// When to open the oa-clientd dialogs (docs/DAEMON_AUTHORIZATION.md). The address
// is read as soon as this is created, and also on a later hash change, because the
// app rewrites the address during boot. Dialogs wait for the ordinary sign-in flows:
// a new account's own steps, such as saving a recovery code, are never interrupted.
// A request stays pending until the dialog says it took it: one may be mid-approval.
import {
    clearDaemonIntent,
    clearDevicesIntent,
    consumeDaemonIntent,
    consumeDevicesIntent,
    isDaemonIntentFresh
} from '../services/daemonAuthorization.js';

const CHECK_INTERVAL_MS = 500;
// A signed-in browser normally finishes restoring on its own within this time.
const SIGN_IN_PROMPT_DELAY_MS = 3000;

/** The same state the account dialog waits for before it closes after sign-in. */
export function isAccountReadyForDaemon(state) {
    return !!state?.accountId && state.sessionVerified === true && state.status === 'unlocked'
        && state.accountScopeReady === true && !state.busy && !state.accountHandoffPending
        && !state.oauthSetupRequired;
}

export function createDaemonAuthorizationFlow({
    accountService,
    accountModal,
    openAuthorization,
    openDevices,
    windowImpl = globalThis.window,
    consumeIntent = consumeDaemonIntent,
    consumeDevices = consumeDevicesIntent,
    clearIntent = transaction => clearDaemonIntent(undefined, transaction),
    clearDevices = clearDevicesIntent,
    now = () => Date.now(),
    setIntervalImpl = (handler, ms) => setInterval(handler, ms),
    clearIntervalImpl = timer => clearInterval(timer)
}) {
    let intent = consumeIntent();
    let devices = consumeDevices();
    let started = false;
    let timer = null;
    let waitingSince = null;

    const stopWaiting = () => {
        if (timer !== null) clearIntervalImpl(timer);
        timer = null;
        waitingSince = null;
    };

    const check = () => {
        if (intent && !isDaemonIntentFresh(intent, now())) {
            clearIntent(intent.transaction);
            intent = null;
        }
        if (devices && !isDaemonIntentFresh(devices, now())) {
            clearDevices();
            devices = null;
        }
        if (!intent && !devices) {
            stopWaiting();
            return;
        }
        const state = accountService.getState();
        const modal = accountModal();
        if (isAccountReadyForDaemon(state)) {
            // The account dialog closes itself after sign-in; wait out its own steps.
            if (modal?.isOpen) return;
            if (intent) {
                if (openAuthorization(intent) === true) intent = null;
            } else if (openDevices() === true) {
                devices = null;
                clearDevices();
            }
            if (!intent && !devices) stopWaiting();
            return;
        }
        if (modal?.isOpen || state.busy) return;
        if (!state.accountId || now() - waitingSince >= SIGN_IN_PROMPT_DELAY_MS) {
            if (waitingSince !== -1) modal?.open?.();
            // Offered once: closing it is allowed, and signing in later still works.
            waitingSince = -1;
        }
    };

    const schedule = () => {
        if (!started || (!intent && !devices)) return;
        if (timer === null) {
            waitingSince = now();
            timer = setIntervalImpl(check, CHECK_INTERVAL_MS);
        }
        check();
    };

    // A link opened in a tab already showing this app does not reload it.
    windowImpl?.addEventListener?.('hashchange', () => {
        const nextIntent = consumeIntent();
        const nextDevices = consumeDevices();
        if (nextIntent && nextIntent.transaction !== intent?.transaction) intent = nextIntent;
        if (nextDevices) devices = nextDevices;
        schedule();
    });

    return {
        /** Call after the initial account route, so its own dialog comes first. */
        start() {
            started = true;
            schedule();
        },
        pending: () => ({ intent, devices })
    };
}
