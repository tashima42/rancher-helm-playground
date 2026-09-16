package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// ledgerEntry records what one version was built from. A version with a payload
// carries the hash of the file it is stored in; one the repository no longer
// hosts is marked missing so it is never asked for again.
type ledgerEntry struct {
	Chart   string `json:"chart,omitempty"`
	Digest  string `json:"digest"`
	Missing bool   `json:"missing,omitempty"`
}

type stateFile struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Generator     int                    `json:"generator"`
	Entries       map[string]ledgerEntry `json:"entries"`
}

// loadLedger reads the ledger from a previous run, unless it was written by a
// generator whose payloads had a different shape.
func loadLedger(path string, fullRefresh bool) (map[string]ledgerEntry, error) {
	if fullRefresh {
		return map[string]ledgerEntry{}, nil
	}

	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]ledgerEntry{}, nil
	}
	if err != nil {
		return nil, err
	}

	var state stateFile
	if err := json.Unmarshal(body, &state); err != nil {
		return nil, err
	}
	if state.Generator != generator || state.SchemaVersion != schemaVersion || state.Entries == nil {
		return map[string]ledgerEntry{}, nil
	}
	return state.Entries, nil
}

func writeState(path string, ledger map[string]ledgerEntry) error {
	// A map, so the keys come out sorted and indented: a refresh then shows up as
	// a readable diff rather than a reshuffle.
	body, err := prettyJSON(map[string]any{
		"schemaVersion": schemaVersion,
		"generator":     generator,
		"entries":       ledger,
	})
	if err != nil {
		return err
	}
	return os.WriteFile(path, body, 0o644)
}

/* --------------------------------------------------------------------- *
 * The files the UI reads
 * --------------------------------------------------------------------- */

type versionsFile struct {
	SchemaVersion int           `json:"schemaVersion"`
	Distribution  string        `json:"distribution"`
	Channel       string        `json:"channel"`
	Versions      []versionItem `json:"versions"`
}

type versionItem struct {
	Version    string `json:"version"`
	AppVersion string `json:"appVersion"`
	Created    string `json:"created"`
	// Payload file holding this version's values.
	Chart string `json:"chart"`
}

type indexJSON struct {
	SchemaVersion int                 `json:"schemaVersion"`
	GeneratedAt   string              `json:"generatedAt"`
	Chart         string              `json:"chart"`
	Distributions []indexDistribution `json:"distributions"`
}

type indexDistribution struct {
	ID       string         `json:"id"`
	Label    string         `json:"label"`
	Chart    string         `json:"chart"`
	Channels []indexChannel `json:"channels"`
}

type indexChannel struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Hint  string `json:"hint"`
	Repo  string `json:"repo"`
	Devel bool   `json:"devel"`
	Count int    `json:"count"`
	// What helm installs without --version: the highest semver, not the most
	// recently pushed. Null when the channel has nothing to offer.
	Latest   *string `json:"latest"`
	Versions string  `json:"versions"`
}

// built returns the channel's versions that made it all the way to a payload.
func built(candidates []candidate, ledger map[string]ledgerEntry, distribution, channel string) []candidate {
	var out []candidate
	for _, c := range candidates {
		if c.Distribution != distribution || c.Channel != channel {
			continue
		}
		if entry, ok := ledger[c.key()]; ok && entry.Chart != "" {
			out = append(out, c)
		}
	}
	return out
}

func writeVersionFiles(outDir string, config *Config, candidates []candidate, ledger map[string]ledgerEntry) error {
	for _, distribution := range config.Distributions {
		for _, channel := range distribution.Channels {
			file := versionsFile{
				SchemaVersion: schemaVersion,
				Distribution:  distribution.ID,
				Channel:       channel.ID,
				Versions:      []versionItem{},
			}
			for _, c := range built(candidates, ledger, distribution.ID, channel.ID) {
				file.Versions = append(file.Versions, versionItem{
					Version:    c.Version,
					AppVersion: c.AppVersion,
					Created:    c.Created,
					Chart:      ledger[c.key()].Chart,
				})
			}

			body, err := compactJSON(file)
			if err != nil {
				return err
			}
			name := distribution.ID + "-" + channel.ID + ".json"
			if err := os.WriteFile(filepath.Join(outDir, "versions", name), body, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

func writeIndex(outDir string, config *Config, candidates []candidate, ledger map[string]ledgerEntry) error {
	index := indexJSON{
		SchemaVersion: schemaVersion,
		GeneratedAt:   time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Chart:         config.Chart,
		Distributions: []indexDistribution{},
	}

	for _, distribution := range config.Distributions {
		entry := indexDistribution{
			ID:       distribution.ID,
			Label:    distribution.displayLabel(),
			Chart:    config.chartName(distribution),
			Channels: []indexChannel{},
		}

		for _, channel := range distribution.Channels {
			versions := built(candidates, ledger, distribution.ID, channel.ID)
			if len(versions) == 0 {
				continue
			}

			latest := versions[0]
			for _, c := range versions[1:] {
				if c.Rank < latest.Rank {
					latest = c
				}
			}
			version := latest.Version

			entry.Channels = append(entry.Channels, indexChannel{
				ID:       channel.ID,
				Label:    channel.displayLabel(),
				Hint:     channel.Hint,
				Repo:     channel.Repo,
				Devel:    channel.Devel,
				Count:    len(versions),
				Latest:   &version,
				Versions: "versions/" + distribution.ID + "-" + channel.ID + ".json",
			})
		}
		index.Distributions = append(index.Distributions, entry)
	}

	body, err := prettyJSON(index)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(outDir, "index.json"), body, 0o644)
}

/* --------------------------------------------------------------------- *
 * JSON, written the same way every run so a diff only shows real change
 * --------------------------------------------------------------------- */

// canonicalJSON is compact with every object's keys sorted and no trailing
// newline, which is exactly what the payload hash is taken over.
func canonicalJSON(value any) ([]byte, error) {
	body, err := compactJSON(value)
	if err != nil {
		return nil, err
	}

	// encoding/json sorts map keys but leaves struct fields in declaration
	// order; payloads are built from maps, so a re-encode settles the rest.
	var parsed any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil {
		return nil, err
	}

	body, err = compactJSON(parsed)
	if err != nil {
		return nil, err
	}
	return bytes.TrimRight(body, "\n"), nil
}

func compactJSON(value any) ([]byte, error) { return encode(value, "") }

func prettyJSON(value any) ([]byte, error) { return encode(value, "  ") }

func encode(value any, indent string) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	// The data is read back as JSON, never embedded in HTML, and escaping would
	// only make the generated files harder to read.
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", indent)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}
