import { memoryBank } from './memoryInstances.js';
import { parseOmfText, validateOmf } from '../nanomem/browser.js';

export { validateOmf };

export async function readOmfFile(file) {
    return parseOmfText(await file.text());
}

export async function previewOmfImport(doc, options = {}) {
    await memoryBank.init();
    return memoryBank.previewOmfImport(doc, options);
}

export async function importOmf(doc, options = {}) {
    await memoryBank.init();
    return memoryBank.importOmf(doc, options);
}
