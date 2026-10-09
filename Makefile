# clyops monorepo. `make` builds everything, `make check` runs every test.
#
#   make build           build all packages
#   make test            unit tests for every package
#   make conformance     shared spec suite against every implementation
#   make completions     generated completion files are in sync + real-shell tests
#   make lint            linters/formatters (where installed)
#   make check           all of the above
#   make <lang>          build + unit tests + conformance for one package (js bash python rust c go ruby java)
#   make dispatch        build + test clyops-dispatch
#   (js builds and tests every npm workspace)

IMPLS := js ts cjs-bundle bash python rust c go ruby java

.PHONY: all build test conformance completions bundles lint check clean js bash python rust c go ruby java dispatch \
        build-js build-rust build-c build-go build-java build-dispatch \
        test-js test-bash test-python test-rust test-c test-go test-ruby test-java test-dispatch

all: build

build: build-js build-rust build-c build-go build-java build-dispatch

node_modules:
	npm ci

build-js: node_modules
	npm run build --workspaces

build-rust:
	cd packages/rust && cargo build --examples

build-c:
	$(MAKE) -C packages/c

build-go:
	cd packages/go && go build -o build/demo ./examples/demo && go build -o build/tasks ./examples/tasks

build-java:
	cd packages/java && mvn -q -B package -DskipTests \
	  && javac -Xlint:all,-serial -Werror -cp target/classes -d target/examples examples/Demo.java examples/Tasks.java

build-dispatch:
	cd apps/dispatch && cargo build

test: test-js test-bash test-python test-rust test-c test-go test-ruby test-java test-dispatch

test-js: build-js
	npm test --workspaces

test-bash:
	bash packages/bash/test/test.sh

test-python:
	cd packages/python && python3 -m unittest discover -s tests

test-rust:
	cd packages/rust && cargo test

test-c: build-c
	$(MAKE) -C packages/c test

test-go:
	cd packages/go && go test ./...

test-ruby:
	cd packages/ruby && ruby -w test/test_clyops.rb

test-java:
	cd packages/java && mvn -q -B test

test-dispatch:
	cd apps/dispatch && cargo test

conformance: build
	python3 tools/conformance.py $(IMPLS)

completions: build
	python3 tools/sync-completions.py --check
	@for impl in $(IMPLS); do tools/test-completions.sh $$impl || exit 1; done

# Rebuild the committed single-file CommonJS bundles (packages/*/clyops*.cjs).
bundles: node_modules
	node tools/bundle-js.mjs

lint: build-js
	python3 tools/sync-completions.py --check
	node tools/bundle-js.mjs --check
	python3 tools/check-schema.py
	npm run typecheck --workspaces
	cd packages/python && ruff check src tests examples && mypy src
	cd packages/rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings
	cd apps/dispatch && cargo fmt --check && cargo clippy --all-targets -- -D warnings
	cd packages/go && test -z "$$(gofmt -l .)" && go vet ./...
	@if command -v shellcheck >/dev/null; then shellcheck -S warning packages/bash/clyops.sh packages/bash/examples/demo.sh packages/bash/examples/tasks.sh packages/bash/test/test.sh tools/*.sh; fi

check: lint test conformance completions

js: test-js
	python3 tools/conformance.py js ts cjs-bundle

bash: test-bash
	python3 tools/conformance.py bash

python: test-python
	python3 tools/conformance.py python

rust: test-rust build-rust
	python3 tools/conformance.py rust

c: test-c
	python3 tools/conformance.py c

go: test-go build-go
	python3 tools/conformance.py go

ruby: test-ruby
	python3 tools/conformance.py ruby

java: test-java build-java
	python3 tools/conformance.py java

dispatch: build-dispatch test-dispatch

clean:
	rm -rf packages/*/dist apps/*/dist
	cd packages/rust && cargo clean
	cd apps/dispatch && cargo clean
	$(MAKE) -C packages/c clean
	rm -rf packages/go/build packages/java/target
