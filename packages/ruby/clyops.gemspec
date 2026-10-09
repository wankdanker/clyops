# frozen_string_literal: true

require_relative "lib/clyops"

Gem::Specification.new do |s|
  s.name = "clyops"
  s.version = Clyops::VERSION
  s.summary = "One-line-per-option CLI parsing: validation, help text, JSON schema, config files and completion."
  s.description = "Declarative CLI parsing with the same behavior as the clyops packages for Bash, JavaScript, " \
                  "Python, Rust, C, Go and Java: typed validation, generated help, --help-json-schema, config " \
                  "files, environment variables, logging and bash/zsh/fish completion."
  s.authors = ["clyops contributors"]
  s.license = "MIT"
  s.homepage = "https://github.com/wankdanker/clyops"
  s.metadata = { "source_code_uri" => "https://github.com/wankdanker/clyops/tree/main/packages/ruby",
                 "rubygems_mfa_required" => "true" }
  s.required_ruby_version = ">= 3.1"
  s.files = Dir["lib/**/*.rb"] + ["README.md"]
end
