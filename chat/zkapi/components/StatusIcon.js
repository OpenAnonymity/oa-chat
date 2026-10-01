// Shape and accompanying text carry meaning without relying on theme colors.
export function statusIcon(kind = 'error') {
    const path = kind === 'attention'
        ? '<path d="M8 2 15 14H1L8 2Z"/><path d="M8 6v4m0 2v.1"/>'
        : '<path d="m5 1-4 4v6l4 4h6l4-4V5l-4-4H5Z"/><path d="m5.5 5.5 5 5m0-5-5 5"/>';
    return `<svg class="zkapi-status-icon" data-status-icon="${kind === 'attention' ? 'attention' : 'error'}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
