// FIXTURE ONLY (no counterpart in the real SDK, not reachable from any
// package subpath): the shared call log and the stub factories.
//
// Policy for every fixture module: export exactly the real names. A name is
// either a small verbatim copy of the real code (configure.js, build.mjs, the
// gas, wallet-error, request-compat and withdrawal-root helpers), a constant
// with the real value, a recorded stub (the client and runtime singletons), or
// `unsupported`, which fails loudly instead of returning something a host
// could mistake for protocol behavior.

const log = [];
let sequence = 0;

/** The ordered log of every recorded call: `{seq, target, name, args}`. */
export function fixtureCallLog() {
    return log;
}

export function recordCall(target, name, args) {
    sequence += 1;
    log.push({ seq: sequence, target, name, args });
}

function notImplemented(target, name) {
    return Object.assign(
        new Error(`The zkAPI SDK test fixture does not implement ${target}.${name}().`),
        { code: 'fixture_not_implemented' }
    );
}

/** A function export the fixture does not implement: records the call, then throws. */
export function unsupported(target, name) {
    const stub = function (...args) {
        recordCall(target, name, args);
        throw notImplemented(target, name);
    };
    Object.defineProperty(stub, 'name', { value: name });
    return stub;
}

/**
 * The stubs of one module's unimplemented function exports, made on demand by
 * name so each name is written once, in a destructuring export:
 *
 *   export const { readBrowserWalletSnapshot, parkBrowserWithdrawal } = unsupportedExports('store');
 */
export function unsupportedExports(target) {
    return new Proxy({}, { get: (_, name) => unsupported(target, String(name)) });
}

/**
 * Give `prototype` a recorded stub for every name not already defined there.
 * Names in `strings` return an empty string (display helpers). Defined like
 * class methods (non-enumerable, writable) so a test may shadow one with an
 * own property, as it does on the real singletons.
 */
export function defineRecordedMethods(prototype, target, { async: asyncNames = [], sync: syncNames = [], strings = [] }) {
    const stringNames = new Set(strings);
    const define = (name, value) => {
        if (Object.hasOwn(prototype, name)) return;
        Object.defineProperty(prototype, name, { value, writable: true, configurable: true, enumerable: false });
    };
    for (const name of asyncNames) {
        define(name, {
            async [name](...args) {
                recordCall(target, name, args);
                return undefined;
            }
        }[name]);
    }
    for (const name of syncNames) {
        define(name, {
            [name](...args) {
                recordCall(target, name, args);
                return stringNames.has(name) ? '' : undefined;
            }
        }[name]);
    }
}
