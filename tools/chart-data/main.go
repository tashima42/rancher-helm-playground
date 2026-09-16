// Command chart-data generates the data the playground UI reads, from what the
// chart repositories in docs/data/repos.yaml actually publish.
//
// Output (all files carry a "schemaVersion"):
//
//	<out>/index.json                      distributions, channels, repo URLs
//	<out>/versions/<dist>-<channel>.json  the version list behind the dropdown
//	<out>/charts/<hash>.json              values + README options + values schema
//	<out>/state.json                      ledger of every version ever processed
//
// Chart payloads are content addressed: consecutive releases almost always ship
// an identical values.yaml, so thousands of versions collapse onto a handful of
// files. The ledger records the index digest each version was built from, so a
// version is downloaded exactly once and never looked at again.
//
// The extraction is pure: interpreting an option's type or allowed values is
// left to docs/js/app.js.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
)

const (
	// Bumped by hand when the shape of a chart payload changes. Every version
	// whose ledger entry was written by an older generator is re-downloaded once.
	generator = 1

	// The schemaVersion stamped into every generated file. The UI refuses to read
	// data it does not know, so bump the output directory (data/v2) alongside it.
	schemaVersion = 1
)

type options struct {
	config       string
	outDir       string
	fullRefresh  bool
	retryMissing bool
	maxNew       int
	jobs         int
	version      bool
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("")

	var opts options
	flag.StringVar(&opts.config, "config", "docs/data/repos.yaml", "repository config to read")
	flag.StringVar(&opts.outDir, "out", "docs/data/v1", "directory to write the generated data to")
	flag.BoolVar(&opts.fullRefresh, "full-refresh", false, "ignore the ledger and rebuild every version")
	flag.BoolVar(&opts.retryMissing, "retry-missing", false, "look again for versions recorded as no longer hosted")
	flag.IntVar(&opts.maxNew, "max-new", 0, "stop after this many downloads, so a bootstrap can be split up")
	flag.IntVar(&opts.jobs, "jobs", 8, "parallel chart downloads")
	flag.BoolVar(&opts.version, "version", false, "print what this build writes and exit")
	flag.Parse()

	if opts.version {
		// Which build produced a data directory, without having to run one.
		fmt.Printf("chart-data generator %d, schema %d\n", generator, schemaVersion)
		return
	}

	if err := run(opts); err != nil {
		log.Fatalf("error: %v", err)
	}
}

func run(opts options) error {
	if opts.jobs < 1 {
		opts.jobs = 1
	}

	config, err := loadConfig(opts.config)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(opts.outDir, "charts"), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(opts.outDir, "versions"), 0o755); err != nil {
		return err
	}

	// ---- one index.yaml read per distinct repository ------------------ //

	repos, err := readRepos(config)
	if err != nil {
		return err
	}

	// ---- what the UI should offer ------------------------------------- //

	candidates, err := buildCandidates(config, repos)
	if err != nil {
		return err
	}
	log.Printf("%d versions offered by the config", len(candidates))

	// ---- the ledger: what has already been processed ------------------- //

	statePath := filepath.Join(opts.outDir, "state.json")
	ledger, err := loadLedger(statePath, opts.fullRefresh)
	if err != nil {
		return err
	}

	todo := pending(candidates, ledger, opts)
	log.Printf("%d already processed, %d to download", len(candidates)-len(todo), len(todo))
	if opts.maxNew > 0 && len(todo) > opts.maxNew {
		todo = todo[:opts.maxNew]
		log.Printf("capping this run at %d downloads", len(todo))
	}

	// ---- download what is missing ------------------------------------- //

	results, failed := download(todo, opts)
	gone := 0
	for _, result := range results {
		if result.missing {
			gone++
		}
	}
	if gone > 0 {
		log.Printf("%d versions are indexed but no longer hosted", gone)
	}
	if failed > 0 {
		log.Printf("warning: %d downloads failed, they will be retried on the next run", failed)
	}

	// ---- merge the ledger --------------------------------------------- //

	for _, result := range results {
		entry := ledgerEntry{Digest: result.digest}
		if result.missing {
			entry.Missing = true
		} else {
			entry.Chart = result.hash
		}
		ledger[result.key] = entry
	}

	// ---- write the generated files ------------------------------------ //

	if err := writeVersionFiles(opts.outDir, config, candidates, ledger); err != nil {
		return err
	}
	if err := writeIndex(opts.outDir, config, candidates, ledger); err != nil {
		return err
	}
	if err := writeState(statePath, ledger); err != nil {
		return err
	}

	removed, payloads, err := pruneOrphans(opts.outDir, ledger)
	if err != nil {
		return err
	}
	if removed > 0 {
		log.Printf("removed %d unreferenced payloads", removed)
	}

	log.Printf("wrote %s: %d versions in the ledger, %d payloads", opts.outDir, len(ledger), payloads)
	return nil
}

// pending picks the versions that still have to be downloaded: the ones the
// ledger has never seen, the ones republished under a new digest, and the ones
// whose payload file has been deleted by hand. Versions the repository indexes
// but no longer hosts stay recorded as missing until --retry-missing asks again.
func pending(candidates []candidate, ledger map[string]ledgerEntry, opts options) []candidate {
	var todo []candidate
	for _, c := range candidates {
		seen, known := ledger[c.key()]
		switch {
		case !known, seen.Digest != c.Digest:
			todo = append(todo, c)
		case seen.Missing:
			if opts.retryMissing {
				todo = append(todo, c)
			}
		default:
			if !payloadExists(opts.outDir, seen.Chart) {
				todo = append(todo, c)
			}
		}
	}
	return todo
}

func payloadExists(outDir, hash string) bool {
	if hash == "" {
		return false
	}
	_, err := os.Stat(payloadPath(outDir, hash))
	return err == nil
}

func payloadPath(outDir, hash string) string {
	return filepath.Join(outDir, "charts", hash+".json")
}

// pruneOrphans deletes payloads no ledger entry points at and counts what is left.
func pruneOrphans(outDir string, ledger map[string]ledgerEntry) (removed, remaining int, err error) {
	referenced := make(map[string]bool, len(ledger))
	for _, entry := range ledger {
		if entry.Chart != "" {
			referenced[entry.Chart] = true
		}
	}

	files, err := filepath.Glob(filepath.Join(outDir, "charts", "*.json"))
	if err != nil {
		return 0, 0, err
	}
	sort.Strings(files)

	for _, file := range files {
		name := filepath.Base(file)
		name = name[:len(name)-len(".json")]
		if referenced[name] {
			remaining++
			continue
		}
		if err := os.Remove(file); err != nil {
			return removed, remaining, err
		}
		removed++
	}
	return removed, remaining, nil
}

func (c candidate) key() string { return fmt.Sprintf("%s/%s", c.Distribution, c.Version) }
