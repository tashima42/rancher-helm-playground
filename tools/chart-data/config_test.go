package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfig(t *testing.T) {
	path := write(t, `
schemaVersion: 1
chart: rancher
distributions:
  - id: community
    label: Community (CE)
    channels:
      - id: ga
        repo: https://example.com/charts
        match: '^[0-9]'
  - id: prime
    chart: rancher-prime
    channels:
      - id: ga
        label: GA
        repo: https://example.com/prime
        match: '^[0-9]'
        limit: 30
`)

	config, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}

	if len(config.Distributions) != 2 {
		t.Fatalf("read %d distributions", len(config.Distributions))
	}
	// A distribution publishes the top-level chart unless it names its own.
	if got := config.chartName(config.Distributions[0]); got != "rancher" {
		t.Errorf("community chart = %q", got)
	}
	if got := config.chartName(config.Distributions[1]); got != "rancher-prime" {
		t.Errorf("prime chart = %q", got)
	}
	// Labels fall back to the id, so a channel can be added with two lines.
	if got := config.Distributions[1].displayLabel(); got != "prime" {
		t.Errorf("prime label = %q", got)
	}
	if got := config.Distributions[0].Channels[0].displayLabel(); got != "ga" {
		t.Errorf("channel label = %q", got)
	}
	if config.Distributions[1].Channels[0].Limit != 30 {
		t.Errorf("limit = %d", config.Distributions[1].Channels[0].Limit)
	}
}

func TestLoadConfigRejectsAnotherSchema(t *testing.T) {
	// The generator and the config have to agree on what the fields mean; the
	// UI reads a whole output directory per schema version.
	if _, err := loadConfig(write(t, "schemaVersion: 99\nchart: rancher\n")); err == nil {
		t.Error("a config from another schema should be an error")
	}
	if _, err := loadConfig(write(t, "chart: rancher\n")); err == nil {
		t.Error("a config without a schemaVersion should be an error")
	}
}

func TestLoadConfigDefaultsTheChart(t *testing.T) {
	config, err := loadConfig(write(t, "schemaVersion: 1\n"))
	if err != nil {
		t.Fatal(err)
	}
	if config.Chart != "rancher" {
		t.Errorf("chart = %q", config.Chart)
	}
}

func TestLoadConfigWithoutAFile(t *testing.T) {
	if _, err := loadConfig(filepath.Join(t.TempDir(), "nope.yaml")); err == nil {
		t.Error("a missing config should be an error")
	}
}

func write(t *testing.T, body string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "repos.yaml")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}
