package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path"
	"regexp"
	"strings"
	"sync"

	"go.yaml.in/yaml/v3"
)

// result is what one download decided about one version. A missing chart is a
// version the repository still indexes but no longer hosts: a permanent state,
// so it is recorded rather than retried.
type result struct {
	key     string
	digest  string
	hash    string
	missing bool
}

// download fetches every version in todo and writes the payloads, returning what
// to record and how many attempts failed for a reason worth retrying.
func download(todo []candidate, opts options) ([]result, int) {
	if len(todo) == 0 {
		return nil, 0
	}

	var (
		mutex   sync.Mutex
		results []result
		failed  int
		wg      sync.WaitGroup
	)

	queue := make(chan candidate)
	for worker := 0; worker < opts.jobs; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for c := range queue {
				got, err := pullOne(c, opts.outDir)
				mutex.Lock()
				if err != nil {
					log.Printf("%s %s: %v", c.Distribution, c.Version, err)
					failed++
				} else {
					results = append(results, got)
				}
				mutex.Unlock()
			}
		}()
	}

	for _, c := range todo {
		queue <- c
	}
	close(queue)
	wg.Wait()

	return results, failed
}

// pullOne downloads one chart archive and writes its payload.
func pullOne(c candidate, outDir string) (result, error) {
	archive, err := fetch(c.URL)
	if err != nil {
		if isNotFound(err) {
			return result{key: c.key(), digest: c.Digest, missing: true}, nil
		}
		return result{}, err
	}

	files, err := readChart(archive)
	if err != nil {
		return result{}, err
	}
	if files["values.yaml"] == nil {
		return result{}, fmt.Errorf("no values.yaml")
	}

	payload, err := buildPayload(files)
	if err != nil {
		return result{}, err
	}

	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:])
	if err := writePayload(payloadPath(outDir, hash), payload); err != nil {
		return result{}, err
	}
	return result{key: c.key(), digest: c.Digest, hash: hash}, nil
}

// readChart pulls the three files the payload is built from out of the archive.
// Paths inside a chart archive are prefixed with the chart directory.
func readChart(archive []byte) (map[string][]byte, error) {
	wanted := map[string]bool{"values.yaml": true, "README.md": true, "values.schema.json": true}
	files := make(map[string][]byte, len(wanted))

	unzipped, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("not a gzip archive: %w", err)
	}
	defer unzipped.Close()

	reader := tar.NewReader(unzipped)
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}

		// Only the chart's own files, not those of a subchart in charts/.
		name := header.Name
		if index := strings.Index(name, "/"); index >= 0 {
			name = name[index+1:]
		}
		if path.Dir(name) != "." || !wanted[path.Base(name)] {
			continue
		}

		body, err := io.ReadAll(reader)
		if err != nil {
			return nil, err
		}
		files[name] = body
	}
	return files, nil
}

// buildPayload renders the canonical JSON the payload hash is taken over.
func buildPayload(files map[string][]byte) ([]byte, error) {
	var values any
	if err := yaml.Unmarshal(files["values.yaml"], &values); err != nil {
		return nil, fmt.Errorf("values.yaml: %w", err)
	}
	if values == nil {
		values = map[string]any{}
	}

	options := parseOptions(files["README.md"])
	for _, option := range options {
		option["default"] = parseDefault(option["defaultRaw"].(string))
	}

	schema, err := flattenSchema(files["values.schema.json"])
	if err != nil {
		return nil, fmt.Errorf("values.schema.json: %w", err)
	}

	return canonicalJSON(map[string]any{
		"schemaVersion": schemaVersion,
		"values":        values,
		"options":       options,
		"schema":        schema,
	})
}

