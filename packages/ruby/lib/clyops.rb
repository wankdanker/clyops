# frozen_string_literal: true

# clyops: declarative, one-line-per-option CLI parsing for Ruby. Behavior
# follows spec/SPEC.md in https://github.com/wankdanker/clyops.
#
#   require "clyops"
#
#   cli = Clyops::Cli.new
#   cli.arg "input", "Input file", "", "path"
#   cli.opt "PORT", "port", "p", "8080", "Server port", "Network", "port"
#   cli.opt "VERBOSE", "verbose", "v", "flag", "Verbose output"
#   args = cli.run
#   puts args.input, args.PORT, args.VERBOSE

require "json"
require "pathname"
require_relative "clyops/completions"

module Clyops
  VERSION = "0.1.0"

  # -------------------------------------------------------------------------
  # Logging
  # -------------------------------------------------------------------------

  COLORS = { "info" => "\e[1;37m", "warning" => "\e[0;33m", "error" => "\e[0;31m", "success" => "\e[0;32m" }.freeze
  @silent = ENV["CLYOPS_SILENT"] == "true"

  class << self
    # Suppress info/warn/error/success output (die and parse errors still print).
    attr_writer :silent

    def emit(level, msg, force: false)
      return if @silent && !force

      tag = $stderr.tty? && !ENV["NO_COLOR"] ? "#{COLORS[level]}#{level}\e[0m" : level
      $stderr.write("#{Time.now.strftime('%Y-%m-%d %H:%M:%S')} [#{tag}] #{msg}\n")
    end

    def info(msg) = emit("info", msg)
    def warn(msg) = emit("warning", msg)
    def error(msg) = emit("error", msg)
    def success(msg) = emit("success", msg)

    # Print an error and exit with `code`. Never suppressed.
    def die(code, msg)
      emit("error", msg, force: true)
      exit(code)
    end
  end

  # -------------------------------------------------------------------------
  # Rules
  # -------------------------------------------------------------------------

  FIXED_RULES = {
    "int" => "integer", "float" => "number", "string" => "text", "path" => "path", "ip" => "IP address",
    "hostname" => "hostname", "url" => "URL", "port" => "port: 1-65535", "email" => "email address", "uuid" => "UUID",
    "bool" => "true/false, yes/no, 1/0, on/off", "date:YYYY-MM-DD" => "date: YYYY-MM-DD",
    "file:exists" => "existing file", "file:readable" => "readable file", "file:writable" => "writable file",
    "dir:exists" => "existing directory", "dir:writable" => "writable directory"
  }.freeze
  HOSTNAME = /\A[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\z/

  # A ValueError-like error carrying the spec's message for a value that fails its rule.
  class ValidationError < StandardError; end

  # Raised for a programming error in the registration (unknown rule, duplicate option).
  class DefinitionError < StandardError; end

  module_function

  def bool_word(value)
    case value.downcase
    when "true", "yes", "1", "on" then true
    when "false", "no", "0", "off" then false
    end
  end

  def known_rule?(rule)
    return true if rule.empty? || FIXED_RULES.key?(rule)
    return true if rule.match?(/\Aint:(\d+-\d*|-\d+)\z/) || rule.match?(/\Afloat:(\d*\.?\d+-(\d*\.?\d+)?|-\d*\.?\d+)\z/)
    return true if rule.match?(/\Astring:(\d+|\d+-\d*|-\d+)\z/) || rule.match?(/\Achoice:.+\z/m)

    if rule.start_with?("regex:") && rule.length > 6
      begin
        Regexp.new(rule[6..])
        return true
      rescue RegexpError
        return false
      end
    end
    false
  end

  def bounds(rule)
    lo, _, hi = rule.split(":", 2)[1].partition("-")
    [lo, hi]
  end

  def path_rule?(rule)
    rule == "path" || rule.start_with?("file:", "dir:")
  end

  # Help text for a validation rule (spec section 5).
  def describe_rule(rule)
    return FIXED_RULES[rule] if FIXED_RULES.key?(rule)

    [["int:", "integer", ""], ["float:", "number", ""], ["string:", "text", " chars"]].each do |prefix, noun, suffix|
      next unless rule.start_with?(prefix)
      return "#{noun}: #{rule[prefix.length..]}#{suffix}" unless rule.include?("-")

      lo, hi = bounds(rule)
      return "#{noun}: #{lo}-#{hi}#{suffix}" if !lo.empty? && !hi.empty?
      return lo.empty? ? "#{noun}: <=#{hi}#{suffix}" : "#{noun}: >=#{lo}#{suffix}"
    end
    return "choices: #{rule[7..].split(',', -1).join(', ')}" if rule.start_with?("choice:")
    return "pattern: #{rule[6..]}" if rule.start_with?("regex:")

    rule
  end

  # Validate `value` against `rule` and return its typed form; raises
  # ValidationError with the spec's error text.
  def validate(value, rule, name)
    fail_with = ->(msg) { raise ValidationError, "#{name} #{msg}" }
    check_bounds = lambda do |num|
      lo, hi = bounds(rule)
      fail_with.("must be >= #{lo}, got #{value}") if !lo.empty? && num < lo.to_f
      fail_with.("must be <= #{hi}, got #{value}") if !hi.empty? && num > hi.to_f
    end

    if rule == "int" || rule.start_with?("int:")
      fail_with.("must be an integer, got '#{value}'") unless value.match?(/\A-?[0-9]+\z/)
      num = Integer(value, 10)
      check_bounds.(num) unless rule == "int"
      return num
    end
    if rule == "float" || rule.start_with?("float:")
      fail_with.("must be a number, got '#{value}'") unless value.match?(/\A-?[0-9]*\.?[0-9]+\z/)
      num = Float(value.sub(/\A(-?)\./, '\10.'))
      check_bounds.(num) unless rule == "float"
      return num
    end
    if rule.start_with?("string:")
      length = value.length
      if rule.include?("-")
        lo, hi = bounds(rule)
        fail_with.("must be at least #{lo} characters, got #{length}") if !lo.empty? && length < lo.to_i
        fail_with.("must be at most #{hi} characters, got #{length}") if !hi.empty? && length > hi.to_i
      elsif length != rule[7..].to_i
        fail_with.("must be exactly #{rule[7..]} characters, got #{length}")
      end
      return value
    end
    if rule.start_with?("choice:")
      choices = rule[7..].split(",", -1)
      fail_with.("must be one of: #{choices.join(', ')}, got '#{value}'") unless choices.include?(value)
      return value
    end
    if rule.start_with?("regex:")
      fail_with.("does not match required pattern, got '#{value}'") unless value.match?(Regexp.new(rule[6..]))
      return value
    end

    case rule
    when "bool"
      b = bool_word(value)
      fail_with.("must be a boolean (true/false, yes/no, 1/0, on/off), got '#{value}'") if b.nil?
      return b
    when "port"
      unless value.match?(/\A[0-9]+\z/) && (1..65_535).cover?(value.to_i)
        fail_with.("must be a valid port (1-65535), got '#{value}'")
      end
      return value.to_i
    when "ip"
      unless value.match?(/\A([0-9]{1,3}\.){3}[0-9]{1,3}\z/) || value.match?(/\A([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}\z/)
        fail_with.("must be a valid IP address, got '#{value}'")
      end
    when "hostname"
      fail_with.("must be a valid hostname, got '#{value}'") unless value.match?(HOSTNAME)
    when "url"
      fail_with.("must be a valid URL, got '#{value}'") unless value.match?(%r{\Ahttps?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?\z}m)
    when "email"
      fail_with.("must be a valid email address, got '#{value}'") unless value.match?(/\A[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\z/)
    when "uuid"
      unless value.match?(/\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\z/)
        fail_with.("must be a valid UUID, got '#{value}'")
      end
    when "date:YYYY-MM-DD"
      fail_with.("must be in YYYY-MM-DD format, got '#{value}'") unless value.match?(/\A[0-9]{4}-[0-9]{2}-[0-9]{2}\z/)
    when "file:exists"
      fail_with.("file does not exist: #{value}") unless File.file?(value)
    when "file:readable"
      fail_with.("file is not readable: #{value}") unless File.readable?(value)
    when "file:writable"
      if File.exist?(value) || File.symlink?(value)
        fail_with.("file is not writable: #{value}") unless File.writable?(value)
      else
        dir = File.dirname(value)
        fail_with.("directory is not writable: #{dir}") unless File.directory?(dir) && File.writable?(dir)
      end
    when "dir:exists"
      fail_with.("directory does not exist: #{value}") unless File.directory?(value)
    when "dir:writable"
      fail_with.("directory does not exist or is not writable: #{value}") unless File.directory?(value) && File.writable?(value)
    end
    value
  end

  # Join and normalize like Python's os.path.normpath(os.path.join(...)): an
  # absolute `value` replaces `base`.
  def normpath(base, value)
    Pathname.new(base).join(value).cleanpath.to_s
  end

  # Resolve a path value against `base` (spec section 6).
  def resolve_path(value, base, search_dirs = [])
    return value if value.empty? || %w[- disabled optional].include?(value)
    return value if value.start_with?("/") || value.match?(/\A[A-Za-z][A-Za-z0-9+.-]+:/)

    from_base = normpath(base, value)
    if !value.match?(%r{\A\.\.?(/|\z)}) && !search_dirs.empty? && !File.exist?(from_base)
      search_dirs.each do |dir|
        candidate = normpath(dir, value)
        return candidate if File.exist?(candidate)
      end
    end
    from_base
  end

  # Greedy word wrap that keeps existing line breaks (spec section 7).
  def wrap_text(text, width)
    text.split(/\r?\n/, -1).flat_map do |original|
      words = original.split
      next [""] if words.empty?

      out = []
      line = +""
      words.each do |word|
        if line.empty?
          line = +word
        elsif line.length + 1 + word.length <= width
          line << " " << word
        else
          out << line
          line = +word
        end
      end
      out << line
    end
  end

  # JSON with two-space indents and empty arrays and objects written as
  # [] and {}, whatever the json gem version. A raw newline only appears
  # between JSON tokens (in strings it is escaped), so this can't touch values.
  def pretty_json(value)
    JSON.pretty_generate(value).gsub(/\[\n\s*\]/, "[]").gsub(/\{\n\s*\}/, "{}")
  end

  def completion_kind(rule, search_dirs)
    return ["file", search_dirs.join(":")] if rule == "path" || rule.start_with?("file:")
    return ["dir", search_dirs.join(":")] if rule.start_with?("dir:")
    return ["choice", rule[7..]] if rule.start_with?("choice:")
    return ["choice", "true,false"] if rule == "bool"
    return ["host", ""] if %w[hostname ip].include?(rule)

    rule.empty? ? ["default", ""] : ["none", ""]
  end

  # -------------------------------------------------------------------------
  # Cli
  # -------------------------------------------------------------------------

  Option = Struct.new(:var, :long, :short, :kind, :default, :required, :description, :group, :rule, :search_dirs) do
    def label
      head = short.empty? ? "    --#{long}" : "-#{short}, --#{long}"
      kind == "flag" ? head : "#{head}=<value>"
    end

    def bool_like?
      kind == "flag" || %w[bool choice:true,false choice:false,true].include?(rule)
    end
  end

  Arg = Struct.new(:name, :description, :default, :rule, :variadic)

  # status is "ok", "help" or "error".
  ParseResult = Struct.new(:status, :error, :show_usage, :detail) do
    def initialize(status, error = "", show_usage = true, detail = []) = super
  end

  # Resolved values: keys are option vars and argument names, also readable as methods (args.PORT).
  class Values < Hash
    def method_missing(name, *args)
      key = name.to_s
      return self[key] if args.empty? && key?(key)

      super
    end

    def respond_to_missing?(name, include_private = false) = key?(name.to_s) || super
  end

  class ParseError < StandardError; end
  private_constant :ParseError

  # A program's command-line interface. Register options and arguments, then call run (or parse).
  class Cli
    attr_accessor :name
    attr_reader :values, :cwd, :root, :env

    def initialize(name: nil, root: nil, cwd: nil, env: nil)
      @name = name || File.basename($PROGRAM_NAME || "cli")
      @cwd = cwd || Dir.pwd
      @root = Clyops.normpath(@cwd, root.to_s.empty? ? "." : root)
      @env = env || ENV.to_h
      @description = ""
      @epilog = ""
      @values = Values.new
      @options = []
      @by_long = {}
      @by_short = {}
      @args = []
      @commands = []
      @config_option = ""
      @config_prefixes = []
      @raw = {}
      @arg_raw = {}
      @sources = {}
      @config = {} # key -> [value, dir]
    end

    # -- registration -------------------------------------------------------

    def set_description(text) = tap { @description = text }
    def set_epilog(text) = tap { @epilog = text }

    # `option` holds the config file path; `prefixes` is comma-separated.
    def set_config(option, prefixes)
      @config_option = option
      @config_prefixes = prefixes.split(",").map(&:strip).reject(&:empty?)
      self
    end

    def require_command(command, description, install_hint = "")
      @commands << [command, description, install_hint]
      self
    end

    # Fallback dirs (colon-separated, relative to root) for bare relative values of a path option.
    def set_path_search(long, dirs)
      opt = @by_long.fetch(long)
      items = dirs.is_a?(String) ? dirs.split(":") : dirs
      opt.search_dirs = items.reject(&:empty?).map { |d| Clyops.normpath(@root, d) }
      opt.rule = "path" if opt.rule.empty?
      self
    end

    # Register an option. `default` is a value, "flag", "optional", or "" (required).
    def opt(var, long, short = "", default = "", description = "", group = "Options", rule = "")
      kind = default == "flag" ? "flag" : "value"
      value = %w[flag optional].include?(default) ? "" : default
      add(Option.new(var, long, short, kind, value, default == "", description, group, rule, []))
    end

    # Register a repeatable option whose values accumulate into a list.
    def opt_array(var, long, short = "", description = "", group = "Options", rule = "")
      add(Option.new(var, long, short, "array", "", false, description, group, rule, []))
    end

    # Register a positional argument. An empty default makes it required.
    def arg(name, description = "", default = "", rule = "")
      add_arg(Arg.new(name, description, default, rule, false))
    end

    # Register a final positional argument that collects all remaining tokens.
    def arg_variadic(name, description = "", rule = "")
      add_arg(Arg.new(name, description, "", rule, true))
    end

    # -- parsing ------------------------------------------------------------

    # Parse without exiting. Values are in `values` when status is "ok".
    def parse(argv = ARGV)
      @raw = {}
      @arg_raw = {}
      @sources = {}
      @config = {}
      @values = Values.new
      ensure_help

      scan_error = nil
      begin
        scan(argv.to_a)
        load_config unless @config_option.empty?
      rescue ParseError => e
        scan_error = e.message
      end
      return ParseResult.new("help") if @raw["help"] == "true"
      return ParseResult.new("error", scan_error) if scan_error

      begin
        resolve
      rescue ParseError, ValidationError => e
        return ParseResult.new("error", e.message)
      end

      missing_cmds = @commands.reject { |c| which(c[0]) }
      unless missing_cmds.empty?
        detail = missing_cmds.flat_map do |cmd, desc, hint|
          ["  #{cmd} - #{desc}"] + (hint.empty? ? [] : ["    Install: #{hint}"])
        end
        return ParseResult.new("error", "Missing required command(s): #{missing_cmds.map(&:first).join(', ')}", false, detail)
      end

      missing = @options.select { |o| o.required && @raw[o.long].to_s.empty? }.map { |o| "--#{o.long}" }
      return ParseResult.new("error", "Missing required argument(s): #{missing.join(' ')}") unless missing.empty?

      ParseResult.new("ok")
    end

    # Parse like a CLI: handles --help, --help-json-schema, --completion and
    # --bash-completion, prints errors and exits on failure. Returns the values.
    def run(argv = ARGV)
      argv = argv.to_a
      head = argv.include?("--") ? argv[0...argv.index("--")] : argv
      if head.include?("--help-json-schema")
        $stdout.write("#{json_schema}\n")
        exit(0)
      end
      if head.include?("--bash-completion")
        $stdout.write(completion_data)
        exit(0)
      end
      if (i = head.index("--completion"))
        shell = head[i + 1].to_s
        script = completion_script(shell)
        Clyops.die(1, "Unknown shell '#{shell}' (expected bash, zsh or fish)") if script.nil?
        $stdout.write(script)
        exit(0)
      end

      result = parse(argv)
      if result.status == "help"
        $stdout.write(usage)
        exit(0)
      end
      if result.status == "error"
        Clyops.emit("error", result.error, force: true)
        result.detail.each { |line| $stderr.write("#{line}\n") }
        $stderr.write(usage) if result.show_usage
        exit(1)
      end
      @values
    end

    # -- accessors ----------------------------------------------------------

    def get(name) = @values[name]

    # Where an option's value came from: cli, config, env, default or unset.
    def source(long) = @sources.fetch(long.delete_prefix("--"), "unset")
    def set?(long) = source(long) == "cli"
    def explicitly_set?(long) = %w[cli config env].include?(source(long))

    # Resolved values as JSON (spec section 10).
    def values_json
      out = {}
      @options.each { |o| out[o.var] = @values[o.var] }
      @args.each { |a| out[a.name] = @values[a.name] }
      Clyops.pretty_json(out)
    end

    # -- output -------------------------------------------------------------

    # Help text (spec section 7).
    def usage
      ensure_help
      width = @env.fetch("CLYOPS_MAX_WIDTH", "")
      max_width = width.match?(/\A[0-9]+\z/) && width.to_i.positive? ? width.to_i : 100
      longest = @options.map { |o| o.label.length }.max || 0
      indent = [50, [32, longest + 4].max].min
      text_width = [20, max_width - indent].max

      row = lambda do |label, text|
        left = "  #{label}"
        left = left.length < indent ? left.ljust(indent) : "#{left} "
        lines = Clyops.wrap_text(text, text_width)
        ["#{left}#{lines[0]}"] + lines[1..].map { |line| (" " * indent) + line }
      end
      annotate = ->(text, notes) { notes.empty? ? text : "#{text} (#{notes.join(', ')})" }

      sections = []
      line = "Usage: #{@name}"
      @args.each do |a|
        line += if a.variadic then " [<#{a.name}...>]"
                elsif !a.default.empty? then " [<#{a.name}>]"
                else " <#{a.name}>"
                end
      end
      sections << ["#{line} [OPTIONS]"]
      sections << Clyops.wrap_text(@description, max_width) unless @description.empty?

      unless @args.empty?
        lines = ["Positional Arguments:"]
        @args.each do |a|
          notes = (a.variadic ? ["variadic"] : []) + (a.default.empty? ? [] : ["default: #{a.default}"])
          notes << "accepts: #{Clyops.describe_rule(a.rule)}" unless a.rule.empty?
          lines += row.(a.name, annotate.(a.description, notes))
        end
        sections << lines
      end

      unless @commands.empty?
        lines = ["Required Commands:"]
        @commands.each do |cmd, desc, hint|
          status = which(cmd) ? "installed" : "not found"
          lines += row.("#{cmd} [#{status}]", hint.empty? ? desc : "#{desc} (#{hint})")
        end
        sections << lines
      end

      @options.map(&:group).uniq.each do |group|
        lines = ["#{group}:"]
        @options.select { |o| o.group == group }.each do |o|
          notes = []
          notes << "required" if o.required
          notes << "multiple" if o.kind == "array"
          notes << "config: #{@config[o.long][0]}" if @config.key?(o.long)
          notes << "default: #{o.default}" unless o.default.empty?
          notes << "accepts: #{Clyops.describe_rule(o.rule)}" unless o.rule.empty?
          lines += row.(o.label, annotate.(o.description, notes))
        end
        sections << lines
      end

      sections << @epilog.sub(/\n+\z/, "").split("\n", -1) unless @epilog.empty?

      text = sections.map { |s| s.join("\n") }.join("\n\n")
      "#{text.split("\n", -1).map(&:rstrip).join("\n")}\n"
    end

    # JSON description of the CLI (spec section 8).
    def json_schema
      ensure_help
      type_of = lambda do |o|
        r = o.rule
        next "boolean" if o.kind == "flag" || r == "bool"
        next "integer" if r.start_with?("int") || r == "port"
        next "number" if r.start_with?("float")
        next "choice" if r.start_with?("choice:")

        Clyops.path_rule?(r) ? "path" : "string"
      end

      Clyops.pretty_json({
        "clyops" => 1,
        "script" => @name,
        "description" => @description,
        "epilog" => @epilog,
        "arguments" => @args.map do |a|
          { "name" => a.name, "description" => a.description, "required" => !a.variadic && a.default.empty?,
            "isVariadic" => a.variadic, "default" => a.default, "validation" => a.rule }
        end,
        "options" => @options.map do |o|
          { "name" => o.long, "shortName" => o.short, "variableName" => o.var, "description" => o.description,
            "default" => o.kind == "flag" ? "false" : o.default, "group" => o.group, "type" => type_of.(o),
            "isFlag" => o.kind == "flag", "isArray" => o.kind == "array", "required" => o.required,
            "validation" => o.rule, "choices" => o.rule.start_with?("choice:") ? o.rule[7..].split(",", -1) : [] }
        end,
        "requiredCommands" => @commands.map { |c, d, h| { "command" => c, "description" => d, "installHint" => h } }
      })
    end

    # Shell script that enables completion for this program (spec section 9):
    # eval "$(prog --completion bash)". nil for an unknown shell.
    def completion_script(shell)
      template = COMPLETION_SCRIPTS[shell]
      return nil if template.nil?

      template.gsub("__CLYOPS_FUNC__", @name.gsub(/[^A-Za-z0-9_]/, "_")).gsub("__CLYOPS_PROG__", @name)
    end

    # Tab-separated completion records (spec section 9).
    def completion_data
      ensure_help
      clean = ->(s) { s.tr("\t\n", "  ") }
      lines = ["#clyops-completion 1"]
      @options.each do |o|
        short = o.short.empty? ? "-" : "-#{o.short}"
        if o.kind == "flag"
          lines << "opt\t--#{o.long}\t#{short}\tflag\tnone\t-\t#{clean.(o.description)}"
        else
          kind, values = Clyops.completion_kind(o.rule, o.search_dirs)
          lines << "opt\t--#{o.long}\t#{short}\tvalue\t#{kind}\t#{values.empty? ? '-' : values}\t#{clean.(o.description)}"
        end
        lines << "opt\t--no-#{o.long}\t-\tflag\tnone\t-\t#{clean.(o.description)}" if o.bool_like?
      end
      @args.each do |a|
        kind, values = Clyops.completion_kind(a.rule, [])
        lines << "arg\t#{a.name}\t#{a.variadic ? 'variadic' : 'single'}\t#{kind}\t#{values.empty? ? '-' : values}\t#{clean.(a.description)}"
      end
      "#{lines.join("\n")}\n"
    end

    private

    def add(opt)
      raise DefinitionError, "Duplicate option --#{opt.long}" if @by_long.key?(opt.long)
      if !opt.short.empty? && (opt.short.length != 1 || @by_short.key?(opt.short))
        raise DefinitionError, "Invalid or duplicate short option -#{opt.short}"
      end
      raise DefinitionError, "Unknown validation rule '#{opt.rule}' for --#{opt.long}" unless Clyops.known_rule?(opt.rule)

      @options << opt
      @by_long[opt.long] = opt
      @by_short[opt.short] = opt unless opt.short.empty?
      self
    end

    def add_arg(arg)
      raise DefinitionError, "Argument #{arg.name} registered after a variadic argument" if @args.any?(&:variadic)
      raise DefinitionError, "Unknown validation rule '#{arg.rule}' for #{arg.name}" unless Clyops.known_rule?(arg.rule)

      @args << arg
      self
    end

    def ensure_help
      return if @by_long.key?("help")

      add(Option.new("HELP", "help", @by_short.key?("h") ? "" : "h", "flag", "", false,
                     "Show this help message and exit", "Global", "", []))
    end

    def which(cmd)
      @env.fetch("PATH", "").split(File::PATH_SEPARATOR).any? do |dir|
        path = File.join(dir, cmd)
        File.executable?(path) && !File.directory?(path)
      end
    end

    def set_cli(opt, value)
      if opt.kind == "array"
        current = @sources[opt.long] == "cli" ? @raw[opt.long] : []
        @raw[opt.long] = current + [value]
      else
        @raw[opt.long] = value
      end
      @sources[opt.long] = "cli"
    end

    def scan(argv)
      pos = 0
      rest = nil
      end_of_options = false
      i = 0
      while i < argv.length
        token = argv[i]
        i += 1
        if end_of_options || token == "-" || !token.start_with?("-")
          if rest
            rest << token
          elsif pos >= @args.length
            raise ParseError, "Unexpected argument: #{token}"
          else
            arg = @args[pos]
            pos += 1
            if arg.variadic
              rest = [token]
              @arg_raw[arg.name] = rest
            else
              @arg_raw[arg.name] = token
            end
          end
        elsif token == "--"
          end_of_options = true
        elsif token.start_with?("--")
          name, eq, value = token[2..].partition("=")
          opt = @by_long[name]
          if opt && !eq.empty?
            if opt.kind == "flag"
              b = Clyops.bool_word(value)
              raise ParseError, "Option --#{name} expects a boolean value, got '#{value}'" if b.nil?

              value = b.to_s
            end
            set_cli(opt, value)
          elsif opt
            if opt.kind == "flag"
              set_cli(opt, "true")
            else
              raise ParseError, "Option --#{name} requires an argument" if i >= argv.length || argv[i].start_with?("--")

              set_cli(opt, argv[i])
              i += 1
            end
          elsif name.start_with?("no-") && eq.empty? && @by_long.key?(name[3..])
            target = @by_long[name[3..]]
            raise ParseError, "Option --#{name} can only be used with flag/boolean options" unless target.bool_like?

            set_cli(target, "false")
          else
            raise ParseError, "Unknown option: --#{name}"
          end
        else
          cluster = token[1..]
          cluster.each_char.with_index do |ch, j|
            opt = @by_short[ch]
            raise ParseError, "Unknown option: -#{ch}" unless opt

            if opt.kind == "flag"
              set_cli(opt, "true")
              next
            end
            if j + 1 < cluster.length
              set_cli(opt, cluster[(j + 1)..])
              break
            end
            raise ParseError, "Option -#{ch} requires an argument" if i >= argv.length || argv[i].start_with?("-")

            set_cli(opt, argv[i])
            i += 1
            break
          end
        end
      end
    end

    def load_config
      opt = @by_long[@config_option]
      return unless opt

      path = @raw[opt.long]
      source = "cli"
      if path.nil? && !@env[opt.var].to_s.empty?
        path = @env[opt.var]
        source = "env"
      end
      if path.nil? && !opt.default.empty?
        path = opt.default
        source = "default"
      end
      return if path.to_s.empty? || path == "disabled"

      resolved = Clyops.resolve_path(path, @cwd, opt.search_dirs)
      @raw[opt.long] = resolved
      @sources[opt.long] = source
      read_config(resolved, 0, {})

      @config.each do |key, (value, _)|
        target = @by_long[key]
        next if target.nil? || target.equal?(opt) || @sources[key] == "cli"

        if target.kind == "flag"
          b = Clyops.bool_word(value)
          raise ParseError, "Config value for --#{key} must be a boolean, got '#{value}'" if b.nil?

          @raw[key] = b.to_s
        else
          @raw[key] = target.kind == "array" ? [value] : value
        end
        @sources[key] = "config"
      end
    end

    def read_config(path, depth, stack)
      raise ParseError, "Config include depth exceeded (10) while processing: #{path}" if depth > 10
      raise ParseError, "Config file not found: #{path}" unless File.file?(path)
      raise ParseError, "Circular config include detected: #{path}" if stack.key?(path)

      stack[path] = true
      dir = File.dirname(path)
      File.read(path, encoding: "UTF-8").split("\n", -1).each do |line|
        line = line.delete_suffix("\r")
        trimmed = line.strip
        next if trimmed.empty? || trimmed.start_with?("#")

        if (m = line.match(/\A\s*@include\s+(.+)\z/))
          target = m[1].strip
          quoted = target.match(/\A(['"])(.*)\1\z/)
          target = quoted[2] if quoted
          read_config(Clyops.normpath(dir, target), depth + 1, stack)
          next
        end
        body = line
        unless @config_prefixes.empty?
          prefix = @config_prefixes.find { |p| line.start_with?(p) }
          next if prefix.nil?

          body = line[prefix.length..]
        end
        key, eq, value = body.partition("=")
        key = key.strip.delete_prefix("--")
        next if eq.empty? || key.empty?

        @config[key] = [value.strip, dir]
      end
      stack.delete(path)
    end

    def resolve
      @args.each do |arg|
        next if @arg_raw.key?(arg.name)

        if arg.variadic
          @arg_raw[arg.name] = []
        elsif arg.default.empty?
          raise ParseError, "Missing required positional argument: #{arg.name}"
        else
          @arg_raw[arg.name] = arg.default
        end
      end

      @options.each do |opt|
        next if @sources.key?(opt.long)

        env_value = opt.kind == "array" ? nil : @env[opt.var]
        if !env_value.to_s.empty?
          if opt.kind == "flag"
            b = Clyops.bool_word(env_value)
            raise ParseError, "Environment variable #{opt.var} must be a boolean, got '#{env_value}'" if b.nil?

            env_value = b.to_s
          end
          @raw[opt.long] = env_value
          @sources[opt.long] = "env"
        elsif opt.kind == "flag"
          @raw[opt.long] = "false"
          @sources[opt.long] = "default"
        elsif !opt.default.empty?
          @raw[opt.long] = opt.default
          @sources[opt.long] = "default"
        end
      end

      # Path resolution: the base depends on where the value came from.
      @options.each do |opt|
        next if !Clyops.path_rule?(opt.rule) || !@raw.key?(opt.long) || opt.long == @config_option

        base = case @sources[opt.long]
               when "cli" then @cwd
               when "config" then @config[opt.long][1]
               else @root
               end
        value = @raw[opt.long]
        @raw[opt.long] = value.is_a?(Array) ? value.map { |v| Clyops.resolve_path(v, base, opt.search_dirs) } : Clyops.resolve_path(value, base, opt.search_dirs)
      end
      @args.each do |arg|
        next unless Clyops.path_rule?(arg.rule)

        value = @arg_raw[arg.name]
        @arg_raw[arg.name] = value.is_a?(Array) ? value.map { |v| Clyops.resolve_path(v, @cwd) } : Clyops.resolve_path(value, @cwd)
      end

      convert = ->(v, rule, name) { !v.empty? && !rule.empty? ? Clyops.validate(v, rule, name) : v }
      @options.each do |opt|
        raw = @raw[opt.long]
        @values[opt.var] = if raw.nil? then opt.kind == "array" ? [] : nil
                           elsif opt.kind == "flag" then raw == "true"
                           elsif raw.is_a?(Array) then raw.map { |v| convert.(v, opt.rule, "--#{opt.long}") }
                           else convert.(raw, opt.rule, "--#{opt.long}")
                           end
      end
      @args.each do |arg|
        value = @arg_raw[arg.name]
        @values[arg.name] = value.is_a?(Array) ? value.map { |v| convert.(v, arg.rule, arg.name) } : convert.(value, arg.rule, arg.name)
      end
    end
  end
end
