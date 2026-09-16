package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPending(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "charts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(payloadPath(dir, "kept"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	candidates := []candidate{
		{Distribution: "community", Version: "new", Digest: "1"},
		{Distribution: "community", Version: "done", Digest: "2"},
		{Distribution: "community", Version: "republished", Digest: "3-new"},
		{Distribution: "community", Version: "gone", Digest: "4"},
		{Distribution: "community", Version: "deleted-payload", Digest: "5"},
	}
	ledger := map[string]ledgerEntry{
		"community/done":            {Digest: "2", Chart: "kept"},
		"community/republished":     {Digest: "3-old", Chart: "kept"},
		"community/gone":            {Digest: "4", Missing: true},
		"community/deleted-payload": {Digest: "5", Chart: "swept-up"},
	}

	got := versions(pending(candidates, ledger, options{outDir: dir}))
	want := []string{"new", "republished", "deleted-payload"}
	if !equal(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}

	// A version the repository no longer hosts is only looked for again when
	// asked, since the answer is almost always the same.
	got = versions(pending(candidates, ledger, options{outDir: dir, retryMissing: true}))
	want = []string{"new", "republished", "gone", "deleted-payload"}
	if !equal(got, want) {
		t.Errorf("with --retry-missing got %v, want %v", got, want)
	}
}

func TestPruneOrphans(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "charts"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, hash := range []string{"referenced", "orphan"} {
		if err := os.WriteFile(payloadPath(dir, hash), []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	ledger := map[string]ledgerEntry{
		"community/2.10.0": {Digest: "1", Chart: "referenced"},
		// Missing versions point at no payload, so they keep nothing alive.
		"community/2.9.0": {Digest: "2", Missing: true},
	}

	removed, remaining, err := pruneOrphans(dir, ledger)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 || remaining != 1 {
		t.Errorf("removed %d, %d remaining", removed, remaining)
	}
	if _, err := os.Stat(payloadPath(dir, "orphan")); !os.IsNotExist(err) {
		t.Error("the orphan is still there")
	}
	if _, err := os.Stat(payloadPath(dir, "referenced")); err != nil {
		t.Error("a referenced payload was deleted")
	}
}

func TestCandidateKey(t *testing.T) {
	// The ledger is keyed per distribution: community and prime publish the same
	// version numbers from different repositories.
	key := candidate{Distribution: "prime", Version: "2.10.0"}.key()
	if key != "prime/2.10.0" {
		t.Errorf("key = %q", key)
	}
}

func versions(candidates []candidate) []string {
	out := make([]string, 0, len(candidates))
	for _, c := range candidates {
		out = append(out, c.Version)
	}
	return out
}

func equal(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
