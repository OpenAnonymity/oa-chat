/**
 * MemoryFileSystem — Virtual markdown filesystem backed by IndexedDB.
 *
 * Stores memory files as markdown in a separate 'oa-memory-fs' database.
 * Each file has a path (keyPath), content, a one-line summary (l0),
 * a parentPath index for directory listing, and timestamps.
 *
 * The LLM reads the root _index.md to decide which files to load —
 * like a human doing grep.
 */

const DB_NAME = 'oa-memory-fs';
const DB_VERSION = 1;
const STORE_NAME = 'memoryFiles';

const BOOTSTRAP_INDEX = `# Memory Index

_No files yet._
`;

class MemoryFileSystem {
    constructor() {
        this.db = null;
        this._initPromise = null;
    }

    /**
     * Open the database and bootstrap default files if empty.
     */
    async init() {
        if (this.db) return this.db;
        if (this._initPromise) return this._initPromise;

        this._initPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });
                    store.createIndex('parentPath', 'parentPath', { unique: false });
                }
            };

            request.onsuccess = async (event) => {
                this.db = event.target.result;
                try {
                    await this._bootstrap();
                } catch (err) {
                    console.warn('[MemoryFS] Bootstrap error:', err);
                }
                resolve(this.db);
            };

            request.onerror = () => {
                this._initPromise = null;
                reject(request.error);
            };
        });

        return this._initPromise;
    }

    /**
     * Seed default index files if the database is empty.
     */
    async _bootstrap() {
        const all = await this._getAll();
        if (all.length > 0) return;

        const now = Date.now();
        const seeds = [
            { path: '_index.md', content: BOOTSTRAP_INDEX, l0: 'Root index of memory filesystem', parentPath: '', createdAt: now, updatedAt: now },
        ];

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const seed of seeds) {
                store.put(seed);
            }
            tx.oncomplete = () => {
                console.log('[MemoryFS] Bootstrapped default files');
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        });
    }

    // ─── Core CRUD ───────────────────────────────────────────────

    /**
     * Read a file's content by path.
     * @param {string} path
     * @returns {Promise<string|null>}
     */
    async read(path) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(path);
            request.onsuccess = () => resolve(request.result?.content ?? null);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Write (upsert) a file. Auto-generates l0 summary and rebuilds parent indexes.
     * @param {string} path
     * @param {string} content
     */
    async write(path, content) {
        await this.init();
        const parentPath = this._parentPath(path);
        const now = Date.now();
        const existing = await this._get(path);

        const record = {
            path,
            content,
            l0: this._generateL0(content),
            parentPath,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
        };

        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const request = tx.objectStore(STORE_NAME).put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        // Rebuild root index (non-blocking)
        this.rebuildIndex().catch(err =>
            console.warn('[MemoryFS] Index rebuild error:', err)
        );
    }

    /**
     * Delete a file by path. Protects _index.md files from deletion.
     * @param {string} path
     */
    async delete(path) {
        if (path.endsWith('_index.md')) {
            console.warn('[MemoryFS] Cannot delete index files:', path);
            return;
        }
        await this.init();

        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const request = tx.objectStore(STORE_NAME).delete(path);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });

        this.rebuildIndex().catch(err =>
            console.warn('[MemoryFS] Index rebuild error:', err)
        );
    }

    /**
     * Check if a file exists.
     * @param {string} path
     * @returns {Promise<boolean>}
     */
    async exists(path) {
        await this.init();
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getKey(path);
            request.onsuccess = () => resolve(request.result !== undefined);
            request.onerror = () => reject(request.error);
        });
    }

    // ─── Directory Operations ────────────────────────────────────

    /**
     * List children of a directory path.
     * Returns { files: [path], dirs: [dirName] }.
     * @param {string} dirPath — e.g. '' for root, 'personal' for personal/
     */
    async ls(dirPath) {
        await this.init();
        const all = await this._getAll();
        const prefix = dirPath ? dirPath + '/' : '';
        const files = [];
        const dirSet = new Set();

        for (const rec of all) {
            // Skip files not under this directory
            if (prefix && !rec.path.startsWith(prefix)) continue;
            if (!prefix && rec.path === '_index.md') continue;

            const relative = rec.path.slice(prefix.length);
            if (!relative.includes('/')) {
                files.push(rec.path);
            } else {
                dirSet.add(relative.split('/')[0]);
            }
        }

        return { files, dirs: [...dirSet] };
    }

    // ─── Search ──────────────────────────────────────────────────

    /**
     * Brute-force text search across all file contents.
     * @param {string} query
     * @returns {Promise<Array<{path: string, snippet: string}>>}
     */
    async search(query) {
        await this.init();
        if (!query || !query.trim()) return [];
        const lowerQuery = query.toLowerCase();
        const all = await this._getAll();
        const results = [];

        for (const rec of all) {
            if (rec.path.endsWith('_index.md')) continue;
            const idx = (rec.content || '').toLowerCase().indexOf(lowerQuery);
            if (idx === -1) continue;
            const start = Math.max(0, idx - 40);
            const end = Math.min(rec.content.length, idx + query.length + 40);
            results.push({
                path: rec.path,
                snippet: (start > 0 ? '...' : '') + rec.content.slice(start, end) + (end < rec.content.length ? '...' : ''),
            });
        }

        return results;
    }

    // ─── Index Management ────────────────────────────────────────

    /**
     * Shorthand: read root _index.md.
     */
    async getIndex() {
        return this.read('_index.md');
    }

    /**
     * Rebuild root _index.md as a flat listing of ALL non-index files.
     * Simple and correct — the LLM sees everything in one shot.
     */
    async rebuildIndex() {
        await this.init();
        const all = await this._getAll();
        const files = all
            .filter(r => !r.path.endsWith('_index.md'))
            .sort((a, b) => a.path.localeCompare(b.path));

        let indexContent = '# Memory Index\n\n';

        if (files.length > 0) {
            indexContent += '## Files\n';
            for (const f of files) {
                indexContent += `- ${f.path} — ${f.l0}\n`;
            }
        } else {
            indexContent += '_No files yet._\n';
        }

        const existing = await this._get('_index.md');
        const now = Date.now();

        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put({
                path: '_index.md',
                content: indexContent,
                l0: 'Root index of memory filesystem',
                parentPath: '',
                createdAt: existing?.createdAt ?? now,
                updatedAt: now,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    // ─── Export ──────────────────────────────────────────────────

    /**
     * Export all records.
     */
    async exportAll() {
        await this.init();
        return this._getAll();
    }

    // ─── Internal Helpers ────────────────────────────────────────

    _parentPath(filePath) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash === -1 ? '' : filePath.slice(0, lastSlash);
    }

    _generateL0(content) {
        if (!content) return '';
        // First non-heading, non-empty line, max 100 chars
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            return trimmed.length > 100 ? trimmed.slice(0, 97) + '...' : trimmed;
        }
        return content.slice(0, 100);
    }

    async _get(path) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).get(path);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        });
    }

    async _getAll() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const request = tx.objectStore(STORE_NAME).getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async _getByParent(parentPath) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(STORE_NAME, 'readonly');
            const index = tx.objectStore(STORE_NAME).index('parentPath');
            const results = [];
            const request = index.openCursor(IDBKeyRange.only(parentPath));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    results.push(cursor.value);
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            request.onerror = () => reject(request.error);
        });
    }
}

const memoryFileSystem = new MemoryFileSystem();
export default memoryFileSystem;
