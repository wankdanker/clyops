# clyops monorepo. `make` builds everything, `make check` runs every test.
#
#   make build           build all packages
#   make test            unit tests for every package
#   make conformance     shared spec suite against every implementation
#   make completions     generated completion files are in sync + real-shell tests
#   make lint            linters/formatters (where installed)
#   make check           all of the above
#   make <lang>          build + unit tests + conformance for one package (js bash python rust c)

IMPLS := js ts bash python rust c

.PHONY: all build test conformance completions lint check clean js bash python rust c \
        build-js build-rust build-c test-js test-bash test-python test-rust test-c

all: build

build: build-js build-rust build-c

build-js:
	cd packages/js && ( [ -d node_modules ] || npm ci ) && npm run build

build-rust:
	cd packages/rust && cargo build --examples

build-c:
	$(MAKE) -C packages/c

test: test-js test-bash test-python test-rust test-c

test-js: build-js
	cd packages/js && npm test

test-bash:
	bash packages/bash/test/test.sh

test-python:
	cd packages/python && python3 -m unittest discover -s tests

test-rust:
	cd packages/rust && cargo test

test-c: build-c
	$(MAKE) -C packages/c test

conformance: build
	python3 tools/conformance.py $(IMPLS)

completions: build
	python3 tools/sync-completions.py --check
	@for impl in $(IMPLS); do tools/test-completions.sh $$impl || exit 1; done

lint:
	python3 tools/sync-completions.py --check
	python3 tools/check-schema.py
	cd packages/js && npm run typecheck
	cd packages/python && ruff check src tests examples && mypy src
	cd packages/rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings
	@if command -v shellcheck >/dev/null; then shellcheck -S warning packages/bash/clyops.sh packages/bash/examples/demo.sh packages/bash/test/test.sh tools/*.sh; fi

check: lint test conformance completions

js: test-js
	python3 tools/conformance.py js ts

bash: test-bash
	python3 tools/conformance.py bash

python: test-python
	python3 tools/conformance.py python

rust: test-rust build-rust
	python3 tools/conformance.py rust

c: test-c
	python3 tools/conformance.py c

clean:
	cd packages/js && rm -rf dist
	cd packages/rust && cargo clean
	$(MAKE) -C packages/c clean
