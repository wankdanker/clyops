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

  def test_new_registration_errors
    assert_raises(Clyops::DefinitionError) { Clyops::Cli.new(name: "t").set_effects("sideways") }
    err = assert_raises(Clyops::DefinitionError) { Clyops::Cli.new(name: "t").opt("A", "a", "", "flag", "A").exclusive("a", "b") }
    assert_equal "Unknown option --b in constraint", err.message
    err = assert_raises(Clyops::DefinitionError) { Clyops::Cli.new(name: "t").arg("x", "X").command("c", "C") }
    assert_equal "Cannot mix commands and positional arguments", err.message
  end

  def test_secret_values_are_masked
    cli = Clyops::Cli.new(name: "t", env: {})
    cli.opt "TOKEN", "token", "", "", "Token", "Auth", "secret:string:3-"
    assert_equal "ok", cli.parse(["--token", "abcd"]).status
    assert_equal "abcd", cli.values.TOKEN
    assert_equal "***", JSON.parse(cli.values_json)["TOKEN"]
    option = JSON.parse(cli.json_schema)["options"][0]
    assert_equal [true, "string:3-"], [option["secret"], option["validation"]]
  end

  def test_relationships
    make2 = lambda do |env = {}|
      cli = Clyops::Cli.new(name: "t", env: env)
      cli.opt("A", "a", "a", "flag", "A").opt("B", "b", "b", "flag", "B").opt("C", "c", "c", "optional", "C")
      cli.exclusive("a", "b").requires("c", "a").one_of("a", "b", "c")
    end
    assert_equal "Options --a and --b cannot be used together", make2.().parse(["-a", "-b"]).error
    assert_equal "ok", make2.().parse(["-a", "--no-b"]).status
    assert_equal "Option --c requires --a", make2.().parse(["-c", "x"]).error
    assert_equal "ok", make2.({ "A" => "true" }).parse(["-c", "x"]).status
    assert_equal "One of --a, --b, --c is required", make2.().parse([]).error
  end

  def test_commands
    cli = Clyops::Cli.new(name: "m", env: {})
    cli.opt "CONFIG", "config", "c", "optional", "Config", "Global"
    migrate = cli.command("db", "Database").command("migrate", "Migrate")
    migrate.opt "TO", "to", "", "optional", "Target", "Options", "int"
    migrate.arg "name", "Name", "all"
    assert_equal "ok", cli.parse(["db", "-c", "x", "migrate", "--to", "3"]).status
    assert_equal %w[db migrate], cli.command_path
    assert_equal [3, "x", %w[db migrate]], [cli.values.TO, cli.values.CONFIG, cli.values.command]
    assert_equal "Unknown option: --to", cli.parse(["--to", "3", "db", "migrate"]).error
    assert_equal "Missing command", cli.parse(["db"]).error
    assert_equal "Unknown command: seed", cli.parse(%w[db seed]).error
    assert_equal "help", cli.parse(%w[db migrate -h]).status
    assert cli.usage.start_with?("Usage: m db migrate [<name>] [OPTIONS]")
    assert_equal "to", JSON.parse(cli.json_schema)["commands"][0]["commands"][0]["options"][0]["name"]
  end

  def test_fd_registration_errors
    cli = -> { Clyops::Cli.new(name: "t", env: {}) }
    [
      [-> { cli.().fd(2, "out", "X") }, "Invalid file descriptor 2"],
      [-> { cli.().fd(3, "both", "X") }, "Unknown fd direction 'both'"],
      [-> { cli.().fd(3, "out", "X", "", "7") }, "Invalid fd role '7'"],
      [-> { cli.().fd(3, "out", "X").fd(3, "in", "Y") }, "Duplicate file descriptor 3"],
      [-> { cli.().fd(3, "out", "X", "", "log").fd(4, "out", "Y", "", "log") }, "Duplicate fd role 'log'"]
    ].each do |register, message|
      assert_equal message, assert_raises(Clyops::DefinitionError, &register).message
    end
  end

  def test_fd_schema_hash_or_text
    cli = Clyops::Cli.new(name: "t", env: {}).fd(3, "out", "A", "application/json", "meta", { "type" => "object" })
    cli.fd(4, "in", "B", "", "", '{"type":"string"}')
    assert_equal [
      { "fd" => 3, "direction" => "out", "role" => "meta", "description" => "A", "contentType" => "application/json",
        "schema" => { "type" => "object" } },
      { "fd" => 4, "direction" => "in", "role" => "", "description" => "B", "contentType" => "",
        "schema" => { "type" => "string" } }
    ], JSON.parse(cli.json_schema)["fds"]
  end

  def test_fd_emit_only_to_listed_descriptors
    require "tempfile"
    Tempfile.create("clyops-fd") do |file|
      fd = file.fileno
      build = lambda do |listed|
        c = Clyops::Cli.new(name: "t", env: { "CLYOPS_FDS" => listed }).fd(fd, "out", "Progress", "", "progress")
        c.fd(999, "in", "Extra")
        assert_equal "ok", c.parse([]).status
        c
      end
      unlisted = build.("")
      assert_nil unlisted.fd_open("progress")
      unlisted.emit("progress", { "pct" => 1 })
      cli = build.("#{fd}, 999")
      assert_equal fd, cli.fd_open("progress")
      assert_equal fd, cli.fd_open(fd)
      assert_nil cli.fd_open(999)
      cli.emit("progress", { "pct" => 50 })
      cli.emit(fd.to_s, "plain text")
      cli.emit("progress", "ends with newline\n")
      assert_raises(Clyops::DefinitionError) { cli.emit("nope", "x") }
      assert_equal "File descriptor 999 is not an output", assert_raises(Clyops::DefinitionError) { cli.emit(999, "x") }.message
      assert_equal "{\"pct\":50}\nplain text\nends with newline\n", File.read(file.path)
    end
  end

  def test_fd_lookup_follows_the_selected_command
    cli = Clyops::Cli.new(name: "m", env: {}).fd(3, "out", "Progress", "application/x-ndjson", "progress")
    db = cli.command("db", "Database")
    db.command("migrate", "Migrate").fd(4, "out", "Migration progress", "", "progress")
    db.command("status", "Status")
    cli.parse(%w[db status])
    assert_equal 3, cli.send(:find_fd, "progress")["fd"]
    cli.parse(%w[db migrate])
    assert_equal 4, cli.send(:find_fd, "progress")["fd"]
    assert_includes cli.usage, "\nOutput fd 4 [progress]: Migration progress\n"
    refute_includes cli.usage, "fd 3"
  end
end
