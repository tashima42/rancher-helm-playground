# Rancher Helm Playground

The Rancher Helm Playground is a web UI tool to customize Rancher Helm chart values and generate a helm command or values.yaml file to deploy Rancher easily.

It has the following features

* Choose Rancher CE or Prime
* Choose the version type
* Pick a published version from a dropdown, or type one that is not listed
* Search the chart values by name or description
* Choose between a first install and an upgrade, with `--reset-then-reuse-values`
  or `--reuse-values`
* Pass your values as `--set` flags on the command or as a `values.yaml` file
* Customize the rancher chart values
* Add any number of extra environment variables for the Rancher deployment
* Share the whole configuration as a link

## Playground defaults

A few values start off different from what the chart ships, because they are
what a Rancher install usually wants. Today that is `agentTLSMode=system-store`.
They behave like any other change — the field is marked, it can be edited back,
and a chart version without that value ignores it — so the only difference is
where the page starts.

They live in `PLAYGROUND_DEFAULTS` at the top of `docs/js/app.js`; add a path
and the string it should start at.

## Extra environment variables

`extraEnv` gets its own editor instead of the raw-YAML box a list would
otherwise get, because the pairs are addressed by position on the command line:

```sh
--set-string 'extraEnv[0].name=CATTLE_AGENT_IMAGE' \
  --set-string 'extraEnv[0].value=stgregistry.suse.com/rancher/rancher-agent:v2.15.2-ab15f61-head'
```

`--set-string` rather than `--set`, so a value that looks like a number reaches
the pod spec as the string an environment variable has to be. In `values.yaml`
mode the same pairs are written as a list instead.

## The site

The whole site lives in `docs/`, which is what GitHub Pages is pointed at
(Settings → Pages → deploy from a branch → `main` / `/docs`):

```
docs/index.html   the page
docs/css/         its styles
docs/js/app.js    all of the behaviour, no build step and no dependencies
docs/data/        the generated chart data, plus the one file that is not
```

## Running it locally

The page reads `data/` with `fetch`, which browsers block on `file://`, so it has
to be served over http:

```sh
scripts/serve.sh        # http://localhost:8080
scripts/serve.sh 3000   # or any other port
```

The server is rooted at `docs/`, the same as Pages. Any static file server
works; the script just prefers node and falls back to ruby.

## Where the chart data comes from

Nothing in the UI is hand-maintained. The generator in `tools/chart-data` reads
the repositories listed in `docs/data/repos.yaml`, pulls every chart version
they publish and writes what the page needs into `docs/data/v1/`:

| File | Contents |
| --- | --- |
| `index.json` | distributions, channels, repo URLs and where to find each version list |
| `versions/<distribution>-<channel>.json` | published versions, most recently pushed first |
| `charts/<sha256>.json` | one chart's values, README options and `values.schema.json` |
| `state.json` | the ledger of versions already processed |

Payloads are content addressed, so the versions of a release that ship identical
values share a single file.

Every emitted file carries a `schemaVersion`, and the page refuses data it does
not understand — bump `schemaVersion` in `tools/chart-data/main.go` and
`SUPPORTED_SCHEMA` in `docs/js/app.js` together when the layout changes.

### Regenerating

The generator is a single Go program with no runtime dependencies — it fetches
`index.yaml` and the chart archives itself, so there is no helm, yq or jq to
install:

```sh
make generate   # builds ./chart-data and refreshes docs/data
make image-run  # the same, through the container image
```

Or drive the binary yourself, from the root of the checkout because the default
paths are relative:

```sh
make build
./chart-data                 # only download versions not in the ledger
./chart-data -full-refresh   # ignore the ledger and redo everything
./chart-data -h              # -config, -out, -max-new, -jobs, -retry-missing
```

Versions already in `state.json` are never pulled again, so a normal run only
costs the new ones.

`make help` lists the rest: `test`, `vet`, `image`, `image-push`, `serve` and
`lint` (actionlint and zizmor over `.github/`).

### In CI

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `pull-request.yml` | a pull request | `make vet`, `make test`, and `make image` to prove the build |
| `release.yml` | a `v*` tag | `make image-push` to `ghcr.io/tashima42/rancher-helm-playground/chart-data:<tag>` |
| `update-chart-data.yml` | daily, or called | runs the published image and commits what changed |
| `zizmor.yml` | push and pull request | audits the workflows themselves |

CI builds the image with the same `make` targets a laptop does. Only the exact
tag pushed is published — no `latest`, `1.2` or `1` — so an image tag always
names one build, and the update workflow pins the one it runs.

`update-chart-data.yml` is reusable — call it from another workflow with:

```yaml
jobs:
  charts:
    uses: tashima42/rancher-helm-playground/.github/workflows/update-chart-data.yml@main
```

The work itself lives in the `.github/actions/chart-data` composite action, so it
can also be dropped into an existing job. No LLM is involved anywhere: every value
shown in the UI is extracted from the chart tarballs.
