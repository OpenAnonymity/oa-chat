import { memoryBank } from './memoryInstances.js';
import { saveWithConfirmation } from './globalExport.js';

export async function buildOmfExport() {
    await memoryBank.init();
    return memoryBank.exportOmf();
}

export async function exportMemoriesAsOmf() {
    const omfDoc = await buildOmfExport();
    const jsonString = JSON.stringify(omfDoc, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const filename = `memories-${new Date().toISOString().replace(/[:.]/g, '-')}.omf.json`;
    return saveWithConfirmation(blob, filename);
}
