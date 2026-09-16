# Everything here is optional: the site is static and the generator is one Go
# program. `make help` lists the targets.

GO      ?= go
DOCKER  ?= docker
TOOL    := tools/chart-data
BINARY  := chart-data
IMAGE   ?= chart-data:local
OUT_DIR ?= docs/data/v1
CONFIG  ?= docs/data/repos.yaml
PORT    ?= 8080

.PHONY: help
help: ## List the targets
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
		awk -F':.*?## ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: build
build: ## Build the generator into ./chart-data
	$(GO) build -C $(TOOL) -trimpath -o "$(CURDIR)/$(BINARY)" .

.PHONY: test
test: ## Run the generator's tests
	$(GO) test -C $(TOOL) ./...

.PHONY: vet
vet: ## Vet the generator and check its formatting
	$(GO) vet -C $(TOOL) ./...
	@unformatted=$$(gofmt -l $(TOOL)); \
	if [ -n "$$unformatted" ]; then echo "gofmt needed:"; echo "$$unformatted"; exit 1; fi

.PHONY: generate
generate: build ## Refresh docs/data from the chart repositories
	./$(BINARY) -config $(CONFIG) -out $(OUT_DIR)

.PHONY: image
image: ## Build the generator image locally
	$(DOCKER) build -t $(IMAGE) $(TOOL)

.PHONY: image-push
image-push: image ## Push the image (set IMAGE to the registry path)
	$(DOCKER) push $(IMAGE)

.PHONY: image-run
image-run: image ## Refresh docs/data by running the local image
	$(DOCKER) run --rm \
		--user "$$(id -u):$$(id -g)" \
		--volume "$(CURDIR):/work" \
		--workdir /work \
		$(IMAGE) -config $(CONFIG) -out $(OUT_DIR)

.PHONY: serve
serve: ## Serve docs/ on localhost (override PORT)
	scripts/serve.sh $(PORT)

.PHONY: lint
lint: ## Lint the workflows with actionlint and zizmor
	$(DOCKER) run --rm --volume "$(CURDIR):/repo" --workdir /repo rhysd/actionlint:latest -color
	zizmor --persona pedantic .github

.PHONY: clean
clean: ## Remove the built binary
	rm -f $(BINARY)
