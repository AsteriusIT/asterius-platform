GO ?= go
# Use the Go toolchain installed (go.mod: go 1.24), do not download another one.
export GOTOOLCHAIN ?= local

.PHONY: build install test testacc testacc-local examples-e2e vet fmt docs docs-check release-snapshot

build:
	$(GO) build -o bin/terraform-provider-asterius .

# Installs into GOBIN; use it with a dev_overrides block (see README.md).
install:
	$(GO) install .

vet:
	$(GO) vet ./...
	@test -z "$$(gofmt -l .)" || (echo "gofmt needed:"; gofmt -l .; exit 1)
	terraform fmt -check -recursive examples

fmt:
	gofmt -w .

# Unit tests: no server (an in-process fake API); the lifecycle tests need the terraform CLI in PATH.
test:
	$(GO) test ./... -count=1

# Acceptance tests against ASTERIUS_ENDPOINT / ASTERIUS_TOKEN (a real server).
testacc:
	TF_ACC=1 $(GO) test ./... -count=1 -v -run '^TestAcc' -timeout 30m

# Starts a throwaway server (scripts/local-server.sh), runs the acceptance tests and the examples with the CLI
# (scripts/examples-e2e.sh), stops it.
testacc-local:
	@set -e; env_file=$$(mktemp); trap 'scripts/local-server.sh stop; rm -f $$env_file' EXIT; \
	  scripts/local-server.sh start > $$env_file; . $$env_file; \
	  TF_ACC=1 $(GO) test ./... -count=1 -v -run '^TestAcc' -timeout 30m; \
	  scripts/examples-e2e.sh

# The examples, applied / imported / destroyed with the CLI against ASTERIUS_ENDPOINT (TF=tofu for OpenTofu).
examples-e2e:
	scripts/examples-e2e.sh

# docs/ is generated from the provider schema and examples/ (`make docs-check` fails when it is stale).
docs:
	$(GO) run ./tools/gendocs

docs-check:
	$(GO) run ./tools/gendocs -check

release-snapshot:
	goreleaser release --snapshot --clean --skip=sign
