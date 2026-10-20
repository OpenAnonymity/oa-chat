// Interpret only the note identity needed by the host signers. Leaf-bound
// calls pack uint32 note ID, uint128 deposit and uint64 expiry into 224 bits.
// Refuse noncanonical high bits instead of masking them into another note.
export function withdrawalCallNoteId(fields, readWord) {
    const value = readWord(fields.noteId);
    if (!fields.packedNoteFields) return value;
    if (value < 0n || value >= (1n << 224n)) return null;
    return value >> 192n;
}
