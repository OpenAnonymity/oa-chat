// Protocol wiring the host has actually implemented.
//
// An adapter lists the host behaviors its protocol family makes mandatory in
// `requiredWiring` (concession-v1: the exit-only service message, credited
// payouts, the exit kit, ...). A registry row can only be `active` or
// `exit-only` once every one of those names appears here, and the registry
// validator (registryModel.mjs, code `gate_wiring`) refuses it otherwise.
// Shipping a row without this wiring would let users hold notes whose safety
// notices and recovery actions the app cannot show.
//
// The set below is exactly the union of every adapter's `requiredWiring`: the
// ten behaviors of the concession-v1 family are implemented, each with a
// runnable host test titled `wiring:<name>` (test/zkapi/zkapi-wiring.test.mjs
// holds the evidence table and fails when this set and the adapters drift
// apart, or when a name loses its test). A new required name is therefore
// added to the adapter first, which makes that test fail until the behavior
// and this list follow in the same reviewed diff.
//
// Listing a name is not what makes a row live. A row also needs its own pins,
// a deployed profile, the finalized manifest hash and a recovery review, and
// one name has a half that lives in the SDK: `withdrawal-operation-recheck`
// is only complete for a revision whose recovery patch covers it. The build
// (planFromRegistry of scripts/zkapiRegistry.mjs, for the shipped registry) and
// the registry CLI check both refuse a live row without it, code
// `recovery_patch_coverage`. The successor row stays `pending` until all of
// that is met.
//
// One open item is known and is not hidden by the list: of
// `ownership-proof-wait`, the dialog's own withdrawal form discloses the bound
// and carries it to the signer, but the call sites that only continue an
// earlier withdrawal (a retry, a replacement, a set-aside balance) name none,
// so the signer refuses a conceding escape there and the person starts again.
// That fails closed. A `todo` test of test/zkapi/zkapi-wiring.test.mjs carries
// it until each of those call sites names its bound.
//
// The set cannot be mutated through its API, so no other module can mark a
// protocol as wired at run time.
class FrozenNameSet extends Set {
    constructor(names) {
        super();
        // Set's constructor would call the overridden add(); fill through the
        // prototype method instead.
        for (const name of names) Set.prototype.add.call(this, name);
    }

    add() {
        throw new TypeError('WIRED is read-only.');
    }

    delete() {
        throw new TypeError('WIRED is read-only.');
    }

    clear() {
        throw new TypeError('WIRED is read-only.');
    }
}

/** @type {ReadonlySet<string>} */
export const WIRED = new FrozenNameSet([
    'service-message',
    'credited-payouts',
    'payout-alert',
    'device-not-newest',
    'near-expiry',
    'ownership-proof-wait',
    'withdrawal-operation-recheck',
    'other-deployment-withdrawals',
    'other-deployment-credits',
    'deposit-activation'
]);
