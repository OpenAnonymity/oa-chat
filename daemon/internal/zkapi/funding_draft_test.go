package zkapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNativeAmountEditArchivesOnlyUnsignedDraft(t *testing.T) {
	f := newAddressFixture(t, true)
	first, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(f.h.statePath)
	if err != nil {
		t.Fatal(err)
	}
	next, err := f.h.QuoteAddressDeposit(context.Background(), 200000)
	if err != nil || next.Amount != 200000 || next.ID == first.ID || len(f.submitted) != 0 {
		t.Fatalf("unsigned edit failed: %+v %v", next, err)
	}
	files, err := filepath.Glob(f.h.statePath + ".unsigned-*")
	if err != nil || len(files) != 1 {
		t.Fatal("old recovery draft was not archived")
	}
	archived, err := os.ReadFile(files[0])
	if err != nil || string(archived) != string(before) {
		t.Fatal("archive lost the old recovery note")
	}
	info, err := os.Stat(files[0])
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("draft archive is not private")
	}
	if _, err = f.h.ApproveAddressDeposit(context.Background(), first.ID); err == nil {
		t.Fatal("amount edit retained old approval")
	}
}

func TestNativeAmountEditCannotReplaceSignedOrActiveNote(t *testing.T) {
	for _, active := range []bool{false, true} {
		f := newAddressFixture(t, true)
		q, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
		if err != nil {
			t.Fatal(err)
		}
		if active {
			f.active = true
		} else if _, err = f.h.ApproveAddressDeposit(context.Background(), q.ID); err != nil {
			t.Fatal(err)
		}
		before, err := os.ReadFile(f.h.statePath)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.h.prepare(context.Background(), 200000); err == nil {
			t.Fatal("unsafe draft replaced")
		}
		after, err := os.ReadFile(f.h.statePath)
		if err != nil || string(before) != string(after) {
			t.Fatal("blocked edit changed recovery data")
		}
	}
}
