import memoryFileSystem from './memoryFileSystem.js';
import { parseMemoryBullets, todayIsoDate } from './memoryBulletUtils.js';

class MemoryBulletIndex {
    constructor() {
        this._initialized = false;
        this._initPromise = null;
        this._pathToBullets = new Map();
        this._pathToUpdatedAt = new Map();
    }

    async init() {
        if (this._initialized) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._rebuild();
        await this._initPromise;
    }

    async _rebuild() {
        await memoryFileSystem.init();
        const all = await memoryFileSystem.exportAll();
        this._pathToBullets.clear();
        this._pathToUpdatedAt.clear();

        for (const file of all) {
            if (file.path.endsWith('_index.md')) continue;
            const bullets = this._parseForIndex(file.path, file.content || '');
            this._pathToBullets.set(file.path, bullets);
            this._pathToUpdatedAt.set(file.path, file.updatedAt || Date.now());
        }

        this._initialized = true;
        this._initPromise = null;
        console.log(`[MemoryBulletIndex] Indexed ${this._pathToBullets.size} files`);
    }

    _parseForIndex(path, content) {
        const parsed = parseMemoryBullets(content || '');
        if (parsed.length > 0) return parsed;

        // Lightweight fallback for legacy files: use plain lines as bullets.
        const lines = String(content || '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .filter((line) => !line.startsWith('#'))
            .slice(0, 200);

        const today = todayIsoDate();
        return lines.map((line) => ({
            text: line,
            topic: path.split('/')[0] || 'general',
            updatedAt: today,
            expiresAt: null,
            section: 'active'
        }));
    }

    async refreshPath(path) {
        await this.init();
        if (!path || path.endsWith('_index.md')) return;

        const content = await memoryFileSystem.read(path);
        if (content === null) {
            this._pathToBullets.delete(path);
            this._pathToUpdatedAt.delete(path);
            return;
        }

        const bullets = this._parseForIndex(path, content);
        this._pathToBullets.set(path, bullets);
        this._pathToUpdatedAt.set(path, Date.now());
    }

    getBulletsForPaths(paths) {
        if (!this._initialized) return [];
        const items = [];
        for (const path of paths || []) {
            const bullets = this._pathToBullets.get(path);
            if (!bullets || bullets.length === 0) continue;
            for (const bullet of bullets) {
                items.push({
                    path,
                    bullet,
                    fileUpdatedAt: this._pathToUpdatedAt.get(path) || 0
                });
            }
        }
        return items;
    }
}

const memoryBulletIndex = new MemoryBulletIndex();
export default memoryBulletIndex;
