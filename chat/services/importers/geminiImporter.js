import { registerChatHistoryImporter } from '../chatHistoryImportRegistry.js';

registerChatHistoryImporter({
    id: 'gemini-placeholder',
    label: 'Gemini (export)',
    source: 'gemini',
    description: 'Coming soon.',
    fileHint: 'Gemini export file',
    enabled: false,
    canImport: () => false,
    parse: async () => {
        throw new Error('Gemini import is not supported yet.');
    }
});
