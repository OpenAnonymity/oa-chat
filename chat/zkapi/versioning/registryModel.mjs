// Pure model of the zkAPI version registry (deployments/zkapi/registry.json).
//
// One row per protocol generation ("version"), one entry per network inside
// it. Rows are data; the code half of a row is an adapter
// (adapters/*.mjs), looked up by the row's `adapter` id. See
// docs/ZKAPI_VERSIONING.md for the lifecycle and the operator runbooks.
//
// This module has no Node built-ins, SDK imports, network or storage access:
// it runs unchanged in the browser bundle, in plain Node tests and in the
// build scripts. Anything that needs a hash primitive receives it as a
// parameter (see resolveRuntimeTable).
//
// Lifecycle of a row on one network:
//
//   pending    registered, not built, not offered. Carries an inline
//              `not_deployed` config and no activation time.
//   active     deployed; the only status that accepts new deposits. At most
//              one per network: the deposit target.
//   exit-only  deposits closed. Chat, close and escape still work; assets are
//              still shipped.
//   retired    assets removed. A tombstone {deploymentId, chainId, vault} is
//              kept so leftovers of the version are still recognized.
//
// Forward only: a row never moves to an earlier stage, with one exception, the
// rollback `exit-only -> active` of a lower version while every higher live
// version is exit-only. assertForwardOnly compares two registries; it is what
// makes a `git revert` of an activation fail the check it is run in. It also
// holds a row's IDENTITY across the change (deployment, chain, vault, proof
// setup and key pins, and SDK pins of a live row; the tombstone of a retired
// one), because a tombstone is the only way a retired version's leftovers are
// recognized and a typo in it strands whoever holds them.

import { WIRED } from './wiring.mjs';

export const REGISTRY_NETWORKS = Object.freeze(['mainnet', 'sepolia']);

const STAGE = Object.freeze({ pending: 0, active: 1, 'exit-only': 2, retired: 3 });
const LIVE_STATUSES = Object.freeze(['active', 'exit-only']);

// The chain each registry network lives on. A retired version's tombstone is
// how its leftovers are recognized, by {deploymentId, chainId, vault}, so a
// tombstone naming another chain would silently stop recognizing them. The
// adapters' shared profile check pins the same two facts for live rows.
const NETWORK_CHAIN_IDS = Object.freeze({ mainnet: 1, sepolia: 11155111 });

// The SDK's built-in wallet database. It holds retired notes and would be
// refused by the successor SDK, so no registry may resolve to it.
const SDK_DEFAULT_DATABASE = 'zkapi-browser-wallet-v1';

const NETWORK_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LINEAGE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const URL_PATH = /^\/(?:[a-z0-9][a-z0-9._-]*\/)+$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PATCH_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PROFILE_FILE = /^[a-z0-9][a-z0-9._-]*\.json$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const NOTICE_KINDS = Object.freeze(['stuck_escape']);
const NOTICE_TEXT_LIMIT = 280;
const NOTICE_COUNT_LIMIT = 16;

const ROW_KEYS = ['id', 'ordinal', 'label', 'adapter', 'circuitId', 'vaultRevision', 'sdk',
    'publicPath', 'proxyPath', 'transition', 'gate', 'networks'];
const ENTRY_KEYS = ['status', 'activatedAt', 'profile', 'config', 'depositsClosedSince', 'admissionClosesAt',
    'retiredAt', 'tombstone', 'notices'];

/** Every registry problem is a RegistryError with a stable `code`. */
export class RegistryError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RegistryError';
        this.code = code;
    }
}

const fail = (code, message) => { throw new RegistryError(code, message); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPositiveInteger = value => Number.isSafeInteger(value) && value > 0;
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

function onlyKeys(value, allowed, where) {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) fail('schema', `${where} has an unknown field "${key}".`);
    }
}

