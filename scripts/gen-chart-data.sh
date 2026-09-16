#!/usr/bin/env bash
#
# Generates the data the playground UI reads, from what the chart repositories
# in charts/repos.yaml actually publish.
#
# Output (all files carry a "schemaVersion"):
#
#   data/v1/index.json                    distributions, channels, repo URLs
#   data/v1/versions/<dist>-<channel>.json  the version list behind the dropdown
#   data/v1/charts/<hash>.json            values + README options + values schema
#   data/v1/state.json                    ledger of every version ever processed
#
# Chart payloads are content addressed: consecutive releases almost always ship
# an identical values.yaml, so thousands of versions collapse onto a handful of
# files. The ledger records the index digest each version was built from, so a
# version is downloaded exactly once and never looked at again.
#
# The extraction is pure: interpreting an option's type or allowed values is
# left to js/app.js.
#
# Usage: scripts/gen-chart-data.sh [options]
#   --config FILE   repository config       (default charts/repos.yaml)
#   --out DIR       output directory        (default data/v1)
#   --full-refresh  ignore the ledger and rebuild every version
#   --max-new N     stop after N downloads, so a bootstrap can be split up
#   --jobs N        parallel downloads      (default 8)
#
# Requires: helm, yq, jq, awk, curl

set -euo pipefail

# Bumped by hand when the shape of a chart payload changes. Every version whose
# ledger entry was written by an older generator is re-downloaded once.
GENERATOR=1

# The schemaVersion stamped into every generated file. The UI refuses to read
# data it does not know, so bump the output directory (data/v2) alongside it.
SCHEMA_VERSION=1

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"
repo_root="$(cd "$script_dir/.." && pwd)"

log() { printf '%s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  else shasum -a 256 | cut -d' ' -f1
  fi
}

# --------------------------------------------------------------------- #
# Chart payload extraction
# --------------------------------------------------------------------- #