func writePayload(file string, payload []byte) error {
	if _, err := os.Stat(file); err == nil {
		return nil
	}

	// Written through a temporary name so a killed run never leaves a payload
	// that hashes to something other than its own name.
	temp, err := os.CreateTemp(path.Dir(file), ".payload-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())

	if _, err := temp.Write(append(payload, '\n')); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(temp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(temp.Name(), file)
}

/* --------------------------------------------------------------------- *
 * README options
 * --------------------------------------------------------------------- */

// parseOptions reads the markdown tables under "#### Common Options" and
// "#### Advanced Options" into [{path, defaultRaw, description, section}].
func parseOptions(readme []byte) []map[string]any {
	options := []map[string]any{}
	if len(readme) == 0 {
		return options
	}

	section := ""
	for _, line := range strings.Split(string(readme), "\n") {
		switch {
		case strings.HasPrefix(line, "#### Common Options"):
			section = "common"
			continue
		case strings.HasPrefix(line, "#### Advanced Options"):
			section = "advanced"
			continue
		case strings.HasPrefix(line, "#"):
			section = ""
			continue
		}

		if section == "" || !strings.HasPrefix(line, "|") || isSeparatorRow(line) {
			continue
		}

		cells := strings.Split(line, "|")
		if len(cells) < 4 {
			continue
		}
		optionPath := unwrap(cells[1])
		if optionPath == "" || optionPath == "Parameter" {
			continue
		}

		// Descriptions may contain pipes; rejoin everything after the default
		// cell, leaving out the empty cell the trailing pipe produces.
		description := cells[3]
		for i := 4; i <= len(cells)-2; i++ {
			description += "|" + cells[i]
		}

		options = append(options, map[string]any{
			"path":        flatten(optionPath),
			"defaultRaw":  flatten(trim(cells[2])),
			"description": flatten(trim(description)),
			"section":     section,
		})
	}
	return options
}

// separatorRow is the |---|---| line under a markdown table's header.
var separatorRow = regexp.MustCompile(`^\|[ \-|]+\|$`)

func isSeparatorRow(line string) bool { return separatorRow.MatchString(line) }

func trim(cell string) string { return strings.Trim(cell, " \t") }

func unwrap(cell string) string { return trim(strings.ReplaceAll(cell, "`", "")) }

// flatten keeps a cell on one line, the way the previous awk extractor did.
func flatten(cell string) string { return strings.ReplaceAll(cell, "\t", " ") }

// parseDefault turns the README's "Default Value" cell into a real value, or
// nil when the cell is prose ("same as chart version") rather than a value.
func parseDefault(raw string) any {
	switch raw {
	case "", `" "`, `""`:
		return ""
	case "[]":
		return []any{}
	case "{}":
		return map[string]any{}
	case "true":
		return true
	case "false":
		return false
	}

	if isInteger(raw) {
		// A literal, so a value too large for an int survives the round trip.
		return json.Number(raw)
	}
	if len(raw) >= 2 && strings.HasPrefix(raw, `"`) && strings.HasSuffix(raw, `"`) &&
		!strings.Contains(raw, "\n") {
		return raw[1 : len(raw)-1]
	}
	return nil
}

func isInteger(raw string) bool {
	digits := strings.TrimPrefix(raw, "-")
	if digits == "" {
		return false
	}
	for _, r := range digits {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

/* --------------------------------------------------------------------- *
 * values.schema.json
 * --------------------------------------------------------------------- */

// flattenSchema turns the chart's own schema into {"path": {type, enum,
// description}}. This is where the allowed values behind the UI dropdowns come
// from; charts old enough to ship without one contribute nothing.
func flattenSchema(body []byte) (map[string]any, error) {
	out := map[string]any{}
	if len(body) == 0 {
		return out, nil
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	var root map[string]any
	if err := decoder.Decode(&root); err != nil {
		return nil, err
	}

	walkSchema(root, "", out)
	return out, nil
}

func walkSchema(node map[string]any, prefix string, out map[string]any) {
	properties, _ := node["properties"].(map[string]any)
	for key, raw := range properties {
		property, _ := raw.(map[string]any)
		if property == nil {
			continue
		}

		fullPath := prefix + key
		entry := map[string]any{}
		for _, field := range []string{"type", "enum", "description"} {
			if value, ok := property[field]; ok && value != nil {
				entry[field] = value
			}
		}
		if len(entry) > 0 {
			out[fullPath] = entry
		}
		walkSchema(property, fullPath+".", out)
	}
}
