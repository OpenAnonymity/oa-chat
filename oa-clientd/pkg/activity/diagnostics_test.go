package activity

import (
	"strings"
	"testing"
)

func TestSummaryEdgesAndCounts(t *testing.T) {
	for _, n := range []int{0, 1, 32, 33, 63, 64, 65, 100} {
		var s Summary
		for range n {
			s.Add("世")
		}
		if s.Count != n || len(s.First) > 32 || len(s.Last) > 32 {
			t.Fatal("unbounded or wrong count")
		}
		if n > 64 && !strings.Contains(s.String(), " ... ") {
			t.Fatal(s.String())
		}
		if n <= 64 && strings.Contains(s.String(), " ... ") {
			t.Fatal(s.String())
		}
	}
	var s Summary
	s.Add("abcdefghijklmnopqrstuvwxyz0123456789")
	if s.String() != `"abcdefghijklmnopqrstuvwxyz0123456789" (36 chars)` {
		t.Fatal(s.String())
	}
}
