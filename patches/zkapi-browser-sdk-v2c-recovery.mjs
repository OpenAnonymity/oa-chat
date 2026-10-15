// Registered patch for the concession-exit SDK revision. The revision carries the
// SDK half of the withdrawal-operation recheck itself (prepareWithdrawal and
// claimPreparedWithdrawalSubmission compare the displayed note and operation
// inside the wallet lock), so no file is rewritten. The entry still binds the
// name to this one revision: any other SDK commit is refused until reviewed.
export default {
    revision: '7320d5e2d93b81d8bc34414872261db2cb5af429',
    files: []
};
