import fs from 'node:fs/promises';
import path from 'node:path';

const statIfPresent = async (target) => {
    try {
        return await fs.lstat(target);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
};

// Vercel Git checkouts can contain the submodule but omit chat/nanomem.
// Bundling reads chat source, so copying nanomem to dist does not fix imports.
export async function prepareNanomemBrowser(repoRoot) {
    const nanomemDir = path.join(repoRoot, 'nanomem');
    for (const entry of ['browser.js', 'src/browser.js']) {
        if (!(await statIfPresent(path.join(nanomemDir, entry)))?.isFile()) {
            throw new Error(`[build] Missing nanomem/${entry}. Initialize the complete nanomem submodule before building.`);
        }
    }

    const browserPath = path.join(repoRoot, 'chat', 'nanomem');
    const existing = await statIfPresent(browserPath);
    if (existing?.isSymbolicLink()) {
        if (path.resolve(path.dirname(browserPath), await fs.readlink(browserPath)) !== nanomemDir) {
            throw new Error('[build] chat/nanomem must point to ../nanomem. Existing link was left unchanged.');
        }
        return;
    }
    // Some source packagers dereference links into directories; preserve those.
    if (existing?.isDirectory() && (await statIfPresent(path.join(browserPath, 'browser.js')))?.isFile()) {
        return;
    }
    if (existing) {
        // A Git symlink may also be materialized as its literal target text.
        if (!existing.isFile() || (await fs.readFile(browserPath, 'utf8')).trim() !== '../nanomem') {
            throw new Error('[build] Unexpected chat/nanomem contents. Existing path was left unchanged.');
        }
        await fs.unlink(browserPath);
    }
    await fs.symlink('../nanomem', browserPath, 'dir');
}
