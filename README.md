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
go build -C tools/chart-data -o "$PWD/chart-data" .

./chart-data                 # only download versions not in the ledger
./chart-data -full-refresh   # ignore the ledger and redo everything
./chart-data -h              # -config, -out, -max-new, -jobs, -retry-missing
```

The default paths are relative, so run it from the root of the checkout.

Versions already in `state.json` are never pulled again, so a normal run only
costs the new ones.

Or through the same image CI uses, which needs nothing but a container runtime:

```sh
docker run --rm -v "$PWD:/work" ghcr.io/tashima42/rancher-helm-playground/chart-data:latest
```

### In CI

The generator ships as `ghcr.io/tashima42/rancher-helm-playground/chart-data`:

| Workflow | Trigger | Tags it publishes |
| --- | --- | --- |
| `release.yml` | a `v*` tag | that exact tag, e.g. `v1.2.0` |
| `publish-chart-data-image.yml` | a push to main touching `tools/chart-data/` | `edge`, `sha-<commit>` |

So cutting a release is `git tag v1.2.0 && git push origin v1.2.0`. No floating
`latest`, `1.2` or `1` tag is published, so an image tag always names one build.

`.github/workflows/update-chart-data.yml` runs the generator daily and commits
what changed. It pulls `edge`; pass `image:` to the action to pin a release
instead. It is reusable — call it from another workflow with:

```yaml
jobs:
  charts:
    uses: tashima42/rancher-helm-playground/.github/workflows/update-chart-data.yml@main
```

The work itself lives in the `.github/actions/chart-data` composite action, so it
can also be dropped into an existing job. No LLM is involved anywhere: every value
shown in the UI is extracted from the chart tarballs.
