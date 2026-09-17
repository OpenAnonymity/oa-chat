package ticket

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestCountContextCancelsWhileAnotherProcessOwnsWalletLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tickets.json")
	b, err := New(Config{OrgURL: "https://org.example", VerifierURL: "https://verifier.example", WalletPath: path, Client: &http.Client{}})
	if err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.CountContext(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("count ignored cancellation: %v", err)
	}
}