# Reads the README markdown tables under "#### Common Options" and
# "#### Advanced Options" into [{path, defaultRaw, description, section}].
parse_options() {
  awk '
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function unwrap(s) { gsub(/`/, "", s); return trim(s) }
    function esc(s) {
      gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); gsub(/\t/, " ", s); return s
    }

    /^#### Common Options/   { section = "common"; next }
    /^#### Advanced Options/ { section = "advanced"; next }
    /^#/                     { if ($0 !~ /^#### (Common|Advanced) Options/) section = ""; next }

    section == "" { next }
    $0 !~ /^\|/   { next }
    $0 ~ /^\|[ \-|]+\|$/ { next }   # table separator row

    {
      n = split($0, cell, "|")
      if (n < 4) next
      path = unwrap(cell[2])
      if (path == "" || path == "Parameter") next

      # Descriptions may contain pipes; rejoin everything after the default cell.
      desc = cell[4]
      for (i = 5; i < n; i++) desc = desc "|" cell[i]

      printf "%s{\"path\":\"%s\",\"defaultRaw\":\"%s\",\"description\":\"%s\",\"section\":\"%s\"}",
        (count++ ? "," : ""), esc(path), esc(trim(cell[3])), esc(trim(desc)), section
    }

    BEGIN { printf "[" }
    END   { printf "]\n" }
  ' "$1"
}

# Turns the README "Default Value" cell into a real JSON value, or null when the
# cell is prose ("same as chart version") rather than a value.
JQ_PARSE_DEFAULT='
def parse_default:
  (. // "") as $t
  | if   $t == "" or $t == "\" \"" or $t == "\"\"" then ""
    elif $t == "[]"    then []
    elif $t == "{}"    then {}
    elif $t == "true"  then true
    elif $t == "false" then false
    elif ($t | test("^-?[0-9]+$"))  then ($t | tonumber)
    elif ($t | test("^\".*\"$"))    then ($t[1:-1])
    else null
    end;
'

# Flattens values.schema.json into {"path": {type, enum, description}}. This is
# where the allowed values behind the UI dropdowns come from.
JQ_FLATTEN_SCHEMA='
def props($prefix):
  (.properties // {})
  | to_entries
  | map(
      ($prefix + .key) as $path
      | [ { key: $path,
            value: ({ type: .value.type, enum: .value.enum, description: .value.description }
                    | with_entries(select(.value != null))) } ]
        + (.value | props($path + "."))
    )
  | add // [];
[ props("") ] | flatten | map(select(.value | length > 0)) | from_entries
'

# Downloads one chart version and writes its payload, printing
# "<distribution>\t<version>\t<digest>\t<status>\t<payload hash>" to a result
# file. Status is "ok", or "missing" when the repository indexes a version whose
# tarball is gone — a permanent state, so it is recorded rather than retried.
# Any other failure writes nothing and is picked up again on the next run.
#
# Runs as its own process under xargs, so it re-enters this script.
pull_one() {
  local out_dir="$1" work="$2" distribution="$3" version="$4" alias="$5" chart="$6" digest="$7"
  local dir="$work/pull/$distribution/$version"

  record() {
    mkdir -p "$work/results"
    printf '%s\t%s\t%s\t%s\t%s\n' "$distribution" "$version" "$digest" "$1" "${2:-}" \
      > "$work/results/$distribution-$version"
  }

  rm -rf "$dir"
  mkdir -p "$dir"
  local error
  if ! error="$(helm pull "$alias/$chart" --version "$version" --devel \
                  --untar --untardir "$dir" 2>&1)"; then
    if [[ "$error" == *"404 Not Found"* ]]; then
      record missing
      return 0
    fi
    log "$distribution $version: $error"
    return 1
  fi

  local chart_dir="$dir/$chart"
  [ -f "$chart_dir/values.yaml" ] || { log "$distribution $version: no values.yaml"; return 1; }

  local values options schema payload hash
  values="$(yq -o=json '.' "$chart_dir/values.yaml")"
  if [ -f "$chart_dir/README.md" ]; then
    options="$(parse_options "$chart_dir/README.md")"
  else
    options='[]'
  fi
  if [ -f "$chart_dir/values.schema.json" ]; then
    schema="$(jq -c "$JQ_FLATTEN_SCHEMA" "$chart_dir/values.schema.json")"
  else
    schema='{}'
  fi

  payload="$(jq -S -c \
    --argjson schemaVersion "$SCHEMA_VERSION" \
    --argjson values "$values" \
    --argjson options "$options" \
    --argjson schema "$schema" \
    "$JQ_PARSE_DEFAULT"'
     {
       schemaVersion: $schemaVersion,
       values: $values,
       options: ($options | map(. + {default: (.defaultRaw | parse_default)})),
       schema: $schema,
     }' <<<'{}')"

  hash="$(printf '%s' "$payload" | sha256)"
  local file="$out_dir/charts/$hash.json"
  if [ ! -f "$file" ]; then
    mkdir -p "$out_dir/charts"
    printf '%s\n' "$payload" > "$file.$$.tmp"
    mv "$file.$$.tmp" "$file"
  fi

  record ok "$hash"
  rm -rf "$dir"
}

# --------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------- #

main() {
  local config="$repo_root/charts/repos.yaml"
  local out_dir="$repo_root/data/v1"
  local full_refresh=false retry_missing=false max_new=0 jobs=8

  while [ $# -gt 0 ]; do
    case "$1" in
      --config)        config="$2"; shift 2 ;;
      --out)           out_dir="$2"; shift 2 ;;
      --full-refresh)  full_refresh=true; shift ;;
      --retry-missing) retry_missing=true; shift ;;
      --max-new)       max_new="$2"; shift 2 ;;
      --jobs)          jobs="$2"; shift 2 ;;
      -h|--help)      sed -n '3,30p' "${BASH_SOURCE[0]}" >&2; exit 0 ;;
      *)              die "unknown option: $1" ;;
    esac
  done

  for tool in helm yq jq awk curl; do
    command -v "$tool" >/dev/null || die "missing required tool: $tool"
  done
  [ -f "$config" ] || die "config not found: $config"

  # Global, so the EXIT trap can still see it when a helper calls die.
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  mkdir -p "$out_dir/charts" "$out_dir/versions"

  # A throwaway helm home, so a run never touches the caller's repositories.
  export HELM_CACHE_HOME="$work/helm/cache"
  export HELM_CONFIG_HOME="$work/helm/config"
  export HELM_DATA_HOME="$work/helm/data"

  local config_json
  config_json="$(yq -o=json '.' "$config")"
  [ "$(jq -r '.schemaVersion' <<<"$config_json")" = "$SCHEMA_VERSION" ] \
    || die "$config: schemaVersion must be $SCHEMA_VERSION"

  local default_chart
  default_chart="$(jq -r '.chart // "rancher"' <<<"$config_json")"

  # ---- one helm repo per distinct URL ------------------------------- #

  local repos_json
  repos_json="$(jq -c '
    [ .distributions[] as $d
      | $d.channels[]
      | { repo: .repo, chart: ($d.chart // $ARGS.named.defaultChart) } ]
    | unique
    | to_entries
    | map(.value + { alias: "r\(.key)" })
  ' --arg defaultChart "$default_chart" <<<"$config_json")"

  mkdir -p "$work/repos"
  local alias repo chart index_file
  while IFS=$'\t' read -r alias repo chart; do
    log "reading $repo"
    helm repo add "$alias" "$repo" >/dev/null 2>&1 || die "cannot add repo $repo"

    index_file="$HELM_CACHE_HOME/repository/$alias-index.yaml"
    [ -f "$index_file" ] || die "$repo: helm did not cache an index.yaml"

    # helm search orders by semver; index.yaml carries the digest and date.
    CHART="$chart" yq -o=json -I=0 \
      '[.entries[strenv(CHART)][] | {"version": .version, "created": .created, "digest": .digest}]' \
      "$index_file" \
      | jq -c 'INDEX(.version) | map_values({created, digest})' \
      > "$work/repos/$alias.meta.json"

    # A repo can hold several charts (prime publishes rancher and
    # rancher-prime), and helm search matches on substrings, so pick the exact
    # name out of the results.
    helm search repo "$alias/$chart" --versions --devel -o json \
      > "$work/repos/$alias.search.json" 2>/dev/null \
      || die "$repo: no chart named $chart"

    jq -c --slurpfile meta "$work/repos/$alias.meta.json" --arg name "$alias/$chart" '
      [ .[] | select(.name == $name)
            | { version: .version,
                appVersion: .app_version,
                created: ($meta[0][.version].created // null),
                digest:  ($meta[0][.version].digest // null) } ]
    ' "$work/repos/$alias.search.json" > "$work/repos/$alias.json"

    log "  $(jq length "$work/repos/$alias.json") versions"
  done < <(jq -r '.[] | [.alias, .repo, .chart] | @tsv' <<<"$repos_json")

  # ---- what the UI should offer ------------------------------------- #

  # jq reads its input as a stream, so the per-repo lists are collected into one
  # object keyed by alias first.
  local candidates="$work/candidates.json"
  local repo_lists="$work/repo-lists.json"
  {
    printf '{'
    local first=1 a
    while read -r a; do
      [ $first -eq 1 ] || printf ','
      first=0
      printf '"%s":%s' "$a" "$(cat "$work/repos/$a.json")"
    done < <(jq -r '.[].alias' <<<"$repos_json")
    printf '}'
  } > "$repo_lists"

  # Every (distribution, channel, version) the config selects, most recently
  # pushed first, with each version claimed by the first channel whose regex
  # matches it. `rank` keeps helm's own semver order, which is what an install
  # without --version resolves to; head builds are one per commit, so their
  # semver order says nothing about which is newest.
  jq -c \
    --argjson config "$config_json" \
    --argjson repos "$repos_json" \
    --arg defaultChart "$default_chart" '
    def alias_of($url; $chart):
      [ $repos[] | select(.repo == $url and .chart == $chart) ] | first | .alias;

    . as $lists
    | [ $config.distributions[]
        | . as $d
        | (($d.chart // $defaultChart)) as $chart
        | reduce $d.channels[] as $c ({ seen: {}, out: [] };
            alias_of($c.repo; $chart) as $alias
            | [ $lists[$alias][]
                | select(.digest != null)
                | select(.version | test($c.match)) ] as $matched
            | [ $matched | to_entries[] | .value + { rank: .key } ] as $ranked
            | ($ranked | sort_by(.created // "") | reverse) as $ordered
            | (if ($c.limit // 0) > 0 then $ordered[0:$c.limit] else $ordered end) as $picked
            | reduce $picked[] as $v (.;
                if .seen[$v.version] then .
                else .seen[$v.version] = true
                   | .out += [ { distribution: $d.id,
                                 channel: $c.id,
                                 chart: $chart,
                                 alias: $alias,
                                 version: $v.version,
                                 appVersion: $v.appVersion,
                                 created: $v.created,
                                 digest: $v.digest,
                                 rank: $v.rank } ]
                end)
          )
        | .out ]
    | add // []
  ' "$repo_lists" > "$candidates"

  log "$(jq length "$candidates") versions offered by the config"

  # ---- the ledger: what has already been processed ------------------- #

  local state_file="$out_dir/state.json"
  local ledger="$work/ledger.json"
  if [ "$full_refresh" = true ] || [ ! -f "$state_file" ]; then
    echo '{}' > "$ledger"
  else
    jq -c --argjson generator "$GENERATOR" --argjson schemaVersion "$SCHEMA_VERSION" '
      if (.generator == $generator and .schemaVersion == $schemaVersion)
      then (.entries // {}) else {} end
    ' "$state_file" > "$ledger"
  fi

  # Ledger entries whose payload file has been deleted by hand have to be built
  # again; everything else is decided from the ledger alone.
  : > "$work/missing-payload.txt"
  while IFS=$'\t' read -r key hash; do
    [ -f "$out_dir/charts/$hash.json" ] || printf '%s\n' "$key" >> "$work/missing-payload.txt"
  done < <(jq -r 'to_entries[] | select(.value.chart != null) | [.key, .value.chart] | @tsv' "$ledger")

  # A version is downloaded only when the ledger has never seen it, it was
  # republished under a new digest, or it lost the payload it points at.
  # Versions the repository indexes but no longer hosts stay recorded as missing
  # until --retry-missing asks for them again.
  local todo="$work/todo.json"
  jq -c --slurpfile ledger "$ledger" --rawfile missing "$work/missing-payload.txt" \
    --argjson retryMissing "$retry_missing" '
    $ledger[0] as $known
    | ($missing | split("\n") | map(select(length > 0)) | INDEX(.)) as $gone
    | [ .[]
        | "\(.distribution)/\(.version)" as $key
        | $known[$key] as $seen
        | select($seen == null
                 or $seen.digest != .digest
                 or (if $seen.missing == true then $retryMissing else $gone[$key] != null end)) ]
  ' "$candidates" > "$todo"

  local total pending new_count
  total="$(jq length "$candidates")"
  pending="$(jq length "$todo")"
  new_count="$pending"
  log "$((total - pending)) already processed, $pending to download"
  if [ "$max_new" -gt 0 ] && [ "$pending" -gt "$max_new" ]; then
    jq -c --argjson n "$max_new" '.[0:$n]' "$todo" > "$todo.capped"
    mv "$todo.capped" "$todo"
    new_count="$max_new"
    log "capping this run at $new_count downloads"
  fi

  # ---- download what is missing ------------------------------------- #

  mkdir -p "$work/results"
  if [ "$new_count" -gt 0 ]; then
    jq -r '.[] | [.distribution, .version, .alias, .chart, .digest] | @tsv' "$todo" \
      | xargs -P "$jobs" -L1 "$script_path" --pull-one "$out_dir" "$work" \
      || log "warning: some downloads failed, they will be retried on the next run"
  fi

  : > "$work/results.tsv"
  find "$work/results" -type f -exec cat {} + >> "$work/results.tsv"

  local recorded gone_count
  recorded="$(grep -c "$(printf '\tok\t')" "$work/results.tsv" || true)"
  gone_count="$(grep -c "$(printf '\tmissing\t')" "$work/results.tsv" || true)"
  [ "$gone_count" -eq 0 ] || log "$gone_count versions are indexed but no longer hosted"
  [ $((recorded + gone_count)) -eq "$new_count" ] \
    || log "warning: $((new_count - recorded - gone_count)) downloads failed, retried next run"

  # ---- merge the ledger --------------------------------------------- #

  jq -c --slurpfile ledger "$ledger" -R -s '
    ($ledger[0]) as $known
    | ( split("\n") | map(select(length > 0) | split("\t"))
        | map({ key: "\(.[0])/\(.[1])",
                value: (if .[3] == "ok" then { digest: .[2], chart: .[4] }
                        else { digest: .[2], missing: true } end) })
        | from_entries ) as $fresh
    | $known + $fresh
  ' "$work/results.tsv" > "$work/ledger.next"
  mv "$work/ledger.next" "$ledger"

  # ---- write the generated files ------------------------------------ #

  mkdir -p "$out_dir/versions"
  local dist channel
  while IFS=$'\t' read -r dist channel; do
    jq --slurpfile ledger "$ledger" --arg d "$dist" --arg c "$channel" \
      --argjson schemaVersion "$SCHEMA_VERSION" -c '
      $ledger[0] as $known
      | { schemaVersion: $schemaVersion,
          distribution: $d,
          channel: $c,
          versions:
            [ .[]
              | select(.distribution == $d and .channel == $c)
              | . as $v
              | ($known["\($v.distribution)/\($v.version)"]) as $entry
              | select($entry.chart != null)
              | { version: $v.version,
                  appVersion: $v.appVersion,
                  created: $v.created,
                  chart: $entry.chart } ] }
    ' "$candidates" > "$out_dir/versions/$dist-$channel.json"
  done < <(jq -r '.distributions[] | .id as $d | .channels[] | [$d, .id] | @tsv' <<<"$config_json")

  jq -n \
    --argjson config "$config_json" \
    --argjson schemaVersion "$SCHEMA_VERSION" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg defaultChart "$default_chart" \
    --slurpfile candidates "$candidates" \
    --slurpfile ledger "$ledger" '
    $candidates[0] as $all
    | $ledger[0] as $known
    | { schemaVersion: $schemaVersion,
        generatedAt: $generatedAt,
        chart: $defaultChart,
        distributions:
          [ $config.distributions[]
            | . as $d
            | { id: $d.id,
                label: ($d.label // $d.id),
                chart: ($d.chart // $defaultChart),
                channels:
                  [ $d.channels[]
                    | . as $c
                    | ([ $all[]
                         | select(.distribution == $d.id and .channel == $c.id)
                         | select($known["\($d.id)/\(.version)"].chart != null) ]) as $versions
                    | { id: $c.id,
                        label: ($c.label // $c.id),
                        hint: ($c.hint // ""),
                        repo: $c.repo,
                        devel: ($c.devel // false),
                        count: ($versions | length),
                        # What helm installs without --version: the highest
                        # semver, not the most recently pushed.
                        latest: ($versions | min_by(.rank) | .version? // null),
                        versions: "versions/\($d.id)-\($c.id).json" }
                    | select(.count > 0) ] } ] }
  ' > "$out_dir/index.json"

  jq -n \
    --argjson schemaVersion "$SCHEMA_VERSION" \
    --argjson generator "$GENERATOR" \
    --slurpfile ledger "$ledger" \
    '{ schemaVersion: $schemaVersion, generator: $generator, entries: $ledger[0] }' \
    | jq -S . > "$state_file"

  # ---- drop payloads nothing points at ------------------------------- #

  local referenced="$work/referenced.txt"
  jq -r '.entries[].chart | select(. != null)' "$state_file" | sort -u > "$referenced"
  local removed=0 payload name
  for payload in "$out_dir"/charts/*.json; do
    [ -e "$payload" ] || continue
    name="$(basename "$payload" .json)"
    if ! grep -qxF "$name" "$referenced"; then
      rm -f "$payload"
      removed=$((removed + 1))
    fi
  done
  [ "$removed" -eq 0 ] || log "removed $removed unreferenced payloads"

  log "wrote $out_dir: $(jq '.entries | length' "$state_file") versions in the ledger, $(find "$out_dir/charts" -name '*.json' | wc -l | tr -d ' ') payloads"
}

if [ "${1:-}" = "--pull-one" ]; then
  shift
  pull_one "$@"
else
  main "$@"
fi