function requireRecord(value, where) {
    if (!isRecord(value)) fail('schema', `${where} must be an object.`);
    return value;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/**
 * Epoch milliseconds of an ISO-8601 timestamp that names its zone
 * (`2026-09-30T00:00:00Z`, `...+02:00`), or null. Calendar-impossible dates are
 * refused rather than rolled over, because the engine would otherwise turn
 * February 31 into March 3 without a word.
 */
export function parseTimestamp(value) {
    if (typeof value !== 'string') return null;
    const match = TIMESTAMP.exec(value);
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
    if (year < 2000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
    if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
    if (match[8] !== undefined && (Number(match[8]) > 23 || Number(match[9]) > 59)) return null;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
}

function requireTimestamp(value, where) {
    const milliseconds = parseTimestamp(value);
    if (milliseconds === null) fail('schema', `${where} must be an ISO-8601 timestamp with a time zone.`);
    return milliseconds;
}

// ---------------------------------------------------------------------------
// Shape checks (unknown fields are refused: a typo such as depositClosedSince
// would otherwise silently disable the rule it was meant to set)
// ---------------------------------------------------------------------------

function checkSdk(sdk, where) {
    requireRecord(sdk, where);
    onlyKeys(sdk, ['alias', 'source', 'revision', 'storeSha256', 'patches', 'honorsDepositsFlag'], where);
    if (typeof sdk.alias !== 'string' || !NPM_NAME.test(sdk.alias)) fail('schema', `${where}.alias must be a package name.`);
    if (sdk.source !== null && (typeof sdk.source !== 'string' || !sdk.source || sdk.source.length > 300
        || /\s/.test(sdk.source))) fail('schema', `${where}.source must be a dependency specifier or null.`);
    if (sdk.revision !== null && !GIT_REVISION.test(sdk.revision ?? '')) {
        fail('schema', `${where}.revision must be a 40-digit commit hash or null.`);
    }
    if (sdk.storeSha256 !== null && !SHA256_HEX.test(sdk.storeSha256 ?? '')) {
        fail('schema', `${where}.storeSha256 must be a SHA-256 hex digest or null.`);
    }
    if (!Array.isArray(sdk.patches) || sdk.patches.some(name => typeof name !== 'string' || !PATCH_NAME.test(name))
        || new Set(sdk.patches).size !== sdk.patches.length) {
        fail('schema', `${where}.patches must be a list of unique patch names.`);
    }
    if (typeof sdk.honorsDepositsFlag !== 'boolean') fail('schema', `${where}.honorsDepositsFlag must be a boolean.`);
}

// A row's transition policy. The two optional abandon keys are data of the
// row, shared by its networks:
//
//   dustThresholdUsdMicros  the value below which a balance on an exit-only
//                           version is "dust" the person may give up, in
//                           millionths of a dollar. Absent means the smallest
//                           chat key; 0 turns the dust leg off (an empty
//                           balance can still be cleared). The upper bound
//                           belongs to the family, so validateRegistry checks
//                           it once the adapter is known (checkAbandonData).
//   abandonEnabled          false turns the give-up action off for the row.
function checkTransition(transition, where) {
    requireRecord(transition, where);
    onlyKeys(transition, ['closeByMarginSeconds', 'reminderDays', 'promptWindowDays', 'dustThresholdUsdMicros',
        'abandonEnabled'], where);
    if (transition.dustThresholdUsdMicros !== undefined && !isNonNegativeInteger(transition.dustThresholdUsdMicros)) {
        fail('transition', `${where}.dustThresholdUsdMicros must be a whole number of millionths of a dollar.`);
    }
    if (transition.abandonEnabled !== undefined && typeof transition.abandonEnabled !== 'boolean') {
        fail('transition', `${where}.abandonEnabled must be true or false.`);
    }
    if (!isNonNegativeInteger(transition.closeByMarginSeconds) || transition.closeByMarginSeconds > 90 * 86_400) {
        fail('transition', `${where}.closeByMarginSeconds must be between 0 and 90 days.`);
    }
    if (!isPositiveInteger(transition.promptWindowDays) || transition.promptWindowDays > 366) {
        fail('transition', `${where}.promptWindowDays must be between 1 and 366 days.`);
    }
    const days = transition.reminderDays;
    if (!Array.isArray(days) || days.length > 8 || days.some(day => !isPositiveInteger(day) || day > 366)
        || days.some((day, index) => index > 0 && day >= days[index - 1])) {
        fail('transition', `${where}.reminderDays must be strictly decreasing day counts.`);
    }
    if (days.length && days[0] > transition.promptWindowDays) {
        fail('transition', `${where}.reminderDays must start inside promptWindowDays.`);
    }
}

function checkGate(gate, where) {
    requireRecord(gate, where);
    onlyKeys(gate, ['recoveryReview', 'protocolWiring', 'manifestSha256'], where);
    const review = requireRecord(gate.recoveryReview, `${where}.recoveryReview`);
    onlyKeys(review, ['revision', 'verdict', 'patch'], `${where}.recoveryReview`);
    if (review.revision !== null && !GIT_REVISION.test(review.revision ?? '')) {
        fail('schema', `${where}.recoveryReview.revision must be a 40-digit commit hash or null.`);
    }
    if (!['pending', 'patched', 'not_required'].includes(review.verdict)) {
        fail('schema', `${where}.recoveryReview.verdict must be pending, patched or not_required.`);
    }
    if (review.patch !== null && (typeof review.patch !== 'string' || !PATCH_NAME.test(review.patch))) {
        fail('schema', `${where}.recoveryReview.patch must be a patch name or null.`);
    }
    if (!['pending', 'done', 'not_applicable'].includes(gate.protocolWiring)) {
        fail('schema', `${where}.protocolWiring must be pending, done or not_applicable.`);
    }
    if (gate.manifestSha256 !== null && !SHA256_HEX.test(gate.manifestSha256 ?? '')) {
        fail('schema', `${where}.manifestSha256 must be a SHA-256 hex digest or null.`);
    }
}

function checkRowShape(row, index, networks) {
    const where = `versions[${index}]`;
    requireRecord(row, where);
    onlyKeys(row, ROW_KEYS, where);
    if (typeof row.id !== 'string' || !VERSION_ID.test(row.id)) fail('schema', `${where}.id must be a short lowercase id.`);
    const name = `version ${row.id}`;
    if (!isPositiveInteger(row.ordinal)) fail('ordinal', `${name} needs a positive integer ordinal.`);
    if (typeof row.label !== 'string' || !row.label || row.label.length > 64 || CONTROL_CHARACTERS.test(row.label)) {
        fail('schema', `${name} needs a short plain-text label.`);
    }
    for (const field of ['adapter', 'circuitId']) {
        if (typeof row[field] !== 'string' || !row[field]) fail('schema', `${name}.${field} must be a non-empty string.`);
    }
    if (!isPositiveInteger(row.vaultRevision)) fail('schema', `${name}.vaultRevision must be a positive integer.`);
    checkSdk(row.sdk, `${name}.sdk`);
    for (const field of ['publicPath', 'proxyPath']) {
        if (typeof row[field] !== 'string' || !URL_PATH.test(row[field])) {
            fail('schema', `${name}.${field} must be an absolute directory path such as /zkapi/v2c/.`);
        }
    }
    checkTransition(row.transition, `${name}.transition`);
    checkGate(row.gate, `${name}.gate`);
    requireRecord(row.networks, `${name}.networks`);
    const present = Object.keys(row.networks).sort();
    if (present.join('|') !== [...networks].sort().join('|')) {
        fail('schema', `${name}.networks must have exactly: ${networks.join(', ')}.`);
    }
}

function checkNotices(notices, where) {
    if (!Array.isArray(notices) || notices.length > NOTICE_COUNT_LIMIT) {
        fail('notice', `${where}.notices must be a short list.`);
    }
    notices.forEach((notice, index) => {
        const at = `${where}.notices[${index}]`;
        requireRecord(notice, at);
        onlyKeys(notice, ['kind', 'noteId', 'destination', 'expiresAt', 'text'], at);
        if (!NOTICE_KINDS.includes(notice.kind)) fail('notice', `${at}.kind is not a known notice kind.`);
        if (!isNonNegativeInteger(notice.noteId)) fail('notice', `${at}.noteId must be a note number.`);
        if (typeof notice.destination !== 'string' || !ADDRESS.test(notice.destination)) {
            fail('notice', `${at}.destination must be an address.`);
        }
        if (parseTimestamp(notice.expiresAt) === null) fail('notice', `${at}.expiresAt must be an ISO-8601 timestamp.`);
        if (typeof notice.text !== 'string' || !notice.text.trim() || notice.text.length > NOTICE_TEXT_LIMIT
            || CONTROL_CHARACTERS.test(notice.text)) {
            fail('notice', `${at}.text must be plain text of at most ${NOTICE_TEXT_LIMIT} characters.`);
        }
    });
}

// ---------------------------------------------------------------------------
// Lifecycle and field rules per entry (codes status, status_fields,
// activation_time, retired_fields, notice)
// ---------------------------------------------------------------------------

function checkEntry(row, network, entry) {
    const where = `${row.id} on ${network}`;
    requireRecord(entry, where);
    onlyKeys(entry, ENTRY_KEYS, where);
    const status = entry.status;
    if (!hasOwn(STAGE, status)) fail('status', `${where} has an unknown status.`);
    const has = key => entry[key] !== undefined;
    const forbid = (...keys) => {
        for (const key of keys) {
            if (has(key)) fail('status_fields', `${where} is ${status} and cannot carry ${key}.`);
        }
    };

    if (has('profile') && (typeof entry.profile !== 'string' || !PROFILE_FILE.test(entry.profile))) {
        fail('schema', `${where}.profile must be a profile file name.`);
    }
    if (has('config') && !isRecord(entry.config)) fail('schema', `${where}.config must be an object.`);
    const times = {};
    for (const key of ['activatedAt', 'depositsClosedSince', 'admissionClosesAt', 'retiredAt']) {
        if (has(key)) times[key] = requireTimestamp(entry[key], `${where}.${key}`);
    }

    // Notices relax the deposit gate for a stuck escape, so they only make
    // sense on a version that is draining (code `notice`).
    if (has('notices') && status !== 'exit-only') {
        fail('notice', `${where} is ${status}; notices belong to exit-only versions.`);
    }

    if (status === 'pending') {
        // A row that was ever activated can never be pending again.
        if (has('activatedAt')) fail('activation_time', `${where} is pending and cannot have been activated.`);
        forbid('profile', 'depositsClosedSince', 'admissionClosesAt', 'retiredAt', 'tombstone');
        const placeholder = isRecord(entry.config)
            && (entry.config.deployment_status === 'not_deployed'
                || entry.config.trusted_deployment?.deployment_status === 'not_deployed');
        if (!placeholder) fail('pending_shape', `${where} is pending and needs a not_deployed config.`);
        return times;
    }

    if (!has('activatedAt')) fail('activation_time', `${where} is ${status} and needs activatedAt.`);
    if (status !== 'retired') {
        if (has('profile') === has('config')) {
            fail('profile_source', `${where} needs exactly one of profile and config.`);
        }
        if (has('config') && (entry.config.deployment_status === 'not_deployed'
            || entry.config.trusted_deployment?.deployment_status === 'not_deployed')) {
            fail('profile', `${where} is ${status} but its config is a not_deployed placeholder.`);
        }
    }
    if (status === 'active') {
        forbid('depositsClosedSince', 'retiredAt', 'tombstone');
    } else if (status === 'exit-only') {
        if (!has('depositsClosedSince')) fail('exit_only_fields', `${where} is exit-only and needs depositsClosedSince.`);
        forbid('retiredAt', 'tombstone');
    } else {
        if (!has('retiredAt')) fail('retired_fields', `${where} is retired and needs retiredAt.`);
        forbid('profile', 'config', 'admissionClosesAt');
        const tombstone = requireRecord(entry.tombstone, `${where}.tombstone`);
        onlyKeys(tombstone, ['deploymentId', 'chainId', 'vault'], `${where}.tombstone`);
        if (typeof tombstone.deploymentId !== 'string' || !tombstone.deploymentId
            || !isPositiveInteger(tombstone.chainId) || typeof tombstone.vault !== 'string'
            || !ADDRESS.test(tombstone.vault)) {
            fail('retired_fields', `${where} is retired and needs a tombstone with deploymentId, chainId and vault.`);
        }
    }
    if (has('depositsClosedSince') && times.depositsClosedSince < times.activatedAt) {
        fail('activation_time', `${where} closed deposits before it was activated.`);
    }
    if (has('retiredAt') && times.retiredAt < times.activatedAt) {
        fail('activation_time', `${where} was retired before it was activated.`);
    }
    if (has('notices')) checkNotices(entry.notices, where);
    return times;
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

function profileFor(row, network, entry, profiles) {
    if (isRecord(entry.config)) return entry.config;
    const config = isRecord(profiles) && hasOwn(profiles, entry.profile) ? profiles[entry.profile] : undefined;
    if (!isRecord(config)) {
        fail('profile_missing', `${row.id} on ${network} names profile ${entry.profile}, which was not provided.`);
    }
    return config;
}

function trustedPins(config, where) {
    const pins = config?.trusted_deployment;
    if (!isRecord(pins)) fail('profile', `${where} has no trusted_deployment pins.`);
    return pins;
}

function protocolOrigin(pins, where) {
    try {
        return new URL(pins.protocol_server_url).origin;
    } catch {
        return fail('profile', `${where} has an invalid protocol origin.`);
    }
}

// ---------------------------------------------------------------------------
// validateRegistry
// ---------------------------------------------------------------------------

/**
 * Validate a registry against its profiles and adapters; returns the registry
 * or throws a RegistryError. Run by tests and by every build.
 *
 * options:
 *   profiles   profile file name -> reviewed profile object (rows that
 *              reference a profile file; inline `config` needs none)
 *   adapters   (id) => Adapter; throws for an unknown id (getAdapter)
 *   wired      names of implemented protocol wiring; defaults to WIRED
 *   networks   defaults to REGISTRY_NETWORKS
 *   lineage    when given, the registry's lineage must equal it (the
 *              OA_ZKAPI_DEPLOYMENT the build accepted)
 */
export function validateRegistry(registry, options = {}) {
    const { profiles = {}, adapters, wired = WIRED, networks = REGISTRY_NETWORKS, lineage = null } = options;
    if (typeof adapters !== 'function') fail('schema', 'validateRegistry needs an adapter resolver.');
    if (!Array.isArray(networks) || !networks.length || networks.some(name => !NETWORK_NAME.test(name))) {
        fail('schema', 'validateRegistry needs a list of network names.');
    }

    requireRecord(registry, 'The registry');
    onlyKeys(registry, ['schema', 'lineage', 'walletDatabase', 'walletDatabaseVersion', 'versions'], 'The registry');
    if (registry.schema !== 1) fail('schema', 'Only registry schema 1 is supported.');
    // Lineage (code `lineage`).
    if (typeof registry.lineage !== 'string' || !LINEAGE.test(registry.lineage)) {
        fail('lineage', 'The registry lineage must be a short lowercase id.');
    }
    if (lineage !== null && registry.lineage !== lineage) {
        fail('lineage', 'The registry lineage does not match the selected deployment.');
    }
    // Wallet database (code `wallet_namespace`): one lineage-level name
    // template and one version. Every network gets its own database, never
    // the SDK default.
    if (!isPositiveInteger(registry.walletDatabaseVersion)) {
        fail('wallet_namespace', 'walletDatabaseVersion must be a positive integer.');
    }
    const databases = new Set();
    for (const network of networks) {
        const name = walletDatabaseName(registry, network);
        if (databases.has(name)) fail('wallet_namespace', 'Networks must not share a wallet database.');
        databases.add(name);
    }
    if (!Array.isArray(registry.versions) || !registry.versions.length || registry.versions.length > 32) {
        fail('schema', 'The registry needs between 1 and 32 versions.');
    }

    const rows = registry.versions;
    rows.forEach((row, index) => checkRowShape(row, index, networks));

    // Ordinals strictly increase and ids are unique (codes `ordinal`,
    // `duplicate_id`). The npm alias and both URL paths are unique across
    // every row, retired ones included: a reused public path would alias
    // force-cached proving keys of another deployment.
    const seen = { id: new Set(), alias: new Set(), publicPath: new Set(), proxyPath: new Set() };
    rows.forEach((row, index) => {
        if (index > 0 && row.ordinal <= rows[index - 1].ordinal) {
            fail('ordinal', 'Version ordinals must strictly increase.');
        }
        if (seen.id.has(row.id)) fail('duplicate_id', `Version id ${row.id} is used twice.`);
        seen.id.add(row.id);
        for (const [kind, value] of [['alias', row.sdk.alias], ['publicPath', row.publicPath], ['proxyPath', row.proxyPath]]) {
            if (seen[kind].has(value)) {
                fail(kind === 'alias' ? 'duplicate_alias' : 'path_collision', `${kind} ${value} is used by two versions.`);
            }
            seen[kind].add(value);
        }
    });
    // No prefix relation between a public path and a proxy path (a proxy
    // rewrite would capture, or be shadowed by, the assets) nor between two
    // proxy paths (the first rewrite would swallow the second). Public paths
    // may nest: /zkapi/v2c/ lives under /zkapi/ by design.
    const related = (left, right) => left.startsWith(right) || right.startsWith(left);
    rows.forEach((row, index) => {
        for (const other of rows) {
            if (related(row.publicPath, other.proxyPath)) {
                fail('path_collision', `The public path of ${row.id} overlaps the proxy path of ${other.id}.`);
            }
        }
        for (const other of rows.slice(index + 1)) {
            if (related(row.proxyPath, other.proxyPath)) {
                fail('path_collision', `The proxy paths of ${row.id} and ${other.id} overlap.`);
            }
        }
    });

    // The adapter family of every row must exist and agree with the row.
    const adapterOf = new Map();
    for (const row of rows) {
        let adapter;
        try {
            adapter = adapters(row.adapter);
        } catch {
            return fail('unknown_adapter', `Version ${row.id} names an unknown adapter.`);
        }
        if (!isRecord(adapter) || typeof adapter.validateProfile !== 'function' || adapter.id !== row.adapter
            || adapter.circuitId !== row.circuitId || adapter.vaultRevision !== row.vaultRevision) {
            fail('adapter_mismatch', `Version ${row.id} does not match the ${row.adapter} adapter's circuit and vault revision.`);
        }
        checkAbandonData(row, adapter);
        adapterOf.set(row.id, adapter);
    }

    for (const network of networks) {
        // Identities (code `identity_collision`) are unique per network: each
        // network has its own wallet database, build and served config, and a
        // vault key already carries its chain id, so the same deployment id on
        // mainnet and sepolia can never be confused for one deployment. (A
        // network-agnostic id chosen for a new deployment is therefore
        // allowed.)
        const identities = new Map();    // 'deployment:<id>' | 'vault:<chain>:<address>' -> row id
        const claimIdentity = (key, label, where) => {
            if (identities.has(key)) fail('identity_collision', `${where} reuses ${label} of ${identities.get(key)}.`);
            identities.set(key, where);
        };
        // Lifecycle, field and notice rules, per entry.
        const entries = rows.map(row => {
            checkEntry(row, network, row.networks[network]);
            return { row, entry: row.networks[network] };
        });
        // At most one active version, so every other live version is
        // exit-only; in particular every live version newer than the active
        // one is, which is what admits the rollback state.
        if (entries.filter(({ entry }) => entry.status === 'active').length > 1) {
            fail('multiple_active', `Network ${network} has more than one active version.`);
        }
        // A network with nothing live (every row pending or retired) has no
        // build to load and no deposit target. The runtime table would also
        // be empty or tombstones-only, and an empty table means "legacy SDK
        // defaults" to the boot, so refuse it here instead of letting that
        // reading happen.
        if (!entries.some(({ entry }) => LIVE_STATUSES.includes(entry.status))) {
            fail('no_live_version', `Network ${network} has no live version.`);
        }

        const origins = new Map();
        const liveChains = new Set();
        const tombstones = [];
        let inferenceBase;
        let chargeCap;
        for (const { row, entry } of entries) {
            const where = `${row.id} on ${network}`;
            if (entry.status === 'pending') continue;
            if (entry.status === 'retired') {
                const { deploymentId, chainId, vault } = entry.tombstone;
                tombstones.push({ where, chainId });
                claimIdentity(`deployment:${deploymentId}`, 'a deployment id', where);
                claimIdentity(`vault:${chainId}:${vault.toLowerCase()}`, 'a vault', where);
                continue;
            }

            // The profile must pass its adapter (code `profile`).
            const adapter = adapterOf.get(row.id);
            const config = profileFor(row, network, entry, profiles);
            try {
                adapter.validateProfile(config, { network, proxyPath: row.proxyPath, strict: true });
            } catch (error) {
                const failure = new RegistryError('profile', `${where}: ${error?.message || 'The profile was refused.'}`);
                failure.cause = error;
                throw failure;
            }
            const pins = trustedPins(config, where);
            if (pins.circuit_id !== row.circuitId) fail('profile', `${where}: the profile pins another circuit.`);
            liveChains.add(pins.chain_id);

            // Identity (code `identity_collision`).
            claimIdentity(`deployment:${pins.deployment_id}`, 'a deployment id', where);
            claimIdentity(`vault:${pins.chain_id}:${String(pins.contract_address).toLowerCase()}`, 'a vault', where);
            const origin = protocolOrigin(pins, where);
            if (origins.has(origin)) fail('identity_collision', `${where} shares its protocol origin with ${origins.get(origin)}.`);
            origins.set(origin, where);

            // Request-visible parameters stay identical across versions (code
            // `parameter_mismatch`).
            if (inferenceBase === undefined) {
                inferenceBase = pins.openrouter_inference_base;
                chargeCap = pins.request_charge_cap;
            } else if (pins.openrouter_inference_base !== inferenceBase || pins.request_charge_cap !== chargeCap) {
                fail('parameter_mismatch', `${where} differs from the other live versions in an inference base or charge cap.`);
            }

            // Activation gates (codes `sdk_pin` and `gate_*`).
            checkLiveGate(row, entry, adapter, wired, where);
        }

        // A tombstone is on the network's own chain (code `retired_fields`).
        // Registry networks have a known chain; any other name must agree
        // with its live rows.
        const known = hasOwn(NETWORK_CHAIN_IDS, network) ? NETWORK_CHAIN_IDS[network] : null;
        for (const { where, chainId } of tombstones) {
            const matches = known !== null ? chainId === known : liveChains.size === 1 && liveChains.has(chainId);
            if (!matches) fail('retired_fields', `${where}: the tombstone chain id is not the chain of ${network}.`);
        }
    }
    return registry;
}

// A dust threshold is bounded by the family's smallest chat key: a person may
// give up less than they could still spend, never more. A family that carries
// no abandon data cannot bound it, so a row of such a family names none.
function checkAbandonData(row, adapter) {
    const threshold = row.transition.dustThresholdUsdMicros;
    if (threshold === undefined) return;
    const tier = isRecord(adapter.abandon) ? adapter.abandon.smallestChatTierUsdMicros : undefined;
    if (!isNonNegativeInteger(tier) || threshold > tier) {
        fail('transition', `version ${row.id}.transition.dustThresholdUsdMicros must not exceed the smallest chat key`
            + ` of the ${adapter.id} family.`);
    }
}

function checkLiveGate(row, entry, adapter, wired, where) {
    const { sdk, gate } = row;
    if (sdk.source === null || sdk.revision === null || sdk.storeSha256 === null) {
        fail('sdk_pin', `${where} is ${entry.status} but its SDK source, revision and store hash are not all pinned.`);
    }
    if (!sdk.source.endsWith(`#${sdk.revision}`)) {
        fail('sdk_pin', `${where}: the SDK source must name its pinned revision.`);
    }
    const review = gate.recoveryReview;
    if (review.revision !== sdk.revision) {
        fail('gate_recovery_review', `${where}: the recovery review covers another SDK revision.`);
    }
    if (review.verdict === 'patched') {
        if (!review.patch || !sdk.patches.includes(review.patch)) {
            fail('gate_recovery_review', `${where}: the reviewed recovery patch is not applied to this SDK.`);
        }
    } else if (review.verdict === 'not_required') {
        if (review.patch !== null) fail('gate_recovery_review', `${where}: a review that needs no patch names none.`);
    } else {
        fail('gate_recovery_review', `${where}: the recovery review is not complete.`);
    }
    if (!['done', 'not_applicable'].includes(gate.protocolWiring)) {
        fail('gate_wiring', `${where}: protocol wiring is not complete.`);
    }
    const required = Array.isArray(adapter.requiredWiring) ? adapter.requiredWiring : [];
    if (required.some(name => !wired || typeof wired.has !== 'function' || !wired.has(name))) {
        fail('gate_wiring', `${where}: the ${adapter.id} wiring is not implemented in this build.`);
    }
    if (gate.protocolWiring === 'not_applicable' && required.length) {
        fail('gate_wiring', `${where}: ${adapter.id} requires wiring, so it cannot be not_applicable.`);
    }
    if (adapter.requiresManifestSha256 === true) {
        if (gate.manifestSha256 === null) fail('gate_manifest', `${where}: the finalized manifest hash is missing.`);
    } else if (gate.manifestSha256 !== null) {
        fail('gate_manifest', `${where}: ${adapter.id} has no finalized manifest to pin.`);
    }
}

// ---------------------------------------------------------------------------
// Forward-only check (code `forward_only`)
// ---------------------------------------------------------------------------

function registryRows(registry, label) {
    if (!isRecord(registry) || !Array.isArray(registry.versions)) fail('schema', `The ${label} registry has no versions.`);
    return registry.versions;
}

// The reviewed profile a row carries on one network: its inline config, or the
// profile file it names. null when neither can be read.
function configOf(entry, profiles) {
    if (isRecord(entry.config)) return entry.config;
    if (typeof entry.profile === 'string' && isRecord(profiles) && hasOwn(profiles, entry.profile)) {
        return profiles[entry.profile];
    }
    return null;
}

// The deployment a row names on one network, from the config it carries or
// the reviewed profile file it points at, in the shape of a tombstone
// (`vault` lower-cased so the comparison ignores checksum casing). Never
// guessed: an identity that cannot be read is an error, because a check that
// cannot see what it compares must not pass.
function identityOf(entry, profiles, where) {
    const config = configOf(entry, profiles);
    const pins = isRecord(config) && isRecord(config.trusted_deployment) ? config.trusted_deployment : null;
    if (!pins || typeof pins.deployment_id !== 'string' || !pins.deployment_id
        || !isPositiveInteger(pins.chain_id) || typeof pins.contract_address !== 'string'
        || !ADDRESS.test(pins.contract_address)) {
        const missing = typeof entry.profile === 'string' && !(isRecord(profiles) && hasOwn(profiles, entry.profile));
        fail('identity_unverified', `${where}: its deployment, chain and vault could not be read`
            + `${missing ? ` (profile ${entry.profile} was not provided)` : ''}, so the change cannot be checked`
            + ' against them.');
    }
    return { deploymentId: pins.deployment_id, chainId: pins.chain_id, vault: pins.contract_address.toLowerCase() };
}

// The pins that tie a profile to the keys its vault verifies proofs against:
// the proof setup, the proving and verifying key hashes, and the verifying key
// hashes the vault itself pins on chain. A vault is deployed once with one key
// set and cannot be switched to another (a development setup cannot become
// mpc-1 in place), so a profile that pins other keys under the same deployment
// id and vault would send proofs the vault's verifier rejects.
const PROOF_PIN_FIELDS = Object.freeze([
    'setup_id', 'request_proving_key_sha256', 'withdrawal_proving_key_sha256',
    'request_verifying_key_sha256', 'request_vk_keccak256', 'withdrawal_vk_keccak256'
]);

// Names of the proof pins that differ between the profiles two entries carry.
// Hashes compare without regard to case (the SDK reads them that way);
// anything absent on both sides is the same. Only called for entries whose
// identity was already read.
function changedProofPins(before, beforeProfiles, after, afterProfiles) {
    const read = (entry, profiles) => {
        const pins = configOf(entry, profiles)?.trusted_deployment;
        return isRecord(pins) ? pins : {};
    };
    const was = read(before, beforeProfiles);
    const now = read(after, afterProfiles);
    const comparable = (pins, name) => (name !== 'setup_id' && typeof pins[name] === 'string'
        ? pins[name].toLowerCase() : pins[name]);
    return PROOF_PIN_FIELDS.filter(name => comparable(was, name) !== comparable(now, name));
}

function tombstoneOf(entry) {
    const tombstone = entry.tombstone;
    if (!isRecord(tombstone) || typeof tombstone.deploymentId !== 'string' || !isPositiveInteger(tombstone.chainId)
        || typeof tombstone.vault !== 'string') {
        return null;
    }
    return { deploymentId: tombstone.deploymentId, chainId: tombstone.chainId, vault: tombstone.vault.toLowerCase() };
}

function sameIdentity(left, right) {
    return left !== null && right !== null && left.deploymentId === right.deploymentId
        && left.chainId === right.chainId && left.vault === right.vault;
}

/**
 * Throw unless `next` is a legitimate successor of `base`: no non-pending row
 * disappears, changes its ordinal or protocol, or moves to an earlier
 * lifecycle stage, and the wallet namespace is unchanged. The one allowed
 * backward move is the rollback of a lower version, `exit-only -> active`,
 * while every higher live version is exit-only. Identity is held too:
 *
 *   - a row that was live (`active` or `exit-only`) and is `retired` in `next`
 *     must carry a tombstone equal to the deployment id, chain id and vault
 *     the base row named (`tombstone_mismatch`; never overridable);
 *   - a row that is live in both must keep its deployment id, chain id, vault,
 *     proof setup and proof key pins (setup id, proving and verifying key
 *     hashes) and its SDK `revision` and `storeSha256`, and a row that is
 *     retired in both must keep its tombstone (`identity_changed`). A vault
 *     verifies proofs against the keys it was deployed with, so another setup
 *     or key set is another vault, which is a new version. A legitimate SDK pin
 *     bump needs `allowIdentityChange`, and so does a reviewed correction.
 *
 * Both registries should already pass validateRegistry; this compares them
 * only. Profile-file rows are read from `baseProfiles` / `nextProfiles` (file
 * name -> reviewed profile), the profiles each side was committed with: a row
 * whose identity cannot be read fails with `identity_unverified`.
 * scripts/zkapi-registry-cli.mjs runs it against a git ref.
 *
 * @param {object} base
 * @param {object} next
 * @param {{baseProfiles?: Record<string, object>, nextProfiles?: Record<string, object>,
 *   allowIdentityChange?: boolean}} [options]
 */
export function assertForwardOnly(base, next, options = {}) {
    const given = isRecord(options) ? options : {};
    const baseProfiles = isRecord(given.baseProfiles) ? given.baseProfiles : {};
    const nextProfiles = isRecord(given.nextProfiles) ? given.nextProfiles : {};
    const allowIdentityChange = given.allowIdentityChange === true;
    const baseRows = registryRows(base, 'base');
    const nextRows = registryRows(next, 'next');
    if (base.lineage !== next.lineage || base.walletDatabase !== next.walletDatabase
        || base.walletDatabaseVersion !== next.walletDatabaseVersion) {
        fail('forward_only', 'The wallet namespace (lineage, database name or version) cannot change.');
    }
    const nextById = new Map(nextRows.map(row => [row?.id, row]));
    for (const baseRow of baseRows) {
        if (!isRecord(baseRow) || !isRecord(baseRow.networks)) fail('schema', 'The base registry has a malformed version.');
        const nextRow = nextById.get(baseRow.id);
        for (const [network, entry] of Object.entries(baseRow.networks)) {
            const was = entry?.status;
            if (!hasOwn(STAGE, was)) fail('schema', `The base registry has an unknown status for ${baseRow.id} on ${network}.`);
            // A version that never left pending can be reshaped or dropped.
            if (was === 'pending') continue;
            const where = `${baseRow.id} on ${network}`;
            if (!isRecord(nextRow) || !isRecord(nextRow.networks) || !isRecord(nextRow.networks[network])) {
                fail('forward_only', `${where} was removed.`);
            }
            if (nextRow.ordinal !== baseRow.ordinal || nextRow.adapter !== baseRow.adapter
                || nextRow.circuitId !== baseRow.circuitId) {
                fail('forward_only', `${where} changed its ordinal or protocol.`);
            }
            const nextEntry = nextRow.networks[network];
            const now = nextEntry.status;
            if (!hasOwn(STAGE, now)) fail('schema', `The next registry has an unknown status for ${where}.`);
            if (STAGE[now] < STAGE[was]) {
                const higherLive = nextRows.filter(other => isRecord(other) && other.ordinal > nextRow.ordinal
                    && LIVE_STATUSES.includes(other.networks?.[network]?.status));
                const rollback = was === 'exit-only' && now === 'active' && higherLive.length > 0
                    && higherLive.every(other => other.networks[network].status === 'exit-only');
                if (!rollback) fail('forward_only', `${where} moved back from ${was} to ${now}.`);
            }

            // Identity continuity.
            const wasLive = LIVE_STATUSES.includes(was);
            const nowLive = LIVE_STATUSES.includes(now);
            if (wasLive && now === 'retired') {
                // The tombstone is how leftovers of this deployment are found
                // afterwards: it must name the deployment that was live.
                const named = identityOf(entry, baseProfiles, `${where} in the base registry`);
                if (!sameIdentity(named, tombstoneOf(nextEntry))) {
                    fail('tombstone_mismatch', `${where} is retired with a tombstone that does not name the`
                        + ' deployment id, chain id and vault it had while live.');
                }
            } else if (was === 'retired' && now === 'retired') {
                if (!allowIdentityChange && !sameIdentity(tombstoneOf(entry), tombstoneOf(nextEntry))) {
                    fail('identity_changed', `${where} changed its tombstone. A retired version's tombstone`
                        + ' is how its leftovers are recognized; a reviewed correction needs the override.');
                }
            } else if (wasLive && nowLive && !allowIdentityChange) {
                const before = identityOf(entry, baseProfiles, `${where} in the base registry`);
                const after = identityOf(nextEntry, nextProfiles, `${where} in the next registry`);
                if (!sameIdentity(before, after)) {
                    fail('identity_changed', `${where} changed its deployment id, chain id or vault. A different`
                        + ' deployment is a new version, not an edit of this one.');
                }
                const changedPins = changedProofPins(entry, baseProfiles, nextEntry, nextProfiles);
                if (changedPins.length) {
                    fail('identity_changed', `${where} changed its proof setup or key pins (${changedPins.join(', ')}).`
                        + ' A vault verifies proofs against the keys it was deployed with, so another setup or key set'
                        + ' is a different vault, which is a new version, not an edit of this one.');
                }
                const sdk = isRecord(baseRow.sdk) ? baseRow.sdk : {};
                const nextSdk = isRecord(nextRow.sdk) ? nextRow.sdk : {};
                if (sdk.revision !== nextSdk.revision || sdk.storeSha256 !== nextSdk.storeSha256) {
                    fail('identity_changed', `${where} changed its pinned SDK revision or wallet store hash.`
                        + ' That is a reviewed change and needs the override.');
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Derivations (docs/ZKAPI_VERSIONING.md, "Derived values")
// ---------------------------------------------------------------------------

function assertNetworkName(network) {
    if (typeof network !== 'string' || !NETWORK_NAME.test(network)) {
        fail('schema', 'A network name is required.');
    }
}

const statusOf = (row, network) => (isRecord(row) ? row.networks?.[network]?.status : undefined);
const byOrdinal = (left, right) => left.ordinal - right.ordinal;

/** Rows that are deployed on `network` (active or exit-only), ordinal ascending. */
export function liveVersions(registry, network) {
    assertNetworkName(network);
    return registryRows(registry, 'The').filter(row => LIVE_STATUSES.includes(statusOf(row, network))).sort(byOrdinal);
}

/** The unique active row on `network`, or null ("deposits unavailable"). */
export function depositTarget(registry, network) {
    assertNetworkName(network);
    const active = registryRows(registry, 'The').filter(row => statusOf(row, network) === 'active');
    if (active.length > 1) fail('multiple_active', `Network ${network} has more than one active version.`);
    return active[0] || null;
}

/** The wallet IndexedDB name every version of `network` shares. */
export function walletDatabaseName(registry, network) {
    assertNetworkName(network);
    const template = registry?.walletDatabase;
    const lineage = registry?.lineage;
    if (typeof template !== 'string' || typeof lineage !== 'string' || !LINEAGE.test(lineage)
        || template.split('{lineage}').length !== 2 || template.split('{network}').length !== 2) {
        fail('wallet_namespace', 'walletDatabase must name {lineage} and {network} once each.');
    }
    const name = template.replace('{lineage}', lineage).replace('{network}', network);
    if (!DATABASE_NAME.test(name) || name === SDK_DEFAULT_DATABASE) {
        fail('wallet_namespace', 'walletDatabase must resolve to a lineage-specific database name.');
    }
    return name;
}

/**
 * The configuration a build writes as browser-config.json for a version in
 * `status`. A version whose SDK honors the pinned deposits flag gets
 * `trusted_deployment.deposits: "closed"` appended once it is exit-only;
 * every other configuration is emitted exactly as reviewed (the legacy SDK
 * ignores the flag, so its bytes never change). Key order is part of the
 * byte-for-byte contract that configSha256 pins.
 */
export function emittedConfig(config, { honorsDepositsFlag = false, status } = {}) {
    if (honorsDepositsFlag !== true || status !== 'exit-only') return config;
    const pins = trustedPins(config, 'The profile');
    return { ...config, trusted_deployment: { ...pins, deposits: 'closed' } };
}

/** The exact text a build writes for a configuration. */
export function serializeConfig(config) {
    return `${JSON.stringify(config, null, 2)}\n`;
}

function optionalTime(entry, key) {
    return entry[key] === undefined ? null : requireTimestamp(entry[key], key);
}

function resolveLive(row, network, entry, { profiles, sha256, configSha256 }) {
    const where = `${row.id} on ${network}`;
    const config = profileFor(row, network, entry, profiles);
    const pins = trustedPins(config, where);
    if (typeof pins.deployment_id !== 'string' || !pins.deployment_id || !isPositiveInteger(pins.chain_id)
        || typeof pins.contract_address !== 'string' || !ADDRESS.test(pins.contract_address)) {
        fail('profile', `${where} does not identify a deployment, chain and vault.`);
    }
    let hash = null;
    if (hasOwn(configSha256, row.id)) {
        hash = configSha256[row.id];
        if (!SHA256_HEX.test(hash)) fail('schema', `The supplied config hash for ${row.id} is not a SHA-256 digest.`);
    } else if (typeof sha256 === 'function') {
        const emitted = emittedConfig(config, { honorsDepositsFlag: row.sdk.honorsDepositsFlag, status: entry.status });
        hash = sha256(serializeConfig(emitted));
        if (!SHA256_HEX.test(hash)) fail('schema', 'The sha256 function must return a lowercase hex digest.');
    }
    return {
        id: row.id,
        ordinal: row.ordinal,
        label: row.label,
        adapter: row.adapter,
        circuitId: row.circuitId,
        vaultRevision: row.vaultRevision,
        status: entry.status,
        depositsOpen: entry.status === 'active',
        depositsClosedSince: optionalTime(entry, 'depositsClosedSince'),
        admissionClosesAt: optionalTime(entry, 'admissionClosesAt'),
        deploymentId: pins.deployment_id,
        chainId: pins.chain_id,
        vault: pins.contract_address.toLowerCase(),
        rpcUrl: typeof pins.rpc_url === 'string' ? pins.rpc_url : null,
        configSha256: hash,
        assetBase: row.publicPath.slice(1),
        proxyPath: row.proxyPath,
        transition: { ...row.transition, reminderDays: [...row.transition.reminderDays] },
        notices: (entry.notices || []).map(notice => ({
            kind: notice.kind,
            noteId: notice.noteId,
            destination: notice.destination.toLowerCase(),
            expiresAt: requireTimestamp(notice.expiresAt, 'expiresAt'),
            text: notice.text
        }))
    };
}

function resolveTombstone(row, entry) {
    const { deploymentId, chainId, vault } = entry.tombstone;
    return {
        id: row.id,
        ordinal: row.ordinal,
        label: row.label,
        adapter: row.adapter,
        circuitId: row.circuitId,
        vaultRevision: row.vaultRevision,
        status: 'retired',
        depositsOpen: false,
        depositsClosedSince: optionalTime(entry, 'depositsClosedSince'),
        admissionClosesAt: null,
        deploymentId,
        chainId,
        vault: vault.toLowerCase(),
        rpcUrl: null,
        configSha256: null,
        assetBase: null,
        proxyPath: null,
        transition: { ...row.transition, reminderDays: [...row.transition.reminderDays] },
        notices: []
    };
}

/**
 * The version table the app embeds for `network`: live versions ordinal
 * ascending, then retired tombstones. Pending rows never appear.
 *
 * The caller validates the registry first (validateRegistry needs adapters;
 * this does not). options:
 *   profiles      as for validateRegistry
 *   sha256        synchronous (text) => lowercase hex digest. The model has no
 *                 hash primitive of its own; the build passes node:crypto's.
 *                 configSha256 is then the digest of the emitted
 *                 configuration's serializeConfig text.
 *   configSha256  precomputed digests by version id, taking precedence
 * With neither, configSha256 is null.
 */
export function resolveRuntimeTable(registry, network, options = {}) {
    assertNetworkName(network);
    const { profiles = {}, sha256 = null } = options;
    const configSha256 = isRecord(options.configSha256) ? options.configSha256 : {};
    const live = [];
    const retired = [];
    for (const row of [...registryRows(registry, 'The')].sort(byOrdinal)) {
        const entry = row?.networks?.[network];
        if (!isRecord(entry) || !hasOwn(STAGE, entry.status)) {
            fail('schema', `${row?.id} has no usable entry for ${network}.`);
        }
        if (entry.status === 'pending') continue;
        if (entry.status === 'retired') {
            if (!isRecord(entry.tombstone)) fail('retired_fields', `${row.id} on ${network} has no tombstone.`);
            retired.push(resolveTombstone(row, entry));
        } else {
            live.push(resolveLive(row, network, entry, { profiles, sha256, configSha256 }));
        }
    }
    // The caller validates first, which already refuses this. It is repeated
    // here because an empty (or tombstones-only) table is read by the boot as
    // "no registry": the legacy SDK defaults.
    if (!live.length) fail('no_live_version', `Network ${network} has no live version.`);
    return [...live, ...retired];
}

/** The table entry (live or tombstone) for a deployment id, or null. */
export function versionForDeployment(table, deploymentId) {
    if (!Array.isArray(table) || typeof deploymentId !== 'string' || !deploymentId) return null;
    return table.find(version => version?.deploymentId === deploymentId) || null;
}
