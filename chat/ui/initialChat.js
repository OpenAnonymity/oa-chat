import { isConversationRestorePending } from '../services/navigationState.js';

export async function prerenderInitialChat({ container, search = '', storage,
    loadTemplate = () => import('../components/MessageTemplates.js') } = {}) {
    const canRender = () => container && container.childElementCount === 0 &&
        container.dataset.chatBootstrapped !== 'true' &&
        !isConversationRestorePending({ search, storage });
    if (!canRender()) return;
    const { buildEmptyState } = await loadTemplate();
    // The app may have mounted or navigated while the template was loading.
    if (canRender()) container.innerHTML = buildEmptyState();
}
