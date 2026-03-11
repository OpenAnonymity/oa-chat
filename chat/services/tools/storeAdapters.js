function sortByTimestamp(items = []) {
    return [...items].sort((a, b) => (a.createdAt || a.timestamp || 0) - (b.createdAt || b.timestamp || 0));
}

export class ChatRunStoreAdapter {
    constructor(chatDB) {
        this.chatDB = chatDB;
    }

    async saveRun(run) {
        await this.chatDB.saveExecutionRun(run);
        return run;
    }

    async getRun(runId) {
        return this.chatDB.getExecutionRun(runId);
    }

    async listRuns(filter = {}) {
        if (filter.messageId) {
            return sortByTimestamp(await this.chatDB.getMessageExecutionRuns(filter.messageId));
        }
        if (filter.sessionId) {
            return sortByTimestamp(await this.chatDB.getSessionExecutionRuns(filter.sessionId));
        }
        return sortByTimestamp(await this.chatDB.getAllExecutionRuns());
    }
}

export class ChatArtifactStoreAdapter {
    constructor(chatDB) {
        this.chatDB = chatDB;
    }

    async saveArtifact(artifact) {
        await this.chatDB.saveArtifact(artifact);
        return artifact;
    }

    async getArtifact(artifactId) {
        return this.chatDB.getArtifact(artifactId);
    }

    async listArtifacts(filter = {}) {
        if (filter.runId) {
            return sortByTimestamp(await this.chatDB.getRunArtifacts(filter.runId));
        }
        if (filter.messageId) {
            return sortByTimestamp(await this.chatDB.getMessageArtifacts(filter.messageId));
        }
        if (filter.sessionId) {
            return sortByTimestamp(await this.chatDB.getSessionArtifacts(filter.sessionId));
        }
        return sortByTimestamp(await this.chatDB.getAllArtifacts());
    }
}
