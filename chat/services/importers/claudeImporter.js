import { registerChatHistoryImporter } from '../chatHistoryImportRegistry.js';

registerChatHistoryImporter({
    id: 'claude-placeholder',
    label: 'Claude (export)',
    source: 'claude',
    description: 'Coming soon.',
    fileHint: 'Claude export file',
    enabled: false,
    canImport: () => false,
    parse: async () => {
        throw new Error('Claude import is not supported yet.');
    }
});
