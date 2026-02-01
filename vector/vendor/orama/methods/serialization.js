export function load(orama, raw) {
    orama.internalDocumentIDStore.load(orama, raw.internalDocumentIDStore);
    orama.data.index = orama.index.load(orama.internalDocumentIDStore, raw.index);
    orama.data.docs = orama.documentsStore.load(orama.internalDocumentIDStore, raw.docs);
    orama.data.sorting = orama.sorter.load(orama.internalDocumentIDStore, raw.sorting);
    orama.data.pinning = orama.pinning.load(orama.internalDocumentIDStore, raw.pinning);
    orama.tokenizer.language = raw.language;
}
export function save(orama) {
    return {
        internalDocumentIDStore: orama.internalDocumentIDStore.save(orama.internalDocumentIDStore),
        index: orama.index.save(orama.data.index),
        docs: orama.documentsStore.save(orama.data.docs),
        sorting: orama.sorter.save(orama.data.sorting),
        pinning: orama.pinning.save(orama.data.pinning),
        language: orama.tokenizer.language
    };
}
//# sourceMappingURL=serialization.js.map