// FIXTURE: names of sdk/services/zkapiRequestArchive.mjs (zkapi 0.2.0, branch v0.2, 4b955d9).
// Constants carry their real values; every function fails loudly.
import { unsupportedExports } from './fixtureSupport.js';

export const REQUEST_ARCHIVE_SCHEMA = 1;
export const REQUEST_JOURNAL_TYPE = 'request_journal';
export const REQUEST_EVIDENCE_TYPE = 'request_evidence';
export const REQUEST_JOURNAL_PREFIX = 'request-journal:';
export const REQUEST_EVIDENCE_PREFIX = 'request-evidence:';
export const REQUEST_ARCHIVE_LIMITS = Object.freeze({
    unresolvedPerAnchor: 16,
    retainedPerAnchor: 64,
    terminalPerDeployment: 256,
    observationsPerRecord: 8
});
export const REQUEST_ACCEPTANCE_WINDOW_SECONDS = 300;
export const REQUEST_EVICTION_SKEW_SECONDS = 900;
export const TERMINAL_DISPOSITIONS = new Set(['installed', 'superseded', 'invalid_successor']);
export const EVICTED_DISPOSITION = 'evicted';
export const LATE_SUCCESSOR_DISPOSITION = 'late_successor';
export const INVALID_SUCCESSOR_DISPOSITION = 'invalid_successor';

export const {
    anchorArchiveCapacity, buildRequestEvidenceRecord, buildRequestJournalRecord,
    compactRequestArchiveRecord, earliestLocalTransmission, feltKey, highestObservationSeq,
    isReceiptClaim, isRequestArchiveRecord, isUnresolved, journalClientRequestId,
    lastDefinitiveObservation, lastObservation, mergeRequestArchiveRecord,
    requestEvidenceArchiveId, requestJournalArchiveId, requestObservation,
    sequenceObservationUpdates, standingReceiptClaim, terminalRequestArchiveToPrune,
    unresolvedRequestArchiveAt
} = unsupportedExports('request-archive');
