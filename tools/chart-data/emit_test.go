package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalJSON(t *testing.T) {
	body, err := canonicalJSON(map[string]any{
		"b":      1,
		"a":      map[string]any{"z": true, "y": false},
		"prose":  "a < b && c > d",
		"number": json.Number("9007199254740993"),
	})
	if err != nil {
		t.Fatal(err)
	}

	want := `{"a":{"y":false,"z":true},"b":1,"number":9007199254740993,"prose":"a < b && c > d"}`
	if string(body) != want {
		t.Errorf("got  %s\nwant %s", body, want)
	}
}

func TestLedgerRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	ledger := map[string]ledgerEntry{
		"community/2.10.0": {Chart: "abc", Digest: "sha256:1"},
		"community/2.9.0":  {Digest: "sha256:2", Missing: true},
	}

	if err := writeState(path, ledger); err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// Indented and key-sorted, so a refresh reads as a diff rather than as a
	// reshuffle of the whole file.
	if !strings.Contains(string(body), "\n  \"entries\": {\n    \"community/2.10.0\"") {
		t.Errorf("state.json is not laid out as expected:\n%s", body)
	}
	// A version with a payload has no "missing" key, and vice versa.
	if strings.Contains(string(body), `"missing": false`) {
		t.Error("missing is written even when it is false")
	}

	read, err := loadLedger(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 2 || read["community/2.10.0"].Chart != "abc" || !read["community/2.9.0"].Missing {
		t.Fatalf("read back %v", read)
	}

	// --full-refresh rebuilds everything, so the ledger is not consulted.
	if fresh, err := loadLedger(path, true); err != nil || len(fresh) != 0 {
		t.Fatalf("full refresh read %v (%v)", fresh, err)
	}
}

func TestLoadLedgerIgnoresAnOlderGenerator(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	body := `{"schemaVersion":1,"generator":0,"entries":{"community/2.10.0":{"digest":"x","chart":"y"}}}`
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	// Payloads written by an older generator have a different shape, so every
	// version is downloaded again rather than trusted.
	ledger, err := loadLedger(path, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(ledger) != 0 {
		t.Fatalf("kept %v", ledger)
	}
}

func TestLoadLedgerWithoutAState(t *testing.T) {
	ledger, err := loadLedger(filepath.Join(t.TempDir(), "state.json"), false)
	if err != nil {
		t.Fatal(err)
	}
	if ledger == nil || len(ledger) != 0 {
		t.Fatalf("got %v, want an empty ledger", ledger)
	}
}

func TestWriteIndexAndVersions(t *testing.T) {
	dir := t.TempDir()
	for _, sub := range []string{"charts", "versions"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	config := &Config{
		SchemaVersion: schemaVersion,
		Chart:         "rancher",
		Distributions: []Distribution{{
			ID:    "community",
			Label: "Community (CE)",
			Channels: []Channel{
				{ID: "ga", Label: "GA", Hint: "stable", Repo: "https://example.com/charts"},
				// Nothing built, so it is left out of the index entirely.
				{ID: "rc", Repo: "https://example.com/charts", Devel: true},
			},
		}},
	}

	candidates := []candidate{
		// Newest push first, which is the order the dropdown shows.
		{Distribution: "community", Channel: "ga", Version: "2.9.5", AppVersion: "v2.9.5", Created: "2024-07-01T00:00:00Z", Rank: 1},
		{Distribution: "community", Channel: "ga", Version: "2.10.0", AppVersion: "v2.10.0", Created: "2024-06-01T00:00:00Z", Rank: 0},
		{Distribution: "community", Channel: "ga", Version: "2.9.0", AppVersion: "v2.9.0", Created: "2024-01-01T00:00:00Z", Rank: 2},
		{Distribution: "community", Channel: "rc", Version: "2.11.0-rc1", Created: "2024-08-01T00:00:00Z", Rank: 0},
	}
	ledger := map[string]ledgerEntry{
		"community/2.9.5":  {Chart: "aaa", Digest: "1"},
		"community/2.10.0": {Chart: "bbb", Digest: "2"},
		// Indexed but no longer hosted, so it never reaches the UI.
		"community/2.9.0": {Digest: "3", Missing: true},
	}

	if err := writeVersionFiles(dir, config, candidates, ledger); err != nil {
		t.Fatal(err)
	}
	if err := writeIndex(dir, config, candidates, ledger); err != nil {
		t.Fatal(err)
	}

	var versions versionsFile
	read(t, filepath.Join(dir, "versions", "community-ga.json"), &versions)
	if len(versions.Versions) != 2 {
		t.Fatalf("versions = %v", versions.Versions)
	}
	if versions.Versions[0].Version != "2.9.5" || versions.Versions[0].Chart != "aaa" {
		t.Errorf("first version = %v", versions.Versions[0])
	}

	// A channel with nothing built still gets a file, so the UI's fetch does not
	// 404 if the index is ever out of step with it.
	var empty versionsFile
	read(t, filepath.Join(dir, "versions", "community-rc.json"), &empty)
	if empty.Versions == nil || len(empty.Versions) != 0 {
		t.Errorf("rc versions = %v, want an empty list", empty.Versions)
	}

	var index indexJSON
	read(t, filepath.Join(dir, "index.json"), &index)
	if len(index.Distributions) != 1 || len(index.Distributions[0].Channels) != 1 {
		t.Fatalf("index = %+v", index)
	}
	channel := index.Distributions[0].Channels[0]
	if channel.ID != "ga" || channel.Count != 2 {
		t.Errorf("channel = %+v", channel)
	}
	// What helm installs without --version is the highest semver, not the most
	// recently pushed, so latest follows rank rather than the list order.
	if channel.Latest == nil || *channel.Latest != "2.10.0" {
		t.Errorf("latest = %v, want 2.10.0", channel.Latest)
	}
	if channel.Versions != "versions/community-ga.json" {
		t.Errorf("versions path = %q", channel.Versions)
	}
	if index.Distributions[0].Label != "Community (CE)" || index.Distributions[0].Chart != "rancher" {
		t.Errorf("distribution = %+v", index.Distributions[0])
	}
}

func read(t *testing.T, path string, into any) {
	t.Helper()

	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(body, into); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}
