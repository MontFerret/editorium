SHELL := bash

.PHONY: help extensions prepare build test lint clean package install release proto-sync proto-generate proto-check ci-matrix package-check test-installed

TOOL_DIR := tools/editorium
TOOL := cd $(TOOL_DIR) && go run .
ARGS = $(filter-out $@,$(MAKECMDGOALS))
KNOWN_GOALS := help extensions prepare build test lint clean package install release proto-sync proto-generate proto-check ci-matrix package-check test-installed

help:
	@echo "Editorium monorepo commands:"
	@echo "  make extensions                         List editor integrations"
	@echo "  make prepare [extension ...]            Prepare all or selected integrations"
	@echo "  make build [extension ...]              Build all or selected integrations"
	@echo "  make test [extension ...]               Test tooling/all or selected integrations"
	@echo "  make lint [extension ...]               Lint tooling/all or selected integrations"
	@echo "  make clean [extension ...]              Clean all or selected integration outputs"
	@echo "  make package <extension> [TARGET=id]    Package one integration"
	@echo "  make install <extension> [TARGET=id]    Package and install one integration"
	@echo "  make release <extension> <version>      Validate, tag, and push a release"
	@echo ""
	@echo "Protocol maintenance:"
	@echo "  make proto-sync [FORCE=1]               Synchronize pinned ferretd schemas"
	@echo "  make proto-generate <extension>         Regenerate protocol clients"
	@echo "  make proto-check <extension>            Verify committed protocol clients"

extensions:
	@$(TOOL) extensions $(ARGS)

prepare:
	@FORCE="$(FORCE)" TARGET="$(TARGET)" $(TOOL) run prepare $(ARGS)

build:
	@TARGET="$(TARGET)" $(TOOL) run build $(ARGS)

test:
	@if [[ -z "$(strip $(ARGS))" ]]; then \
		(cd $(TOOL_DIR) && go test ./...); \
	fi
	@TARGET="$(TARGET)" $(TOOL) run test $(ARGS)

lint:
	@if [[ -z "$(strip $(ARGS))" ]]; then \
		unformatted="$$(cd $(TOOL_DIR) && gofmt -l .)"; \
		if [[ -n "$$unformatted" ]]; then echo "Go files are not formatted:" >&2; echo "$$unformatted" >&2; exit 1; fi; \
		(cd $(TOOL_DIR) && go vet ./...); \
	fi
	@TARGET="$(TARGET)" $(TOOL) run lint $(ARGS)

clean:
	@$(TOOL) run clean $(ARGS)

package:
	@TARGET="$(TARGET)" $(TOOL) package $(ARGS)

install:
	@TARGET="$(TARGET)" CODE="$(CODE)" $(TOOL) install $(ARGS)

release:
	@TARGET="$(TARGET)" $(TOOL) release $(ARGS)

proto-sync:
	@FORCE="$(FORCE)" $(TOOL) proto sync $(ARGS)

proto-generate:
	@$(TOOL) proto generate $(ARGS)

proto-check:
	@$(TOOL) proto check $(ARGS)

# Internal CI entrypoints use the same Go adapters as the public Make facade.
ci-matrix:
	@$(TOOL) matrix $(ARGS)

package-check:
	@TARGET="$(TARGET)" $(TOOL) package-check $(ARGS)

test-installed:
	@TARGET="$(TARGET)" $(TOOL) test-installed $(ARGS)

%:
	@if [[ -z "$(filter $(KNOWN_GOALS),$(MAKECMDGOALS))" ]]; then $(TOOL) "$@"; fi
