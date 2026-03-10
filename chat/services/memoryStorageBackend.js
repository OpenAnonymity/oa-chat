/**
 * MemoryStorageBackend — Swappable storage interface + tool executor factories.
 *
 * Every backend must implement:
 *   read(path) → string | null
 *   write(path, content) → void
 *   delete(path) → void
 *   exists(path) → boolean
 *   ls(dirPath) → { files: [], dirs: [] }
 *   search(query) → [{ path, snippet }]
 *   getIndex() → string
 *   rebuildIndex() → void
 *
 * Web uses IndexedDB (memoryFileSystem). Desktop/Electron can use real fs.
 */

/**
 * Build tool executors for the retrieval (read) flow.
 * @param {object} backend — storage backend implementing the interface above
 */
export function createRetrievalExecutors(backend) {
    return {
        retrieve_file: async ({ query }) => {
            // Search file contents for the query
            const results = await backend.search(query);
            const contentPaths = results.map(r => r.path);

            // Also match against file paths (the LLM may search by path)
            const allFiles = await backend.exportAll();
            const queryLower = query.toLowerCase();
            const pathMatches = allFiles
                .filter(f => !f.path.endsWith('_index.md') && f.path.toLowerCase().includes(queryLower))
                .map(f => f.path);

            // Deduplicate, path matches first
            const seen = new Set();
            const paths = [];
            for (const p of [...pathMatches, ...contentPaths]) {
                if (!seen.has(p)) { seen.add(p); paths.push(p); }
            }

            return JSON.stringify({ paths: paths.slice(0, 5), count: Math.min(paths.length, 5) });
        },
        read_file: async ({ path }) => {
            const content = await backend.read(path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content.length > 1500 ? content.slice(0, 1500) + '...(truncated)' : content;
        }
    };
}

/**
 * Build tool executors for the extraction (write) flow.
 * @param {object} backend — storage backend implementing the interface above
 * @param {object} helpers — optional { normalizeContent, mergeWithExisting, refreshIndex }
 */
export function createExtractionExecutors(backend, helpers = {}) {
    const { normalizeContent, mergeWithExisting, refreshIndex } = helpers;

    return {
        read_file: async ({ path }) => {
            const content = await backend.read(path);
            if (content === null) return JSON.stringify({ error: `File not found: ${path}` });
            return content.length > 2000 ? content.slice(0, 2000) + '...(truncated)' : content;
        },
        create_new_file: async ({ path, content }) => {
            const exists = await backend.exists(path);
            if (exists) return JSON.stringify({ error: `File already exists: ${path}. Use append_memory or update_memory instead.` });
            const normalized = normalizeContent ? normalizeContent(content, path) : content;
            await backend.write(path, normalized);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path });
        },
        create_new_folder: async ({ folder_path }) => {
            const placeholderPath = `${folder_path}/about.md`;
            const exists = await backend.exists(placeholderPath);
            if (!exists) {
                await backend.write(placeholderPath, '');
            }
            return JSON.stringify({ success: true, folder_path });
        },
        append_memory: async ({ path, content }) => {
            const existing = await backend.read(path);
            const newContent = mergeWithExisting
                ? mergeWithExisting(existing, content, path)
                : (existing ? existing + '\n\n' + content : content);
            await backend.write(path, newContent);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'appended' });
        },
        update_memory: async ({ path, content }) => {
            const normalized = normalizeContent ? normalizeContent(content, path) : content;
            await backend.write(path, normalized);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'updated' });
        },
        archive_memory: async ({ path, item_text }) => {
            const existing = await backend.read(path);
            if (!existing) return JSON.stringify({ error: `File not found: ${path}` });
            const lines = existing.split('\n');
            const filtered = lines.filter(line => !line.includes(item_text));
            const newContent = filtered.join('\n').trim();
            await backend.write(path, newContent);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'archived', removed: item_text });
        },
        delete_memory: async ({ path }) => {
            if (path.endsWith('_index.md')) {
                return JSON.stringify({ error: 'Cannot delete index files' });
            }
            await backend.delete(path);
            if (refreshIndex) await refreshIndex(path);
            return JSON.stringify({ success: true, path, action: 'deleted' });
        }
    };
}
