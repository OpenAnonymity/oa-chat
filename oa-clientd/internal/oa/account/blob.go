package account

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// These labels are the existing version-1 encrypted-sync wire format in the
// browser's encryptedSyncService.js. Changing one orphans every account's data.
const (
	syncSalt = "oa-sync-v1"
	hmacSalt = "oa-sync-id-v1"

	logicalActive      = "tickets-active"
	logicalArchive     = "tickets-archive"
	logicalTombstones  = "tickets-tombstones"
	logicalInvalidated = "tickets-invalidated-key-ids"
	logicalInvalidItem = "ticket-invalidation-item"
	// One record per installation, so two devices that pull the same state and
	// overwrite the shared archive still learn each other's spends. Current
	// browsers write and read these; older ones ignore them.
	logicalRemovals = "ticket-removals"
	// A lease uses one fixed key and an ID per device, like an invalidation
	// item, so only its holder ever overwrites it and older clients ignore it.
	logicalLeaseItem = "ticket-lease-item"
)

// Blob is the opaque record the org stores.
type Blob struct {
	ID         string `json:"id"`
	Ciphertext string `json:"ciphertext"`
	IV         string `json:"iv"`
	Version    int    `json:"version"`
	UpdatedAt  int64  `json:"updated_at,omitempty"`
}

// BlobID is the HMAC-derived opaque ID: the first 16 bytes as lowercase hex.
func BlobID(master []byte, logicalID string) string {
	mac := hmac.New(sha256.New, master)
	mac.Write([]byte(hmacSalt + ":" + logicalID))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func itemCipher(master []byte, logicalID string) (cipher.AEAD, error) {
	key, err := hkdf.Key(sha256.New, master, []byte(syncSalt), logicalID, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Seal encrypts a payload under its logical ID's derived key.
func Seal(master []byte, logicalID, opaqueID string, payload any) (Blob, error) {
	aead, err := itemCipher(master, logicalID)
	if err != nil {
		return Blob{}, errors.New("cannot derive sync key")
	}
	plaintext, err := json.Marshal(payload)
	if err != nil {
		return Blob{}, errors.New("cannot encode sync payload")
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return Blob{}, errors.New("cannot generate sync nonce")
	}
	return Blob{
		ID:         opaqueID,
		Ciphertext: base64.StdEncoding.EncodeToString(aead.Seal(nil, nonce, plaintext, nil)),
		IV:         base64.StdEncoding.EncodeToString(nonce),
		Version:    1,
	}, nil
}

// Open decrypts a blob under a logical ID's derived key.
func Open(master []byte, logicalID string, blob Blob) ([]byte, error) {
	aead, err := itemCipher(master, logicalID)
	if err != nil {
		return nil, errors.New("cannot derive sync key")
	}
	nonce, err := base64.StdEncoding.DecodeString(blob.IV)
	if err != nil || len(nonce) != 12 {
		return nil, errors.New("invalid sync nonce")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(blob.Ciphertext)
	if err != nil {
		return nil, errors.New("invalid sync ciphertext")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, errors.New("sync blob could not be decrypted")
	}
	return plaintext, nil
}
