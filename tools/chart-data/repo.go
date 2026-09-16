package main

import (
	"fmt"
	"log"
	"net/url"
	"regexp"
	"sort"
	"strings"

	"github.com/Masterminds/semver/v3"
	"go.yaml.in/yaml/v3"
)

// indexFile is the part of a helm repository's index.yaml this tool reads.
type indexFile struct {
	Entries map[string][]indexEntry `yaml:"entries"`
}

type indexEntry struct {
	Version    string   `yaml:"version"`
	AppVersion string   `yaml:"appVersion"`
	Created    string   `yaml:"created"`
	Digest     string   `yaml:"digest"`
	URLs       []string `yaml:"urls"`
}

// repoVersions is one repository's published versions for one chart, in the
// order helm itself would list them: highest semver first.
type repoVersions struct {
	repo     string
	chart    string
	versions []indexEntry
}

// candidate is one (distribution, channel, version) the config selects.
type candidate struct {
	Distribution string
	Channel      string
	Chart        string
	Version      string
	AppVersion   string
	Created      string
	Digest       string
	URL          string
	// Position in helm's own semver ordering. An install without --version
	// resolves to rank 0; head builds are one per commit, so their semver order
	// says nothing about which is newest, hence the separate created ordering.
	Rank int
}

// readRepos fetches one index.yaml per distinct (repository, chart) pair.
func readRepos(config *Config) (map[string]*repoVersions, error) {
	repos := make(map[string]*repoVersions)

	for _, distribution := range config.Distributions {
		chart := config.chartName(distribution)
		for _, channel := range distribution.Channels {
			key := channel.Repo + "\x00" + chart
			if repos[key] != nil {
				continue
			}

			log.Printf("reading %s", channel.Repo)
			versions, err := readIndex(channel.Repo, chart)
			if err != nil {
				return nil, err
			}
			log.Printf("  %d versions", len(versions))
			repos[key] = &repoVersions{repo: channel.Repo, chart: chart, versions: versions}
		}
	}
	return repos, nil
}

func readIndex(repo, chart string) ([]indexEntry, error) {
	body, err := fetch(strings.TrimSuffix(repo, "/") + "/index.yaml")
	if err != nil {
		return nil, fmt.Errorf("%s: %w", repo, err)
	}

	var index indexFile
	if err := yaml.Unmarshal(body, &index); err != nil {
		return nil, fmt.Errorf("%s/index.yaml: %w", repo, err)
	}

	// A repository can hold several charts — the prime repo publishes both
	// rancher and rancher-prime — so take the one that is asked for.
	entries, ok := index.Entries[chart]
	if !ok {
		return nil, fmt.Errorf("%s: no chart named %s", repo, chart)
	}

	sortByVersion(entries)
	return entries, nil
}

// sortByVersion puts the highest semver first, the way helm's own index sorting
// does, so the position of a version is the one helm would resolve from.
func sortByVersion(entries []indexEntry) {
	parsed := make(map[string]*semver.Version, len(entries))
	for _, entry := range entries {
		if version, err := semver.NewVersion(entry.Version); err == nil {
			parsed[entry.Version] = version
		}
	}

	sort.SliceStable(entries, func(i, j int) bool {
		left, right := parsed[entries[i].Version], parsed[entries[j].Version]
		switch {
		case left == nil && right == nil:
			return entries[i].Version > entries[j].Version
		case left == nil:
			return false // unparseable versions sort last, as they do in helm
		case right == nil:
			return true
		default:
			return left.GreaterThan(right)
		}
	})
}

// buildCandidates walks the config and claims every version with the first
// channel whose regex matches it, most recently pushed first.
func buildCandidates(config *Config, repos map[string]*repoVersions) ([]candidate, error) {
	var out []candidate

	for _, distribution := range config.Distributions {
		chart := config.chartName(distribution)
		// A version belongs to one channel per distribution even when two
		// channels share a repository.
		claimed := make(map[string]bool)

		for _, channel := range distribution.Channels {
			match, err := regexp.Compile(channel.Match)
			if err != nil {
				return nil, fmt.Errorf("%s/%s: bad match regex: %w", distribution.ID, channel.ID, err)
			}

			repo := repos[channel.Repo+"\x00"+chart]
			if repo == nil {
				return nil, fmt.Errorf("%s/%s: no index read for %s", distribution.ID, channel.ID, channel.Repo)
			}

			// Rank is the position among the versions this channel matches, in
			// helm's semver order, before the list is reordered by push date.
			var matched []candidate
			for _, entry := range repo.versions {
				if entry.Digest == "" || !match.MatchString(entry.Version) {
					continue
				}
				tarball, err := tarballURL(channel.Repo, entry)
				if err != nil {
					return nil, fmt.Errorf("%s %s: %w", distribution.ID, entry.Version, err)
				}
				matched = append(matched, candidate{
					Distribution: distribution.ID,
					Channel:      channel.ID,
					Chart:        chart,
					Version:      entry.Version,
					AppVersion:   entry.AppVersion,
					Created:      entry.Created,
					Digest:       entry.Digest,
					URL:          tarball,
					Rank:         len(matched),
				})
			}

			// Most recently pushed first. Sorting up and then reversing, rather
			// than sorting down, so versions pushed at the same instant keep the
			// order the previous generator gave them.
			sort.SliceStable(matched, func(i, j int) bool {
				return matched[i].Created < matched[j].Created
			})
			for i, j := 0, len(matched)-1; i < j; i, j = i+1, j-1 {
				matched[i], matched[j] = matched[j], matched[i]
			}

			if channel.Limit > 0 && len(matched) > channel.Limit {
				matched = matched[:channel.Limit]
			}

			for _, c := range matched {
				if claimed[c.Version] {
					continue
				}
				claimed[c.Version] = true
				out = append(out, c)
			}
		}
	}
	return out, nil
}

// tarballURL resolves the chart archive location, which an index may state
// relative to the repository.
func tarballURL(repo string, entry indexEntry) (string, error) {
	if len(entry.URLs) == 0 {
		return "", fmt.Errorf("index lists no url")
	}

	raw := entry.URLs[0]
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("bad url %q: %w", raw, err)
	}
	if parsed.IsAbs() {
		return raw, nil
	}

	base, err := url.Parse(strings.TrimSuffix(repo, "/") + "/")
	if err != nil {
		return "", err
	}
	return base.ResolveReference(parsed).String(), nil
}
