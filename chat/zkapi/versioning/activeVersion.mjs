// The zkAPI protocol version this page runs, as chosen at boot.
//
// Boot installs the choice once, before any zkAPI UI or integration exists.
// Everything else (call-profile validation, deposit gating, state derivation)
// reads it from here instead of being handed it, so there is one answer per
// page. A page that never installs one (the SDK-default build, or a build
// without versioning) reads `null` everywhere, which every consumer treats as
// "the single legacy protocol".
//
// SDK-free: this module is imported by code that must run before any SDK
// module is loaded.
import { getAdapter } from './adapters/index.mjs';

let installed = null;

function invalid(message) {
    const error = new TypeError(message);
    error.code = 'invalid_active_version';
    return error;
}

/**
 * Record the version this page loaded.
 *
 * One SDK build runs per page, so a second install may refresh the selection
 * of the same version but can never change which version is active.
 *
 * @param {{table: object[], version: object, selection: object}} options
 */
export function installActiveVersion({ table, version, selection } = {}) {
    if (!Array.isArray(table) || !table.length) throw invalid('The version table must be a non-empty array.');
    if (!version || typeof version !== 'object' || typeof version.id !== 'string' || !version.id) {
        throw invalid('The active version needs an id.');
    }
    if (!table.some(entry => entry && entry.id === version.id)) {
        throw invalid('The active version is not in the version table.');
    }
    if (!selection || typeof selection !== 'object') throw invalid('The selection is required.');
    if (installed && installed.version.id !== version.id) {
        throw invalid('A different version is already active in this page.');
    }
    installed = {
        table: [...table],
        version,
        selection,
        adapter: null
    };
}

/** The active version row, or null when none was installed. */
export function getActiveVersion() {
    return installed ? installed.version : null;
}

/**
 * The adapter of the active version, or null when none was installed.
 * Throws code `unknown_adapter` when the installed row names an adapter this
 * build does not contain (a build bug, never silently defaulted).
 */
export function getActiveAdapter() {
    if (!installed) return null;
    if (!installed.adapter) installed.adapter = getAdapter(installed.version.adapter);
    return installed.adapter;
}

/**
 * The version table this page was built with (empty when none was installed).
 * A copy: callers may sort or filter it without touching the installed table.
 */
export function getVersionTable() {
    return installed ? [...installed.table] : [];
}

/** The selection that produced the active version, or null. */
export function getSelection() {
    return installed ? installed.selection : null;
}

/** Forget the installed version. Tests only. */
export function resetActiveVersionForTests() {
    installed = null;
}
