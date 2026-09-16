package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSortByVersion(t *testing.T) {
	entries := []indexEntry{
		{Version: "2.9.0"},
		{Version: "2.10.0"},
		{Version: "2.10.0-rc1"},
		{Version: "not-a-version"},
		{Version: "2.10.1"},
	}
	sortByVersion(entries)

	// Semver order, highest first, with the pre-release below its release and
	// anything helm cannot parse at the end.
	want := []string{"2.10.1", "2.10.0", "2.10.0-rc1", "2.9.0", "not-a-version"}
	for i, version := range want {
		if entries[i].Version != version {
			t.Fatalf("position %d is %q, want %q (%v)", i, entries[i].Version, version, entries)
		}
	}
}

func TestReadIndex(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/index.yaml" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Write([]byte(`
apiVersion: v1
entries:
  rancher:
    - version: 2.9.0
      appVersion: v2.9.0
      created: "2024-01-01T00:00:00Z"
      digest: aaa
      urls: [rancher-2.9.0.tgz]
    - version: 2.10.0
      appVersion: v2.10.0
      created: "2024-06-01T00:00:00Z"
      digest: bbb
      urls: [rancher-2.10.0.tgz]
  rancher-prime:
    - version: 2.10.0
      digest: ccc
      urls: [rancher-prime-2.10.0.tgz]
`))
	}))
	defer server.Close()

	entries, err := readIndex(server.URL, "rancher")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Version != "2.10.0" {
		t.Fatalf("got %v", entries)
	}
	// The timestamp is kept as the repository wrote it, so a refresh does not
	// rewrite every version file with a reformatted date.
	if entries[1].Created != "2024-01-01T00:00:00Z" {
		t.Errorf("created = %q", entries[1].Created)
	}

	// A repository holding several charts must hand back the one asked for.
	if _, err := readIndex(server.URL, "nope"); err == nil {
		t.Error("an unknown chart should be an error")
	}
}

func TestTarballURL(t *testing.T) {
	for _, test := range []struct {
		name string
		repo string
		url  string
		want string
	}{
		{
			name: "absolute urls are taken as they are",
			repo: "https://example.com/charts",
			url:  "https://cdn.example.com/rancher-2.9.0.tgz",
			want: "https://cdn.example.com/rancher-2.9.0.tgz",
		},
		{
			name: "relative urls resolve against the repository",
			repo: "https://example.com/charts",
			url:  "rancher-2.9.0.tgz",
			want: "https://example.com/charts/rancher-2.9.0.tgz",
		},
		{
			name: "a trailing slash on the repository changes nothing",
			repo: "https://example.com/charts/",
			url:  "rancher-2.9.0.tgz",
			want: "https://example.com/charts/rancher-2.9.0.tgz",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := tarballURL(test.repo, indexEntry{URLs: []string{test.url}})
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Errorf("got %q, want %q", got, test.want)
			}
		})
	}

	if _, err := tarballURL("https://example.com", indexEntry{}); err == nil {
		t.Error("an entry without a url should be an error")
	}
}

func TestBuildCandidates(t *testing.T) {
	config := &Config{
		SchemaVersion: schemaVersion,
		Chart:         "rancher",
		Distributions: []Distribution{{
			ID: "community",
			Channels: []Channel{
				{ID: "ga", Repo: "https://example.com/charts", Match: `^[0-9]+\.[0-9]+\.[0-9]+$`},
				// Shares the repository with ga, and its regex would also accept
				// a GA version, so the first channel has to keep it.
				{ID: "rc", Repo: "https://example.com/charts", Match: `^[0-9]`, Devel: true, Limit: 2},
			},
		}},
	}

	repos := map[string]*repoVersions{
		"https://example.com/charts\x00rancher": {versions: []indexEntry{
			{Version: "2.10.0", Created: "2024-06-01T00:00:00Z", Digest: "a", URLs: []string{"a.tgz"}},
			{Version: "2.10.0-rc2", Created: "2024-05-02T00:00:00Z", Digest: "b", URLs: []string{"b.tgz"}},
			{Version: "2.10.0-rc1", Created: "2024-05-01T00:00:00Z", Digest: "c", URLs: []string{"c.tgz"}},
			{Version: "2.9.0", Created: "2024-01-01T00:00:00Z", Digest: "d", URLs: []string{"d.tgz"}},
			// No digest: the repository is mid-publish, so there is nothing to
			// record this version against.
			{Version: "2.11.0", Created: "2024-07-01T00:00:00Z", URLs: []string{"e.tgz"}},
		}},
	}

	candidates, err := buildCandidates(config, repos)
	if err != nil {
		t.Fatal(err)
	}

	var ga, rc []string
	for _, c := range candidates {
		switch c.Channel {
		case "ga":
			ga = append(ga, c.Version)
		case "rc":
			rc = append(rc, c.Version)
		}
	}

	// Most recently pushed first, and the digest-less version left out.
	if len(ga) != 2 || ga[0] != "2.10.0" || ga[1] != "2.9.0" {
		t.Errorf("ga = %v", ga)
	}
	// rc matches the GA versions too but they are already claimed, and its limit
	// of two is applied before the claims are, as the newest two of what it
	// matched were 2.10.0 and 2.10.0-rc2.
	if len(rc) != 1 || rc[0] != "2.10.0-rc2" {
		t.Errorf("rc = %v", rc)
	}

	for _, c := range candidates {
		if c.Version == "2.10.0" && c.Channel == "ga" {
			// Rank is helm's own ordering, so the newest GA is what an install
			// without --version would resolve to.
			if c.Rank != 0 {
				t.Errorf("2.10.0 rank = %d, want 0", c.Rank)
			}
			if c.URL != "https://example.com/charts/a.tgz" {
				t.Errorf("url = %q", c.URL)
			}
			if c.Chart != "rancher" {
				t.Errorf("chart = %q", c.Chart)
			}
		}
	}
}

func TestBuildCandidatesRejectsABadRegex(t *testing.T) {
	config := &Config{
		Chart: "rancher",
		Distributions: []Distribution{{
			ID:       "community",
			Channels: []Channel{{ID: "ga", Repo: "r", Match: "("}},
		}},
	}
	if _, err := buildCandidates(config, map[string]*repoVersions{}); err == nil {
		t.Error("an unparseable match regex should be an error")
	}
}
