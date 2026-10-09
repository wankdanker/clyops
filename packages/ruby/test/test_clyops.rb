# frozen_string_literal: true

require "minitest/autorun"
require_relative "../lib/clyops"

class ClyopsTest < Minitest::Test
  def make
    cli = Clyops::Cli.new(name: "t", env: {}, cwd: "/work", root: "/root")
    cli.arg "file", "File", "", "path"
    cli.opt "COUNT", "count", "n", "2", "Count", "Options", "int:1-5"
    cli.opt "FAST", "fast", "f", "flag", "Fast"
    cli.opt_array "TAG", "tag", "t", "Tags"
    cli
  end

  def test_parse_returns_typed_values
    cli = make
    assert_equal "ok", cli.parse(["a.txt", "-fn", "4", "-t", "x", "--tag=y"]).status
    assert_equal "/work/a.txt", cli.values.file
    assert_equal 4, cli.values.COUNT
    assert_same true, cli.values.FAST
    assert_equal %w[x y], cli.values["TAG"]
    assert cli.set?("--fast")
    assert_equal "cli", cli.source("count")
    assert_equal "unset", cli.source("nope")
  end

  def test_parse_reports_errors_and_help
    result = make.parse(["a", "--count", "9"])
    assert_equal ["error", "--count must be <= 5, got 9"], [result.status, result.error]
    assert_equal "help", make.parse(["--help"]).status
    assert_equal "Unknown option: --bogus", make.parse(["a", "--bogus"]).error
  end

  def test_run_exits
    err = assert_raises(SystemExit) { capture_io { make.run(["a", "--bogus"]) } }
    assert_equal 1, err.status
  end

  def test_environment_by_variable_name
    cli = Clyops::Cli.new(name: "t", env: { "COUNT" => "3" }).opt("COUNT", "count", "", "1", "Count", "Options", "int")
    cli.parse([])
    assert_equal [3, "env"], [cli.values.COUNT, cli.source("count")]
  end

  def test_registration_errors
    err = assert_raises(Clyops::DefinitionError) { Clyops::Cli.new.opt("A", "a", "", "", "A", "Options", "nope") }
    assert_equal "Unknown validation rule 'nope' for --a", err.message
    assert_raises(Clyops::DefinitionError) { Clyops::Cli.new.arg_variadic("r", "R").arg("x", "X") }
  end

  def test_validate
    assert_same true, Clyops.validate("ON", "bool", "v")
    assert_equal(-2.5, Clyops.validate("-2.5", "float:-3", "v"))
    assert_equal 0.5, Clyops.validate(".5", "float:.1-1", "v")
    err = assert_raises(Clyops::ValidationError) { Clyops.validate("abcd", "string:-3", "--s") }
    assert_equal "--s must be at most 3 characters, got 4", err.message
    # $ must not match before a trailing newline
    assert_raises(Clyops::ValidationError) { Clyops.validate("abc@example.com\n", "email", "e") }
    assert_equal "héllo", Clyops.validate("héllo", "string:5", "s")
    assert_equal "text: >=2 chars", Clyops.describe_rule("string:2-")
  end

  def test_resolve_path
    assert_equal "-", Clyops.resolve_path("-", "/b")
    assert_equal "s3://bucket/key", Clyops.resolve_path("s3://bucket/key", "/b")
    assert_equal "/b/x", Clyops.resolve_path("../x", "/b/c")
    assert_equal "/abs", Clyops.resolve_path("/abs", "/b")
  end

  def test_wrap_text
    assert_equal ["aa bb", "cc", "", "supercalifragilistic", "dd"], Clyops.wrap_text("aa bb cc\n\nsupercalifragilistic dd", 5)
  end

  def test_json
    cli = make
    cli.parse(["a"])
    assert_equal({ "COUNT" => 2, "FAST" => false, "TAG" => [], "HELP" => false, "file" => "/work/a" }, JSON.parse(cli.values_json))
    assert_includes cli.values_json, %("TAG": [],)
    assert_includes cli.json_schema, %("requiredCommands": [])
    assert_nil cli.completion_script("powershell")
  end
end
