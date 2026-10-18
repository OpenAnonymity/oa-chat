// Protocol family adapters, by the id a registry row names in `adapter`.
//
// A new deployment of a known family is a registry row only. A new family is
// one module here plus the row (docs/ZKAPI_VERSIONING.md, "Add a future version").
import concessionV1 from './concessionV1.mjs';
import concessionV2 from './concessionV2.mjs';
import noteBoundV1 from './noteBoundV1.mjs';

const ADAPTERS = Object.freeze({
    [noteBoundV1.id]: noteBoundV1,
    [concessionV1.id]: concessionV1,
    [concessionV2.id]: concessionV2
});

export const ADAPTER_IDS = Object.freeze(Object.keys(ADAPTERS));

/** The adapter named by a registry row. Throws code `unknown_adapter` for any other id. */
export function getAdapter(id) {
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(ADAPTERS, id)) {
        const error = new Error('Unknown zkAPI protocol adapter.');
        error.code = 'unknown_adapter';
        throw error;
    }
    return ADAPTERS[id];
}
