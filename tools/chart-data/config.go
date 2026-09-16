package main

import (
	"fmt"
	"os"

	"go.yaml.in/yaml/v3"
)

// Config is docs/data/repos.yaml, the only hand-maintained input.
type Config struct {
	SchemaVersion int            `yaml:"schemaVersion"`
	Chart         string         `yaml:"chart"`
	Distributions []Distribution `yaml:"distributions"`
}

type Distribution struct {
	ID    string `yaml:"id"`
	Label string `yaml:"label"`
	// Overrides the top-level chart name for this distribution.
	Chart    string    `yaml:"chart"`
	Channels []Channel `yaml:"channels"`
}

type Channel struct {
	ID    string `yaml:"id"`
	Label string `yaml:"label"`
	Hint  string `yaml:"hint"`
	Repo  string `yaml:"repo"`
	// Extended regex tested against the chart version, not the appVersion.
	Match string `yaml:"match"`
	// Pre-release channel, so the generated helm command needs --devel.
	Devel bool `yaml:"devel"`
	// Keep only the newest N versions in the UI list; 0 means all of them.
	Limit int `yaml:"limit"`
}

func loadConfig(path string) (*Config, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config not found: %w", err)
	}

	var config Config
	if err := yaml.Unmarshal(body, &config); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if config.SchemaVersion != schemaVersion {
		return nil, fmt.Errorf("%s: schemaVersion must be %d", path, schemaVersion)
	}
	if config.Chart == "" {
		config.Chart = "rancher"
	}
	return &config, nil
}

// chartName is the chart a distribution publishes.
func (c *Config) chartName(d Distribution) string {
	if d.Chart != "" {
		return d.Chart
	}
	return c.Chart
}

func (d Distribution) displayLabel() string {
	if d.Label != "" {
		return d.Label
	}
	return d.ID
}

func (c Channel) displayLabel() string {
	if c.Label != "" {
		return c.Label
	}
	return c.ID
}
