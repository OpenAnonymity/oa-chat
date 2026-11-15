/** Browser-local ownership journals. Caller holds the origin-wide transfer lock. */
export function legacyTransferStateStore(db) {
    const key = 'legacy-transfer-pending-attempt';
    const list = async () => {
        const value = await db.getSetting(key);
        if (!value) return [];
        const items = Array.isArray(value) ? value : [value];
        if (items.some(item => !item?.accountId || !Array.isArray(item.tickets))) {
            throw new Error('Saved ticket restoration needs recovery. Your tickets have been kept.');
        }
        return items;
    };
    return {
        list,
        get: async accountId => (await list()).find(item => item.accountId === accountId),
        put: async value => db.updateSettings([{ key, value: [...(await list()).filter(item => item.accountId !== value.accountId), value] }]),
        clear: async accountId => db.updateSettings([{ key, value: (await list()).filter(item => item.accountId !== accountId) }])
    };
}
