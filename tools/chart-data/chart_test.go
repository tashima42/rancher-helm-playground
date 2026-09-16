package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const readme = `
# Rancher

Some prose that mentions | a pipe | and must not be read as a table.

#### Common Options

| Parameter | Default Value | Description |
| --------------- | -------------- | --------------------------------------------------------- |
| ` + "`hostname`" + ` | " " | ` + "`string`" + ` - the FQDN, e.g. ` + "`rancher.example.com`" + ` |
| ` + "`replicas`" + ` | 3 | ` + "`int`" + ` - pods to run |
| ` + "`debug`" + ` | false | ` + "`bool`" + ` - verbose logging |

#### Advanced Options

| Parameter | Default Value | Description |
| --------------- | -------------- | ------------ |
| ` + "`extraEnv`" + ` | [] | ` + "`list`" + ` - added to the deployment |
| ` + "`antiAffinity`" + ` | "preferred" | one of ` + "`preferred`" + ` \| ` + "`required`" + ` |

### Something Else

| Parameter | Default Value | Description |
| --- | --- | --- |
| ` + "`ignored`" + ` | 1 | not under an options heading |
`

func TestParseOptions(t *testing.T) {
	options := parseOptions([]byte(readme))

	if len(options) != 5 {
		t.Fatalf("got %d options, want 5: %v", len(options), options)
	}

	first := options[0]
	if first["path"] != "hostname" {
		t.Errorf("path = %q, want hostname", first["path"])
	}
	if first["section"] != "common" {
		t.Errorf("section = %q, want common", first["section"])
	}
	if first["defaultRaw"] != `" "` {
		t.Errorf("defaultRaw = %q, want a quoted space", first["defaultRaw"])
	}
	// Backticks are only stripped from the parameter cell; the description keeps
	// them so the UI can render it as written.
	if want := "`string` - the FQDN, e.g. `rancher.example.com`"; first["description"] != want {
		t.Errorf("description = %q, want %q", first["description"], want)
	}

	if options[3]["section"] != "advanced" {
		t.Errorf("extraEnv section = %q, want advanced", options[3]["section"])
	}

	// A description may contain pipes, which must not be mistaken for cells.
	if want := "one of `preferred` \\| `required`"; options[4]["description"] != want {
		t.Errorf("description = %q, want %q", options[4]["description"], want)
	}

	for _, option := range options {
		if option["path"] == "ignored" {
			t.Error("a table outside the options headings was read")
		}
	}
}

func TestParseOptionsWithoutReadme(t *testing.T) {
	// Charts old enough to ship without a README contribute an empty list, not
	// null: the payload shape has to be the same for every version.
	options := parseOptions(nil)
	if options == nil || len(options) != 0 {
		t.Fatalf("got %v, want an empty list", options)
	}
}

func TestParseDefault(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want any
	}{
		{"", ""},
		{`" "`, ""},
		{`""`, ""},
		{"[]", []any{}},
		{"{}", map[string]any{}},
		{"true", true},
		{"false", false},
		{"3", json.Number("3")},
		{"-1", json.Number("-1")},
		{`"preferred"`, "preferred"},
		// Prose, not a value: the UI falls back to what values.yaml says.
		{"same as chart version", nil},
		{"1.2", nil},
	} {
		got := parseDefault(test.raw)
		if !jsonEqual(t, got, test.want) {
			t.Errorf("parseDefault(%q) = %#v, want %#v", test.raw, got, test.want)
		}
	}
}

func TestFlattenSchema(t *testing.T) {
	body := []byte(`{
	  "properties": {
	    "antiAffinity": {"type": "string", "enum": ["preferred", "required"]},
	    "ingress": {
	      "type": "object",
	      "properties": {
	        "enabled": {"type": "boolean", "description": "serve over ingress"},
	        "extraAnnotations": {}
	      }
	    }
	  }
	}`)

	schema, err := flattenSchema(body)
	if err != nil {
		t.Fatal(err)
	}

	if _, ok := schema["ingress.enabled"]; !ok {
		t.Fatalf("nested property missing: %v", schema)
	}
	enabled := schema["ingress.enabled"].(map[string]any)
	if enabled["type"] != "boolean" || enabled["description"] != "serve over ingress" {
		t.Errorf("ingress.enabled = %v", enabled)
	}
	// A property with nothing worth keeping is left out entirely.
	if _, ok := schema["ingress.extraAnnotations"]; ok {
		t.Error("an empty property was kept")
	}
	if len(schema["antiAffinity"].(map[string]any)["enum"].([]any)) != 2 {
		t.Errorf("enum lost: %v", schema["antiAffinity"])
	}
}

