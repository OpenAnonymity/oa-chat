/**
 * MigrationModal Component
 * Handles the alpha-to-beta migration modal for exporting local data.
 */

const SNOOZE_KEY = 'oa-migration-modal-snooze-until';
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000; // 1 day

export default class MigrationModal {
    constructor() {
        this.modal = document.getElementById('migration-modal');
        this.dismissBtn = document.getElementById('migration-modal-dismiss');
        this.exportBtn = document.getElementById('migration-modal-export');
        this.snoozeCheckbox = document.getElementById('migration-modal-snooze');
    }

    /**
     * Initializes the modal and sets up event listeners.
     * Shows the modal on startup if not snoozed.
     */
    init() {
        if (!this.modal) return;

        this.setupEventListeners();
        this.showIfNotSnoozed();
    }

    /**
     * Sets up all event listeners for the modal.
     */
    setupEventListeners() {
        this.dismissBtn?.addEventListener('click', () => this.close());

        this.exportBtn?.addEventListener('click', async () => {
            await this.handleExport();
            this.close();
        });

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.close();
            }
        });

        // Close on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.modal.classList.contains('hidden')) {
                this.close();
            }
        });
    }

    /**
     * Shows the modal if not currently snoozed.
     */
    showIfNotSnoozed() {
        const snoozeUntil = localStorage.getItem(SNOOZE_KEY);
        const isSnoozed = snoozeUntil && Date.now() < parseInt(snoozeUntil, 10);

        if (!isSnoozed) {
            this.show();
        }
    }

    /**
     * Shows the modal.
     */
    show() {
        this.modal?.classList.remove('hidden');
    }

    /**
     * Closes the modal and applies snooze if checkbox is checked.
     */
    close() {
        this.modal?.classList.add('hidden');

        if (this.snoozeCheckbox?.checked) {
            const snoozeUntil = Date.now() + SNOOZE_DURATION_MS;
            localStorage.setItem(SNOOZE_KEY, snoozeUntil.toString());
        }
    }

    /**
     * Handles the export action.
     */
    async handleExport() {
        try {
            const { exportAllData } = await import('../services/globalExport.js');
            await exportAllData();
        } catch (error) {
            console.error('Export error:', error);
        }
    }
}
