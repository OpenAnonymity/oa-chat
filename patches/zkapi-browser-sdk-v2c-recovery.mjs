// Registered patch for the concession-exit SDK revision. The revision carries the
// SDK half of the withdrawal-operation recheck itself (prepareWithdrawal and
// claimPreparedWithdrawalSubmission compare the displayed note and operation
// inside the wallet lock), so no file is rewritten. The entry still binds the
// name to this one revision: any other SDK commit is refused until reviewed.
export default {
    revision: '3e2ecf1cde7cad5d202c005910e509a399c052bf',
    files: []
};
