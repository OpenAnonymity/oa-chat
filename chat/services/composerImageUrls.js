// Blob URLs have a browser lifetime independent of JavaScript references.
// Composer membership and open image viewers each own an explicit reference.
export function createComposerImageUrls(URLImpl = globalThis.URL) {
    let current = new Set();
    const entries = new Map();
    const byUrl = new Map();
    function releaseUnused(file, entry) {
        if (current.has(file) || entry.viewers > 0) return;
        URLImpl.revokeObjectURL(entry.url);
        entries.delete(file);
        byUrl.delete(entry.url);
    }
    return {
        setFiles(files) {
            current = new Set(files);
            for (const [file, entry] of entries) releaseUnused(file, entry);
        },
        getUrl(file) {
            // An obsolete asynchronous thumbnail render must not retain files.
            if (!current.has(file)) return '';
            if (!entries.has(file)) {
                const entry = { url: URLImpl.createObjectURL(file), viewers: 0, file };
                entries.set(file, entry);
                byUrl.set(entry.url, entry);
            }
            return entries.get(file).url;
        },
        retainViewer(url) {
            const entry = byUrl.get(url);
            if (!entry) return () => {};
            entry.viewers += 1;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                entry.viewers -= 1;
                releaseUnused(entry.file, entry);
            };
        },
    };
}
