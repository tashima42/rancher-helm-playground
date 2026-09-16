# Rancher Helm Playground

The Rancher Helm Playground is a web UI tool to customize Rancher Helm chart values and generate a helm command or values.yaml file to deploy Rancher easily.

It has the following features

* Choose Rancher CE or Prime
* Choose the version type
* Pick a published version from a dropdown, or type one that is not listed
* Search the chart values by name or description
* Choose between a first install and an upgrade with `--reuse-values`
* Pass your values as `--set` flags on the command or as a `values.yaml` file
* Customize the rancher chart values

## Running it locally

The page reads `data/` with `fetch`, which browsers block on `file://`, so it has
to be served over http:

```sh
scripts/serve.sh        # http://localhost:8080
scripts/serve.sh 3000   # or any other port
```

Any static file server works; the script just prefers node and falls back to ruby.

## Where the chart data comes from

Nothing in the UI is hand-maintained. `scripts/gen-chart-data.sh` reads the
repositories listed in `data/repos.yaml`, pulls every chart version they publish
and writes what the page needs into `data/v1/`:

| File | Contents |
| --- | --- |
| `index.json` | distributions, channels, repo URLs and where to find each version list |
| `versions/<distribution>-<channel>.json` | published versions, most recently pushed first |
| `charts/<sha256>.json` | one chart's values, README options and `values.schema.json` |
| `state.json` | the ledger of versions already processed |

Payloads are content addressed, so the versions of a release that ship identical
values share a single file.

Every emitted file carries a `schemaVersion`, and the page refuses data it does
not understand — bump `SCHEMA_VERSION` in the generator and `SUPPORTED_SCHEMA` in
`js/app.js` together when the layout changes.

### Regenerating

```sh
scripts/gen-chart-data.sh                 # only download versions not in the ledger
scripts/gen-chart-data.sh --full-refresh  # ignore the ledger and redo everything
scripts/gen-chart-data.sh --help          # --config, --out, --max-new, --jobs, --retry-missing
```

Versions already in `state.json` are never pulled again, so a normal run only
costs the new ones.

### In CI

`.github/workflows/update-chart-data.yml` runs the generator daily and commits
what changed. It is reusable — call it from another workflow with:

```yaml
jobs:
  charts:
    uses: tashima42/rancher-helm-playground/.github/workflows/update-chart-data.yml@main
```

The work itself lives in the `.github/actions/chart-data` composite action, so it
can also be dropped into an existing job. No LLM is involved anywhere: every value
shown in the UI is extracted from the chart tarballs.
