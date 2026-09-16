# The chart data generator, as the image the workflow pulls. Everything it needs
# is in the binary: no helm, yq, jq or awk, so the image is the binary plus the
# CA bundle it needs to reach the chart repositories.
#
#   docker build -t chart-data tools/chart-data
#   docker run --rm -v "$PWD":/work chart-data --config data/repos.yaml

FROM --platform=$BUILDPLATFORM registry.suse.com/bci/golang:1.27 as build

WORKDIR /src

# Dependencies first, so editing the source does not re-download them.
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
  go build -trimpath -ldflags="-s -w" -o /out/chart-data .

FROM registry.suse.com/bci/bci-nano:16.0

LABEL org.opencontainers.image.title="chart-data" \
      org.opencontainers.image.description="Generates the Rancher Helm Playground chart data" \
      org.opencontainers.image.source="https://github.com/tashima42/rancher-helm-playground"

COPY --from=build /out/chart-data /usr/local/bin/chart-data

# The repository is mounted here, so the default arguments resolve the same way
# they do when the binary is run from a checkout.
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/chart-data"]