func TestFlattenSchemaWithoutSchema(t *testing.T) {
	schema, err := flattenSchema(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(schema) != 0 {
		t.Fatalf("got %v, want an empty map", schema)
	}
}

func TestReadChart(t *testing.T) {
	archive := tarball(t, map[string]string{
		"rancher/values.yaml":               "hostname: rancher.example.com\n",
		"rancher/README.md":                 "# Rancher\n",
		"rancher/values.schema.json":        "{}",
		"rancher/templates/deployment.yaml": "kind: Deployment\n",
		// A subchart ships its own values.yaml, which is not this chart's.
		"rancher/charts/fleet/values.yaml": "image: fleet\n",
	})

	files, err := readChart(archive)
	if err != nil {
		t.Fatal(err)
	}

	if string(files["values.yaml"]) != "hostname: rancher.example.com\n" {
		t.Errorf("values.yaml = %q", files["values.yaml"])
	}
	if len(files) != 3 {
		t.Errorf("read %d files, want the three top-level ones: %v", len(files), keys(files))
	}
}

func TestBuildPayload(t *testing.T) {
	payload, err := buildPayload(map[string][]byte{
		"values.yaml": []byte("hostname: rancher.example.com\nreplicas: 3\n"),
		"README.md":   []byte(readme),
	})
	if err != nil {
		t.Fatal(err)
	}

	if bytes.HasSuffix(payload, []byte("\n")) {
		t.Error("the hashed payload must not end in a newline")
	}

	var parsed struct {
		SchemaVersion int              `json:"schemaVersion"`
		Values        map[string]any   `json:"values"`
		Options       []map[string]any `json:"options"`
		Schema        map[string]any   `json:"schema"`
	}
	if err := json.Unmarshal(payload, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.SchemaVersion != schemaVersion {
		t.Errorf("schemaVersion = %d, want %d", parsed.SchemaVersion, schemaVersion)
	}
	if parsed.Values["hostname"] != "rancher.example.com" {
		t.Errorf("values = %v", parsed.Values)
	}
	if len(parsed.Options) != 5 {
		t.Errorf("got %d options", len(parsed.Options))
	}
	// Every option carries the parsed default alongside the raw cell.
	if parsed.Options[1]["default"] != float64(3) {
		t.Errorf("replicas default = %#v, want 3", parsed.Options[1]["default"])
	}
	if parsed.Schema == nil {
		t.Error("schema must be an object even when the chart ships none")
	}
}

func TestBuildPayloadIsStable(t *testing.T) {
	// Content addressing only dedupes if the same chart always hashes the same,
	// whatever order the map is walked in.
	files := map[string][]byte{
		"values.yaml": []byte("b: 2\na: 1\nnested:\n  y: true\n  x: false\n"),
		"README.md":   []byte(readme),
	}

	first, err := buildPayload(files)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		again, err := buildPayload(files)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(first, again) {
			t.Fatalf("payload changed between runs:\n%s\n%s", first, again)
		}
	}
}

func TestWritePayload(t *testing.T) {
	dir := t.TempDir()
	payload := []byte(`{"a":1}`)
	sum := sha256.Sum256(payload)
	file := filepath.Join(dir, hex.EncodeToString(sum[:])+".json")

	if err := writePayload(file, payload); err != nil {
		t.Fatal(err)
	}

	// The file the UI fetches ends in a newline; the hash it is named after is
	// taken over the payload without one.
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != `{"a":1}`+"\n" {
		t.Errorf("wrote %q", body)
	}
	if again := sha256.Sum256(bytes.TrimRight(body, "\n")); again != sum {
		t.Error("the written file no longer hashes to its own name")
	}

	// An existing payload is left alone: its name already proves its contents.
	if err := os.WriteFile(file, []byte("kept\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writePayload(file, payload); err != nil {
		t.Fatal(err)
	}
	if body, _ := os.ReadFile(file); string(body) != "kept\n" {
		t.Errorf("rewrote an existing payload: %q", body)
	}
}

/* --------------------------------------------------------------------- *
 * helpers
 * --------------------------------------------------------------------- */

func tarball(t *testing.T, files map[string]string) []byte {
	t.Helper()

	var buffer bytes.Buffer
	zipped := gzip.NewWriter(&buffer)
	archive := tar.NewWriter(zipped)

	for name, body := range files {
		header := &tar.Header{Name: name, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if err := archive.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}

	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := zipped.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func keys(files map[string][]byte) []string {
	out := make([]string, 0, len(files))
	for name := range files {
		out = append(out, name)
	}
	return out
}

// jsonEqual compares through JSON, so json.Number and the empty containers
// compare by what they serialise to rather than by Go type.
func jsonEqual(t *testing.T, got, want any) bool {
	t.Helper()

	left, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	right, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Equal(left, right)
}
