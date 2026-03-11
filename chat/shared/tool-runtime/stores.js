import { shallowClone } from './utils.js';

export class MemoryRunStore {
    constructor() {
        this.runs = new Map();
    }

    async saveRun(run) {
        this.runs.set(run.id, shallowClone(run));
        return shallowClone(run);
    }

    async getRun(runId) {
        return shallowClone(this.runs.get(runId) || null);
    }

    async listRuns(filter = {}) {
        const runs = Array.from(this.runs.values()).filter((run) => {
            if (filter.sessionId && run.sessionId !== filter.sessionId) return false;
            if (filter.messageId && run.messageId !== filter.messageId) return false;
            if (filter.status && run.status !== filter.status) return false;
            return true;
        });
        runs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        return runs.map(run => shallowClone(run));
    }
}

export class MemoryArtifactStore {
    constructor() {
        this.artifacts = new Map();
    }

    async saveArtifact(artifact) {
        this.artifacts.set(artifact.id, shallowClone(artifact));
        return shallowClone(artifact);
    }

    async getArtifact(artifactId) {
        return shallowClone(this.artifacts.get(artifactId) || null);
    }

    async listArtifacts(filter = {}) {
        const artifacts = Array.from(this.artifacts.values()).filter((artifact) => {
            if (filter.sessionId && artifact.sessionId !== filter.sessionId) return false;
            if (filter.messageId && artifact.messageId !== filter.messageId) return false;
            if (filter.runId && artifact.runId !== filter.runId) return false;
            return true;
        });
        artifacts.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        return artifacts.map(artifact => shallowClone(artifact));
    }
}
