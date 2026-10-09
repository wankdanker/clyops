// Package clyops is declarative, one-line-per-option CLI parsing for Go:
// validation, help text, a JSON schema of the interface, config files,
// environment variables, logging and shell completion. Behavior follows
// spec/SPEC.md in https://github.com/wankdanker/clyops.
//
//	cli := clyops.New()
//	cli.Arg("input", "Input file", "", "path")
//	cli.Opt("PORT", "port", "p", "8080", "Server port", "Network", "port")
//	cli.Opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
//	v := cli.Run()
//	fmt.Println(v.String("input"), v.Int("PORT"), v.Bool("VERBOSE"))
package clyops

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Version is the clyops version this package implements.
const Version = "0.2.0"

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

var colors = map[string]string{"info": "\033[1;37m", "warning": "\033[0;33m", "error": "\033[0;31m", "success": "\033[0;32m"}
var silent = os.Getenv("CLYOPS_SILENT") == "true"

// SetSilent suppresses Info/Warn/Error/Success output (Die and parse errors still print).
func SetSilent(value bool) { silent = value }

func emit(level, msg string, force bool) {
	if silent && !force {
		return
	}
	tag := level
	if isTerminal(os.Stderr) && os.Getenv("NO_COLOR") == "" {
		tag = colors[level] + level + "\033[0m"
	}
	fmt.Fprintf(os.Stderr, "%s [%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), tag, msg)
}

func isTerminal(f *os.File) bool {
	st, err := f.Stat()
	return err == nil && st.Mode()&os.ModeCharDevice != 0
}

// Info logs an informational message to stderr.
func Info(format string, args ...any) { emit("info", fmt.Sprintf(format, args...), false) }

// Warn logs a warning to stderr.
func Warn(format string, args ...any) { emit("warning", fmt.Sprintf(format, args...), false) }

// Error logs an error to stderr.
func Error(format string, args ...any) { emit("error", fmt.Sprintf(format, args...), false) }

// Success logs a success message to stderr.
func Success(format string, args ...any) { emit("success", fmt.Sprintf(format, args...), false) }

// Die logs an error (never suppressed) and exits with code.
func Die(code int, format string, args ...any) {
	emit("error", fmt.Sprintf(format, args...), true)
	os.Exit(code)
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

var fixedRules = map[string]string{
	"int": "integer", "float": "number", "string": "text", "path": "path", "ip": "IP address",
	"hostname": "hostname", "url": "URL", "port": "port: 1-65535", "email": "email address", "uuid": "UUID",
	"bool": "true/false, yes/no, 1/0, on/off", "date:YYYY-MM-DD": "date: YYYY-MM-DD",
	"file:exists": "existing file", "file:readable": "readable file", "file:writable": "writable file",
	"dir:exists": "existing directory", "dir:writable": "writable directory",
}

var (
	reIntRule    = regexp.MustCompile(`^int:(\d+-\d*|-\d+)$`)
	reFloatRule  = regexp.MustCompile(`^float:(\d*\.?\d+-(\d*\.?\d+)?|-\d*\.?\d+)$`)
	reStringRule = regexp.MustCompile(`^string:(\d+|\d+-\d*|-\d+)$`)
	reInt        = regexp.MustCompile(`^-?[0-9]+$`)
	reFloat      = regexp.MustCompile(`^-?[0-9]*\.?[0-9]+$`)
	rePort       = regexp.MustCompile(`^[0-9]+$`)
	reIPv4       = regexp.MustCompile(`^([0-9]{1,3}\.){3}[0-9]{1,3}$`)
	reIPv6       = regexp.MustCompile(`^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$`)
	reHostname   = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$`)
	reURL        = regexp.MustCompile(`(?s)^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$`)
	reEmail      = regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
	reUUID       = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	reDate       = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)
	reScheme     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]+:`)
	reDotRel     = regexp.MustCompile(`^\.\.?(/|$)`)
	reNewline    = regexp.MustCompile(`\r?\n`)
	reInclude    = regexp.MustCompile(`^\s*@include\s+(.+)$`)
	reNonIdent   = regexp.MustCompile(`[^A-Za-z0-9_]`)
)

func boolWord(value string) (b, ok bool) {
	switch strings.ToLower(value) {
	case "true", "yes", "1", "on":
		return true, true
	case "false", "no", "0", "off":
		return false, true
	}
	return false, false
}

func knownRule(rule string) bool {
	if _, ok := fixedRules[rule]; ok || rule == "" {
		return true
	}
	if reIntRule.MatchString(rule) || reFloatRule.MatchString(rule) || reStringRule.MatchString(rule) {
		return true
	}
	if strings.HasPrefix(rule, "choice:") && len(rule) > 7 {
		return true
	}
	if strings.HasPrefix(rule, "regex:") && len(rule) > 6 {
		_, err := regexp.Compile(rule[6:])
		return err == nil
	}
	return false
}

func bounds(rule string) (lo, hi string) {
	rng := rule[strings.Index(rule, ":")+1:]
	lo, hi, _ = strings.Cut(rng, "-")
	return lo, hi
}

func isPathRule(rule string) bool {
	return rule == "path" || strings.HasPrefix(rule, "file:") || strings.HasPrefix(rule, "dir:")
}

// DescribeRule is the help text for a validation rule (spec section 5).
func DescribeRule(rule string) string {
	if text, ok := fixedRules[rule]; ok {
		return text
	}
	for _, p := range [][3]string{{"int:", "integer", ""}, {"float:", "number", ""}, {"string:", "text", " chars"}} {
		if !strings.HasPrefix(rule, p[0]) {
			continue
		}
		if !strings.Contains(rule, "-") {
			return p[1] + ": " + rule[len(p[0]):] + p[2]
		}
		lo, hi := bounds(rule)
		switch {
		case lo != "" && hi != "":
			return p[1] + ": " + lo + "-" + hi + p[2]
		case lo != "":
			return p[1] + ": >=" + lo + p[2]
		default:
			return p[1] + ": <=" + hi + p[2]
		}
	}
	if strings.HasPrefix(rule, "choice:") {
		return "choices: " + strings.Join(strings.Split(rule[7:], ","), ", ")
	}
	if strings.HasPrefix(rule, "regex:") {
		return "pattern: " + rule[6:]
	}
	return rule
}

// ValidationError carries the spec's error text for a value that fails its rule.
type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

// Validate checks value against rule and returns its typed form: int for
// int* and port, float64 for float*, bool for bool, string otherwise.
func Validate(value, rule, name string) (any, error) {
	fail := func(format string, args ...any) (any, error) {
		return nil, &ValidationError{name + " " + fmt.Sprintf(format, args...)}
	}
	checkBounds := func(num float64) (any, error) {
		lo, hi := bounds(rule)
		if lo != "" {
			if l, _ := strconv.ParseFloat(lo, 64); num < l {
				return fail("must be >= %s, got %s", lo, value)
			}
		}
		if hi != "" {
			if h, _ := strconv.ParseFloat(hi, 64); num > h {
				return fail("must be <= %s, got %s", hi, value)
			}
		}
		return nil, nil
	}

	switch {
	case rule == "int" || strings.HasPrefix(rule, "int:"):
		if !reInt.MatchString(value) {
			return fail("must be an integer, got '%s'", value)
		}
		n, _ := strconv.Atoi(value)
		if rule != "int" {
			if _, err := checkBounds(float64(n)); err != nil {
				return nil, err
			}
		}
		return n, nil
	case rule == "float" || strings.HasPrefix(rule, "float:"):
		if !reFloat.MatchString(value) {
			return fail("must be a number, got '%s'", value)
		}
		f, _ := strconv.ParseFloat(value, 64)
		if rule != "float" {
			if _, err := checkBounds(f); err != nil {
				return nil, err
			}
		}
		return f, nil
	case strings.HasPrefix(rule, "string:"):
		length := utf8.RuneCountInString(value)
		if !strings.Contains(rule, "-") {
			if exact, _ := strconv.Atoi(rule[7:]); length != exact {
				return fail("must be exactly %s characters, got %d", rule[7:], length)
			}
			return value, nil
		}
		lo, hi := bounds(rule)
		if l, _ := strconv.Atoi(lo); lo != "" && length < l {
			return fail("must be at least %s characters, got %d", lo, length)
		}
		if h, _ := strconv.Atoi(hi); hi != "" && length > h {
			return fail("must be at most %s characters, got %d", hi, length)
		}
		return value, nil
	case strings.HasPrefix(rule, "choice:"):
		choices := strings.Split(rule[7:], ",")
		for _, c := range choices {
			if c == value {
				return value, nil
			}
		}
		return fail("must be one of: %s, got '%s'", strings.Join(choices, ", "), value)
	case strings.HasPrefix(rule, "regex:"):
		if !regexp.MustCompile(rule[6:]).MatchString(value) {
			return fail("does not match required pattern, got '%s'", value)
		}
		return value, nil
	case rule == "bool":
		b, ok := boolWord(value)
		if !ok {
			return fail("must be a boolean (true/false, yes/no, 1/0, on/off), got '%s'", value)
		}
		return b, nil
	case rule == "port":
		n, err := strconv.Atoi(value)
		if !rePort.MatchString(value) || err != nil || n < 1 || n > 65535 {
			return fail("must be a valid port (1-65535), got '%s'", value)
		}
		return n, nil
	case rule == "ip":
		if !reIPv4.MatchString(value) && !reIPv6.MatchString(value) {
			return fail("must be a valid IP address, got '%s'", value)
		}
	case rule == "hostname":
		if !reHostname.MatchString(value) {
			return fail("must be a valid hostname, got '%s'", value)
		}
	case rule == "url":
		if !reURL.MatchString(value) {
			return fail("must be a valid URL, got '%s'", value)
		}
	case rule == "email":
		if !reEmail.MatchString(value) {
			return fail("must be a valid email address, got '%s'", value)
		}
	case rule == "uuid":
		if !reUUID.MatchString(value) {
			return fail("must be a valid UUID, got '%s'", value)
		}
	case rule == "date:YYYY-MM-DD":
		if !reDate.MatchString(value) {
			return fail("must be in YYYY-MM-DD format, got '%s'", value)
		}
	case rule == "file:exists":
		if st, err := os.Stat(value); err != nil || !st.Mode().IsRegular() {
			return fail("file does not exist: %s", value)
		}
	case rule == "file:readable":
		if !accessible(value, 4) {
			return fail("file is not readable: %s", value)
		}
	case rule == "file:writable":
		if _, err := os.Lstat(value); err == nil {
			if !accessible(value, 2) {
				return fail("file is not writable: %s", value)
			}
		} else if dir := filepath.Dir(value); !isDir(dir) || !accessible(dir, 2) {
			return fail("directory is not writable: %s", dir)
		}
	case rule == "dir:exists":
		if !isDir(value) {
			return fail("directory does not exist: %s", value)
		}
	case rule == "dir:writable":
		if !isDir(value) || !accessible(value, 2) {
			return fail("directory does not exist or is not writable: %s", value)
		}
	}
	return value, nil
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// ResolvePath resolves a path value against base (spec section 6), trying
// searchDirs for bare names that don't exist under base.
func ResolvePath(value, base string, searchDirs []string) string {
	if value == "" || value == "-" || value == "disabled" || value == "optional" {
		return value
	}
	if filepath.IsAbs(value) || reScheme.MatchString(value) {
		return value
	}
	fromBase := filepath.Join(base, value)
	if !reDotRel.MatchString(value) && len(searchDirs) > 0 && !exists(fromBase) {
		for _, dir := range searchDirs {
			if candidate := filepath.Join(dir, value); exists(candidate) {
				return candidate
			}
		}
	}
	return fromBase
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// WrapText is a greedy word wrap that keeps existing line breaks (spec section 7).
func WrapText(text string, width int) []string {
	var out []string
	for _, original := range reNewline.Split(text, -1) {
		words := strings.Fields(original)
		if len(words) == 0 {
			out = append(out, "")
			continue
		}
		line := ""
		for _, word := range words {
			switch {
			case line == "":
				line = word
			case utf8.RuneCountInString(line)+1+utf8.RuneCountInString(word) <= width:
				line += " " + word
			default:
				out = append(out, line)
				line = word
			}
		}
		out = append(out, line)
	}
	return out
}

func completionKind(rule string, searchDirs []string) (kind, values string) {
	switch {
	case rule == "path" || strings.HasPrefix(rule, "file:"):
		return "file", strings.Join(searchDirs, ":")
	case strings.HasPrefix(rule, "dir:"):
		return "dir", strings.Join(searchDirs, ":")
	case strings.HasPrefix(rule, "choice:"):
		return "choice", rule[7:]
	case rule == "bool":
		return "choice", "true,false"
	case rule == "hostname" || rule == "ip":
		return "host", ""
	case rule != "":
		return "none", ""
	}
	return "default", ""
}

// ---------------------------------------------------------------------------
// Cli
// ---------------------------------------------------------------------------

type option struct {
	variable, long, short, kind, def string // kind: flag | value | array
	required                         bool
	description, group, rule         string
	searchDirs                       []string
	secret                           bool
}

func (o *option) label() string {
	head := "    --" + o.long
	if o.short != "" {
		head = "-" + o.short + ", --" + o.long
	}
	if o.kind == "flag" {
		return head
	}
	return head + "=<value>"
}

func (o *option) boolLike() bool {
	return o.kind == "flag" || o.rule == "bool" || o.rule == "choice:true,false" || o.rule == "choice:false,true"
}

type argument struct {
	name, description, def, rule string
	variadic                     bool
}

type command struct{ name, description, hint string }

type configValue struct{ value, dir string }

// stream is a declared stdin or stdout (spec section 1.3).
type stream struct {
	Description string `json:"description"`
	ContentType string `json:"contentType"`
}

// constraint is an option relationship (spec section 1.6).
type constraint struct {
	Type    string   `json:"type"`
	Options []string `json:"options"`
}

// ParseResult is the outcome of Parse: Status is "ok", "help" or "error".
type ParseResult struct {
	Status    string
	Error     string
	ShowUsage bool
	Detail    []string
}

// Values holds resolved values, keyed by option variable and argument name.
// Types follow spec section 10: bool for flags, int, float64, string, a
// []any for arrays and variadics, nil when unset.
type Values map[string]any

// String is the value as a string ("" when unset).
func (v Values) String(name string) string {
	if v[name] == nil {
		return ""
	}
	return fmt.Sprint(v[name])
}

// Int is the value as an int (0 when unset or not an integer).
func (v Values) Int(name string) int { n, _ := v[name].(int); return n }

// Float is the value as a float64 (0 when unset).
func (v Values) Float(name string) float64 { f, _ := v[name].(float64); return f }

// Bool is the value as a bool (false when unset).
func (v Values) Bool(name string) bool { b, _ := v[name].(bool); return b }

// List is an array option's or variadic argument's values.
func (v Values) List(name string) []any { l, _ := v[name].([]any); return l }

// Strings is an array option's or variadic argument's values as strings.
func (v Values) Strings(name string) []string {
	out := []string{}
	for _, item := range v.List(name) {
		out = append(out, fmt.Sprint(item))
	}
	return out
}

type parseError string

// Cli is a program's command-line interface. Register options and arguments,
// then call Run (or Parse).
type Cli struct {
	Name   string            // program name (default: the executable's base name)
	Root   string            // base for default path values (default: Cwd)
	Cwd    string            // base for command-line path values (default: the working directory)
	Env    map[string]string // environment (default: the process environment)
	Values Values

	description, epilog string
	options             []*option
	byLong, byShort     map[string]*option
	args                []*argument
	commands            []command
	configOption        string
	configPrefixes      []string
	raw                 map[string][]string // option long -> value(s)
	argRaw              map[string][]string
	argSet              map[string]bool
	sources             map[string]string
	config              map[string]configValue
	effects             []string
	stdin, stdout       *stream
	constraints         []constraint
	children            []*Cli
	parent              *Cli
	word                string
	selected            *Cli // the command selected by the last parse (nil: this one)
}

// New returns an empty Cli for the running program.
func New() *Cli {
	cwd, _ := os.Getwd()
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if k, v, ok := strings.Cut(kv, "="); ok {
			env[k] = v
		}
	}
	return &Cli{Name: filepath.Base(os.Args[0]), Cwd: cwd, Env: env, Values: Values{},
		byLong: map[string]*option{}, byShort: map[string]*option{}}
}

// root is Root resolved against Cwd.
func (c *Cli) root() string {
	if filepath.IsAbs(c.Root) {
		return filepath.Clean(c.Root)
	}
	return filepath.Join(c.Cwd, c.Root)
}

// SetDescription sets the text shown under the usage line.
func (c *Cli) SetDescription(text string) *Cli { c.description = text; return c }

// SetEpilog sets the text shown at the end of the help.
func (c *Cli) SetEpilog(text string) *Cli { c.epilog = text; return c }

// SetEffects declares what running the program does: read-only, idempotent, destructive, network.
func (c *Cli) SetEffects(effects ...string) *Cli {
	for _, e := range effects {
		if e != "read-only" && e != "idempotent" && e != "destructive" && e != "network" {
			panic("clyops: unknown effect '" + e + "'")
		}
	}
	c.effects = effects
	return c
}

// SetStdin declares what the program reads on stdin; contentType is a MIME type or a comma-separated list.
func (c *Cli) SetStdin(description, contentType string) *Cli {
	c.stdin = &stream{description, contentType}
	return c
}

// SetStdout declares what the program writes on stdout; undeclared means text.
func (c *Cli) SetStdout(description, contentType string) *Cli {
	c.stdout = &stream{description, contentType}
	return c
}

// Exclusive says at most one of these options may be given.
func (c *Cli) Exclusive(longs ...string) *Cli { return c.addConstraint("exclusive", longs) }

// Requires says that when long is given, the others must be too.
func (c *Cli) Requires(long string, longs ...string) *Cli {
	return c.addConstraint("requires", append([]string{long}, longs...))
}

// OneOf says at least one of these options must be given.
func (c *Cli) OneOf(longs ...string) *Cli { return c.addConstraint("oneOf", longs) }

func (c *Cli) addConstraint(kind string, longs []string) *Cli {
	for _, long := range longs {
		if c.findOption(long, false) == nil {
			panic("clyops: unknown option --" + long + " in constraint")
		}
	}
	c.constraints = append(c.constraints, constraint{kind, longs})
	return c
}

// Command registers a command (spec section 1.7) and returns it, to register
// its options and arguments on.
func (c *Cli) Command(name, description string) *Cli {
	if len(c.args) > 0 {
		panic("clyops: cannot mix commands and positional arguments")
	}
	for _, k := range c.children {
		if k.word == name {
			panic("clyops: duplicate command " + name)
		}
	}
	child := &Cli{Name: c.Name + " " + name, Root: c.root(), Cwd: c.Cwd, Env: c.Env, Values: Values{},
		byLong: map[string]*option{}, byShort: map[string]*option{}, description: description, parent: c, word: name}
	c.children = append(c.children, child)
	return child
}

// CommandPath is the command words selected by the last parse, e.g. ["db", "migrate"].
func (c *Cli) CommandPath() []string {
	words := []string{}
	for node := c.sel(); node != nil && node != c; node = node.parent {
		words = append([]string{node.word}, words...)
	}
	return words
}

func (c *Cli) sel() *Cli {
	if c.selected == nil {
		return c
	}
	return c.selected
}

// chain is the selected command, its parent, ... up to c.
func (c *Cli) chain() []*Cli {
	var out []*Cli
	for node := c.sel(); node != nil; node = node.parent {
		out = append(out, node)
		if node == c {
			break
		}
	}
	return out
}

func (c *Cli) chainOptions() []*option {
	var out []*option
	for _, n := range c.chain() {
		out = append(out, n.options...)
	}
	return out
}

// findOption is an option by long (or short) name, in c and its ancestors.
func (c *Cli) findOption(name string, short bool) *option {
	for node := c; node != nil; node = node.parent {
		m := node.byLong
		if short {
			m = node.byShort
		}
		if opt := m[name]; opt != nil {
			return opt
		}
	}
	return nil
}

// SetConfig names the option holding a config file path; prefixes is comma-separated.
func (c *Cli) SetConfig(option, prefixes string) *Cli {
	c.configOption = option
	c.configPrefixes = nil
	for _, p := range strings.Split(prefixes, ",") {
		if p = strings.TrimSpace(p); p != "" {
			c.configPrefixes = append(c.configPrefixes, p)
		}
	}
	return c
}

// RequireCommand declares an external command the program needs.
func (c *Cli) RequireCommand(name, description, installHint string) *Cli {
	c.commands = append(c.commands, command{name, description, installHint})
	return c
}

// SetPathSearch gives fallback directories (colon-separated, relative to Root)
// for bare relative values of a path option.
func (c *Cli) SetPathSearch(long, dirs string) *Cli {
	opt := c.byLong[long]
	if opt == nil {
		panic("clyops: SetPathSearch: no option --" + long)
	}
	opt.searchDirs = nil
	for _, d := range strings.Split(dirs, ":") {
		if d != "" {
			opt.searchDirs = append(opt.searchDirs, filepath.Join(c.root(), d))
		}
	}
	if opt.rule == "" {
		opt.rule = "path"
	}
	return c
}

// Opt registers an option. def is a value, "flag", "optional", or "" (required).
// groupAndRule is an optional group (default "Options") and validation rule.
func (c *Cli) Opt(variable, long, short, def, description string, groupAndRule ...string) *Cli {
	group, rule := groupRule(groupAndRule)
	kind, value := "value", def
	if def == "flag" {
		kind = "flag"
	}
	if def == "flag" || def == "optional" {
		value = ""
	}
	return c.add(&option{variable, long, short, kind, value, def == "", description, group, rule, nil, false})
}

// OptArray registers a repeatable option whose values accumulate into a list.
func (c *Cli) OptArray(variable, long, short, description string, groupAndRule ...string) *Cli {
	group, rule := groupRule(groupAndRule)
	return c.add(&option{variable, long, short, "array", "", false, description, group, rule, nil, false})
}

// Arg registers a positional argument. An empty def makes it required.
func (c *Cli) Arg(name, description, def string, rule ...string) *Cli {
	return c.addArg(&argument{name, description, def, first(rule), false})
}

// ArgVariadic registers a final positional argument that collects the remaining tokens.
func (c *Cli) ArgVariadic(name, description string, rule ...string) *Cli {
	return c.addArg(&argument{name, description, "", first(rule), true})
}

func groupRule(extra []string) (group, rule string) {
	group = "Options"
	if len(extra) > 0 && extra[0] != "" {
		group = extra[0]
	}
	if len(extra) > 1 {
		rule = extra[1]
	}
	return group, rule
}

func first(s []string) string {
	if len(s) > 0 {
		return s[0]
	}
	return ""
}

func (c *Cli) add(opt *option) *Cli {
	if c.byLong[opt.long] != nil {
		panic("clyops: duplicate option --" + opt.long)
	}
	if opt.short != "" && (utf8.RuneCountInString(opt.short) != 1 || c.byShort[opt.short] != nil) {
		panic("clyops: invalid or duplicate short option -" + opt.short)
	}
	if opt.rule == "secret" || strings.HasPrefix(opt.rule, "secret:") {
		opt.secret, opt.rule = true, strings.TrimPrefix(strings.TrimPrefix(opt.rule, "secret"), ":")
	}
	if !knownRule(opt.rule) {
		panic(fmt.Sprintf("clyops: unknown validation rule '%s' for --%s", opt.rule, opt.long))
	}
	c.options = append(c.options, opt)
	c.byLong[opt.long] = opt
	if opt.short != "" {
		c.byShort[opt.short] = opt
	}
	return c
}

func (c *Cli) addArg(arg *argument) *Cli {
	if len(c.children) > 0 {
		panic("clyops: cannot mix commands and positional arguments")
	}
	for _, a := range c.args {
		if a.variadic {
			panic("clyops: argument " + arg.name + " registered after a variadic argument")
		}
	}
	if !knownRule(arg.rule) {
		panic(fmt.Sprintf("clyops: unknown validation rule '%s' for %s", arg.rule, arg.name))
	}
	c.args = append(c.args, arg)
	return c
}

func (c *Cli) ensureHelp() {
	if c.byLong["help"] == nil {
		short := "h"
		if c.byShort["h"] != nil {
			short = ""
		}
		c.add(&option{"HELP", "help", short, "flag", "", false, "Show this help message and exit", "Global", "", nil, false})
	}
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Parse parses argv without exiting. Values are in c.Values when Status is "ok".
func (c *Cli) Parse(argv []string) ParseResult {
	c.raw, c.argRaw, c.argSet = map[string][]string{}, map[string][]string{}, map[string]bool{}
	c.sources, c.config = map[string]string{}, map[string]configValue{}
	c.Values = Values{}
	c.selected = nil
	c.ensureHelp()

	scanErr := c.catch(func() { c.scan(argv) })
	if scanErr == "" && c.configOption != "" {
		scanErr = c.catch(c.loadConfig)
	}
	if v := c.raw["help"]; len(v) > 0 && v[0] == "true" {
		return ParseResult{Status: "help"}
	}
	if scanErr != "" {
		return ParseResult{Status: "error", Error: scanErr, ShowUsage: true}
	}
	if err := c.catch(c.resolve); err != "" {
		return ParseResult{Status: "error", Error: err, ShowUsage: true}
	}

	var missingCmds []command
	for _, cmd := range c.requiredCommands() {
		if !c.which(cmd.name) {
			missingCmds = append(missingCmds, cmd)
		}
	}
	if len(missingCmds) > 0 {
		var names, detail []string
		for _, cmd := range missingCmds {
			names = append(names, cmd.name)
			detail = append(detail, "  "+cmd.name+" - "+cmd.description)
			if cmd.hint != "" {
				detail = append(detail, "    Install: "+cmd.hint)
			}
		}
		return ParseResult{Status: "error", Error: "Missing required command(s): " + strings.Join(names, ", "), Detail: detail}
	}

	var missing []string
	for _, o := range c.chainOptions() {
		if o.required && (len(c.raw[o.long]) == 0 || c.raw[o.long][0] == "") {
			missing = append(missing, "--"+o.long)
		}
	}
	if len(missing) > 0 {
		return ParseResult{Status: "error", Error: "Missing required argument(s): " + strings.Join(missing, " "), ShowUsage: true}
	}
	if err := c.checkConstraints(); err != "" {
		return ParseResult{Status: "error", Error: err, ShowUsage: true}
	}
	return ParseResult{Status: "ok"}
}

// requiredCommands is the chain's required commands, from the program down.
func (c *Cli) requiredCommands() []command {
	var out []command
	chain := c.chain()
	for i := len(chain) - 1; i >= 0; i-- {
		out = append(out, chain[i].commands...)
	}
	return out
}

// chainConstraints is the chain's relationships, from the program down.
func (c *Cli) chainConstraints() []constraint {
	var out []constraint
	chain := c.chain()
	for i := len(chain) - 1; i >= 0; i-- {
		out = append(out, chain[i].constraints...)
	}
	return out
}

// checkConstraints is spec section 1.6: the first relationship that fails.
func (c *Cli) checkConstraints() string {
	given := func(long string) bool {
		s, v := c.Source(long), c.Values[c.findSel(long).variable]
		list, isList := v.([]any)
		return (s == "cli" || s == "config" || s == "env") && v != false && !(isList && len(list) == 0)
	}
	for _, k := range c.chainConstraints() {
		var on []string
		for _, long := range k.Options {
			if given(long) {
				on = append(on, long)
			}
		}
		switch {
		case k.Type == "exclusive" && len(on) > 1:
			return "Options --" + on[0] + " and --" + on[1] + " cannot be used together"
		case k.Type == "requires" && given(k.Options[0]):
			for _, long := range k.Options[1:] {
				if !given(long) {
					return "Option --" + k.Options[0] + " requires --" + long
				}
			}
		case k.Type == "oneOf" && len(on) == 0:
			return "One of --" + strings.Join(k.Options, ", --") + " is required"
		}
	}
	return ""
}

// findSel is an option of the selected chain.
func (c *Cli) findSel(name string) *option { return c.sel().findOption(name, false) }

// catch runs fn and returns the message of a parse or validation error it raises.
func (c *Cli) catch(fn func()) (msg string) {
	defer func() {
		switch e := recover().(type) {
		case nil:
		case parseError:
			msg = string(e)
		case *ValidationError:
			msg = e.Message
		default:
			panic(e)
		}
	}()
	fn()
	return ""
}

func (c *Cli) which(name string) bool {
	if strings.Contains(name, "/") {
		st, err := os.Stat(name)
		return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
	}
	for _, dir := range filepath.SplitList(c.Env["PATH"]) {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return true
		}
	}
	return false
}

func (c *Cli) setCLI(opt *option, value string) {
	if opt.kind == "array" {
		if c.sources[opt.long] != "cli" {
			c.raw[opt.long] = nil
		}
		c.raw[opt.long] = append(c.raw[opt.long], value)
	} else {
		c.raw[opt.long] = []string{value}
	}
	c.sources[opt.long] = "cli"
}

func (c *Cli) scan(argv []string) {
	pos := 0
	var rest *argument
	endOfOptions := false
	for i := 0; i < len(argv); {
		token := argv[i]
		i++
		switch {
		case endOfOptions || token == "-" || !strings.HasPrefix(token, "-"):
			node := c.sel()
			if rest != nil {
				c.argRaw[rest.name] = append(c.argRaw[rest.name], token)
			} else if len(node.children) > 0 {
				var child *Cli
				for _, k := range node.children {
					if k.word == token {
						child = k
					}
				}
				if child == nil {
					panic(parseError("Unknown command: " + token))
				}
				c.selected = child
			} else if pos >= len(node.args) {
				panic(parseError("Unexpected argument: " + token))
			} else {
				arg := node.args[pos]
				pos++
				c.argRaw[arg.name] = []string{token}
				c.argSet[arg.name] = true
				if arg.variadic {
					rest = arg
				}
			}
		case token == "--":
			endOfOptions = true
		case strings.HasPrefix(token, "--"):
			name, value, eq := strings.Cut(token[2:], "=")
			opt := c.findSel(name)
			switch {
			case opt != nil && eq:
				if opt.kind == "flag" {
					b, ok := boolWord(value)
					if !ok {
						panic(parseError(fmt.Sprintf("Option --%s expects a boolean value, got '%s'", name, value)))
					}
					value = strconv.FormatBool(b)
				}
				c.setCLI(opt, value)
			case opt != nil:
				if opt.kind == "flag" {
					c.setCLI(opt, "true")
				} else {
					if i >= len(argv) || strings.HasPrefix(argv[i], "--") {
						panic(parseError("Option --" + name + " requires an argument"))
					}
					c.setCLI(opt, argv[i])
					i++
				}
			case strings.HasPrefix(name, "no-") && !eq && c.findSel(name[3:]) != nil:
				target := c.findSel(name[3:])
				if !target.boolLike() {
					panic(parseError("Option --" + name + " can only be used with flag/boolean options"))
				}
				c.setCLI(target, "false")
			default:
				panic(parseError("Unknown option: --" + name))
			}
		default:
			cluster := []rune(token[1:])
			for j, ch := range cluster {
				opt := c.sel().findOption(string(ch), true)
				if opt == nil {
					panic(parseError("Unknown option: -" + string(ch)))
				}
				if opt.kind == "flag" {
					c.setCLI(opt, "true")
					continue
				}
				if j+1 < len(cluster) {
					c.setCLI(opt, string(cluster[j+1:]))
					break
				}
				if i >= len(argv) || strings.HasPrefix(argv[i], "-") {
					panic(parseError("Option -" + string(ch) + " requires an argument"))
				}
				c.setCLI(opt, argv[i])
				i++
				break
			}
		}
	}
}

func (c *Cli) loadConfig() {
	opt := c.findSel(c.configOption)
	if opt == nil {
		return
	}
	path, source, set := "", "cli", false
	if v, ok := c.raw[opt.long]; ok {
		path, set = v[0], true
	}
	if !set && c.Env[opt.variable] != "" {
		path, source, set = c.Env[opt.variable], "env", true
	}
	if !set && opt.def != "" {
		path, source = opt.def, "default"
	}
	if path == "" || path == "disabled" {
		return
	}
	resolved := ResolvePath(path, c.Cwd, opt.searchDirs)
	c.raw[opt.long] = []string{resolved}
	c.sources[opt.long] = source
	c.readConfig(resolved, 0, map[string]bool{})

	for key, cv := range c.config {
		target := c.findSel(key)
		if target == nil || target == opt || c.sources[key] == "cli" {
			continue
		}
		if target.kind == "flag" {
			b, ok := boolWord(cv.value)
			if !ok {
				panic(parseError(fmt.Sprintf("Config value for --%s must be a boolean, got '%s'", key, cv.value)))
			}
			c.raw[key] = []string{strconv.FormatBool(b)}
		} else {
			c.raw[key] = []string{cv.value}
		}
		c.sources[key] = "config"
	}
}

func (c *Cli) readConfig(path string, depth int, stack map[string]bool) {
	if depth > 10 {
		panic(parseError("Config include depth exceeded (10) while processing: " + path))
	}
	if st, err := os.Stat(path); err != nil || !st.Mode().IsRegular() {
		panic(parseError("Config file not found: " + path))
	}
	if stack[path] {
		panic(parseError("Circular config include detected: " + path))
	}
	stack[path] = true
	dir := filepath.Dir(path)
	data, err := os.ReadFile(path)
	if err != nil {
		panic(parseError("Config file not found: " + path))
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSuffix(line, "\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if m := reInclude.FindStringSubmatch(line); m != nil {
			target := strings.TrimSpace(m[1])
			if len(target) >= 2 && (target[0] == '"' || target[0] == '\'') && target[len(target)-1] == target[0] {
				target = target[1 : len(target)-1]
			}
			c.readConfig(filepath.Join(dir, target), depth+1, stack)
			continue
		}
		body := line
		if len(c.configPrefixes) > 0 {
			found := false
			for _, p := range c.configPrefixes {
				if strings.HasPrefix(line, p) {
					body, found = line[len(p):], true
					break
				}
			}
			if !found {
				continue
			}
		}
		key, value, eq := strings.Cut(body, "=")
		key = strings.TrimPrefix(strings.TrimSpace(key), "--")
		if !eq || key == "" {
			continue
		}
		c.config[key] = configValue{strings.TrimSpace(value), dir}
	}
	delete(stack, path)
}

func (c *Cli) resolve() {
	if len(c.sel().children) > 0 {
		panic(parseError("Missing command"))
	}
	options, args := c.chainOptions(), c.sel().args
	for _, arg := range args {
		if c.argSet[arg.name] {
			continue
		}
		switch {
		case arg.variadic:
			c.argRaw[arg.name] = []string{}
		case arg.def == "":
			panic(parseError("Missing required positional argument: " + arg.name))
		default:
			c.argRaw[arg.name] = []string{arg.def}
		}
	}

	for _, opt := range options {
		if _, ok := c.sources[opt.long]; ok {
			continue
		}
		envValue := ""
		if opt.kind != "array" {
			envValue = c.Env[opt.variable]
		}
		switch {
		case envValue != "":
			if opt.kind == "flag" {
				b, ok := boolWord(envValue)
				if !ok {
					panic(parseError(fmt.Sprintf("Environment variable %s must be a boolean, got '%s'", opt.variable, envValue)))
				}
				envValue = strconv.FormatBool(b)
			}
			c.raw[opt.long] = []string{envValue}
			c.sources[opt.long] = "env"
		case opt.kind == "flag":
			c.raw[opt.long] = []string{"false"}
			c.sources[opt.long] = "default"
		case opt.def != "":
			c.raw[opt.long] = []string{opt.def}
			c.sources[opt.long] = "default"
		}
	}

	// Path resolution: the base depends on where the value came from.
	for _, opt := range options {
		values, ok := c.raw[opt.long]
		if !isPathRule(opt.rule) || !ok || opt.long == c.configOption {
			continue
		}
		base := c.root()
		switch c.sources[opt.long] {
		case "cli":
			base = c.Cwd
		case "config":
			base = c.config[opt.long].dir
		}
		for i, v := range values {
			values[i] = ResolvePath(v, base, opt.searchDirs)
		}
	}
	for _, arg := range args {
		if isPathRule(arg.rule) {
			for i, v := range c.argRaw[arg.name] {
				c.argRaw[arg.name][i] = ResolvePath(v, c.Cwd, nil)
			}
		}
	}

	convert := func(v, rule, name string) any {
		if v == "" || rule == "" {
			return v
		}
		typed, err := Validate(v, rule, name)
		if err != nil {
			panic(err)
		}
		return typed
	}
	list := func(values []string, rule, name string) []any {
		out := []any{}
		for _, v := range values {
			out = append(out, convert(v, rule, name))
		}
		return out
	}
	for _, opt := range options {
		values, ok := c.raw[opt.long]
		switch {
		case !ok && opt.kind == "array":
			c.Values[opt.variable] = []any{}
		case !ok:
			c.Values[opt.variable] = nil
		case opt.kind == "flag":
			c.Values[opt.variable] = values[0] == "true"
		case opt.kind == "array":
			c.Values[opt.variable] = list(values, opt.rule, "--"+opt.long)
		default:
			c.Values[opt.variable] = convert(values[0], opt.rule, "--"+opt.long)
		}
	}
	for _, arg := range args {
		if arg.variadic {
			c.Values[arg.name] = list(c.argRaw[arg.name], arg.rule, arg.name)
		} else {
			c.Values[arg.name] = convert(c.argRaw[arg.name][0], arg.rule, arg.name)
		}
	}
	if len(c.children) > 0 {
		c.Values["command"] = c.CommandPath()
	}
}

// Run parses os.Args like a CLI: it handles --help, --help-json-schema,
// --completion and --bash-completion, prints errors and exits on failure,
// and returns the values.
func (c *Cli) Run() Values { return c.RunArgs(os.Args[1:]) }

// RunArgs is Run with an explicit argv (without the program name).
func (c *Cli) RunArgs(argv []string) Values {
	head := argv
	for i, a := range argv {
		if a == "--" {
			head = argv[:i]
			break
		}
	}
	words := []string{}
	if len(head) < len(argv) {
		words = argv[len(head)+1:]
	}
	for i, a := range head {
		switch a {
		case "--help-json-schema":
			fmt.Println(c.JSONSchema())
			os.Exit(0)
		case "--bash-completion":
			fmt.Print(c.CompletionData(words...))
			os.Exit(0)
		case "--completion":
			shell := ""
			if i+1 < len(head) {
				shell = head[i+1]
			}
			script, ok := c.CompletionScript(shell)
			if !ok {
				Die(1, "Unknown shell '%s' (expected bash, zsh or fish)", shell)
			}
			fmt.Print(script)
			os.Exit(0)
		}
	}

	result := c.Parse(argv)
	switch result.Status {
	case "help":
		fmt.Print(c.Usage())
		os.Exit(0)
	case "error":
		emit("error", result.Error, true)
		for _, line := range result.Detail {
			fmt.Fprintln(os.Stderr, line)
		}
		if result.ShowUsage {
			fmt.Fprint(os.Stderr, c.Usage())
		}
		os.Exit(1)
	}
	return c.Values
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

// Get is a resolved value by option variable or argument name.
func (c *Cli) Get(name string) any { return c.Values[name] }

// Source is where an option's value came from: cli, config, env, default or unset.
func (c *Cli) Source(long string) string {
	if s, ok := c.sources[strings.TrimPrefix(long, "--")]; ok {
		return s
	}
	return "unset"
}

// IsSet reports whether the option was given on the command line.
func (c *Cli) IsSet(long string) bool { return c.Source(long) == "cli" }

// IsExplicitlySet reports whether the option came from the command line, a config file or the environment.
func (c *Cli) IsExplicitlySet(long string) bool {
	s := c.Source(long)
	return s == "cli" || s == "config" || s == "env"
}

// ValuesJSON is the resolved values as JSON (spec section 10), in registration order.
func (c *Cli) ValuesJSON() string {
	var b strings.Builder
	b.WriteString("{")
	n := 0
	write := func(key string, value any) {
		if n > 0 {
			b.WriteString(",")
		}
		n++
		b.WriteString("\n  " + jsonText(key) + ": " + strings.ReplaceAll(jsonIndent(value), "\n", "\n  "))
	}
	for _, o := range c.chainOptions() {
		v := c.Values[o.variable]
		if o.secret && v != nil {
			if list, ok := v.([]any); ok {
				masked := []any{}
				for range list {
					masked = append(masked, "***")
				}
				v = masked
			} else {
				v = "***"
			}
		}
		write(o.variable, v)
	}
	for _, a := range c.sel().args {
		write(a.name, c.Values[a.name])
	}
	if len(c.children) > 0 {
		write("command", c.CommandPath())
	}
	if n > 0 {
		b.WriteString("\n")
	}
	b.WriteString("}")
	return b.String()
}

// jsonIndent is value as two-space indented JSON without HTML escaping.
func jsonIndent(value any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(value); err != nil {
		panic(err)
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

func jsonText(s string) string { return jsonIndent(s) }

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Usage is the help text (spec section 7), for the selected command.
func (c *Cli) Usage() string {
	c.ensureHelp()
	node, options := c.sel(), c.chainOptions()
	maxWidth := 100
	if w, err := strconv.Atoi(c.Env["CLYOPS_MAX_WIDTH"]); err == nil && w > 0 && rePort.MatchString(c.Env["CLYOPS_MAX_WIDTH"]) {
		maxWidth = w
	}
	longest := 0
	for _, o := range options {
		longest = max(longest, utf8.RuneCountInString(o.label()))
	}
	for _, k := range node.children {
		longest = max(longest, utf8.RuneCountInString(k.word))
	}
	indent := min(50, max(32, longest+4))
	textWidth := max(20, maxWidth-indent)

	row := func(label, text string) []string {
		left := "  " + label
		if n := utf8.RuneCountInString(left); n < indent {
			left += strings.Repeat(" ", indent-n)
		} else {
			left += " "
		}
		lines := WrapText(text, textWidth)
		out := []string{left + lines[0]}
		for _, line := range lines[1:] {
			out = append(out, strings.Repeat(" ", indent)+line)
		}
		return out
	}
	annotate := func(text string, notes []string) string {
		if len(notes) == 0 {
			return text
		}
		return text + " (" + strings.Join(notes, ", ") + ")"
	}

	var sections [][]string
	usage := "Usage: " + node.Name
	if len(node.children) > 0 {
		usage += " <command>"
	}
	for _, a := range node.args {
		switch {
		case a.variadic:
			usage += " [<" + a.name + "...>]"
		case a.def != "":
			usage += " [<" + a.name + ">]"
		default:
			usage += " <" + a.name + ">"
		}
	}
	sections = append(sections, []string{usage + " [OPTIONS]"})
	if node.description != "" {
		sections = append(sections, WrapText(node.description, maxWidth))
	}
	var io []string
	for _, d := range []struct {
		label string
		s     *stream
	}{{"Input:", node.stdin}, {"Output:", node.stdout}} {
		if d.s == nil {
			continue
		}
		line := d.label
		if d.s.Description != "" {
			line += " " + d.s.Description
		}
		if d.s.ContentType != "" {
			line += " (" + d.s.ContentType + ")"
		}
		io = append(io, line)
	}
	if len(io) > 0 {
		sections = append(sections, io)
	}
	if len(node.children) > 0 {
		lines := []string{"Commands:"}
		for _, k := range node.children {
			lines = append(lines, row(k.word, k.description)...)
		}
		sections = append(sections, lines)
	}
	if len(node.args) > 0 {
		lines := []string{"Positional Arguments:"}
		for _, a := range node.args {
			var notes []string
			if a.variadic {
				notes = append(notes, "variadic")
			}
			if a.def != "" {
				notes = append(notes, "default: "+a.def)
			}
			if a.rule != "" {
				notes = append(notes, "accepts: "+DescribeRule(a.rule))
			}
			lines = append(lines, row(a.name, annotate(a.description, notes))...)
		}
		sections = append(sections, lines)
	}
	if commands := c.requiredCommands(); len(commands) > 0 {
		lines := []string{"Required Commands:"}
		for _, cmd := range commands {
			status := "not found"
			if c.which(cmd.name) {
				status = "installed"
			}
			text := cmd.description
			if cmd.hint != "" {
				text += " (" + cmd.hint + ")"
			}
			lines = append(lines, row(cmd.name+" ["+status+"]", text)...)
		}
		sections = append(sections, lines)
	}
	constraints := c.chainConstraints()
	list := func(longs []string) string { return "--" + strings.Join(longs, ", --") }
	var groups []string
	seen := map[string]bool{}
	for _, o := range options {
		if !seen[o.group] {
			seen[o.group] = true
			groups = append(groups, o.group)
		}
	}
	for _, group := range groups {
		lines := []string{group + ":"}
		for _, o := range options {
			if o.group != group {
				continue
			}
			var notes []string
			if o.required {
				notes = append(notes, "required")
			}
			if o.kind == "array" {
				notes = append(notes, "multiple")
			}
			if o.secret {
				notes = append(notes, "secret")
			}
			if cv, ok := c.config[o.long]; ok {
				if o.secret {
					notes = append(notes, "config: ***")
				} else {
					notes = append(notes, "config: "+cv.value)
				}
			}
			if o.def != "" {
				notes = append(notes, "default: "+o.def)
			}
			if o.rule != "" {
				notes = append(notes, "accepts: "+DescribeRule(o.rule))
			}
			for _, k := range constraints {
				if !slices.Contains(k.Options, o.long) {
					continue
				}
				switch {
				case k.Type == "exclusive":
					others := slices.DeleteFunc(slices.Clone(k.Options), func(l string) bool { return l == o.long })
					notes = append(notes, "conflicts with: "+list(others))
				case k.Type == "requires" && k.Options[0] == o.long:
					notes = append(notes, "requires: "+list(k.Options[1:]))
				case k.Type == "oneOf":
					notes = append(notes, "one of: "+list(k.Options))
				}
			}
			lines = append(lines, row(o.label(), annotate(o.description, notes))...)
		}
		sections = append(sections, lines)
	}
	if node.epilog != "" {
		sections = append(sections, strings.Split(strings.TrimRight(node.epilog, "\n"), "\n"))
	}

	var parts []string
	for _, s := range sections {
		parts = append(parts, strings.Join(s, "\n"))
	}
	lines := strings.Split(strings.Join(parts, "\n\n"), "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t\r\n\v\f")
	}
	return strings.Join(lines, "\n") + "\n"
}

// Field order matters: it is the order of the JSON output (spec section 8).
type schemaArgument struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Required    bool   `json:"required"`
	IsVariadic  bool   `json:"isVariadic"`
	Default     string `json:"default"`
	Validation  string `json:"validation"`
}

type schemaOption struct {
	Name         string   `json:"name"`
	ShortName    string   `json:"shortName"`
	VariableName string   `json:"variableName"`
	Description  string   `json:"description"`
	Default      string   `json:"default"`
	Group        string   `json:"group"`
	Type         string   `json:"type"`
	IsFlag       bool     `json:"isFlag"`
	IsArray      bool     `json:"isArray"`
	Required     bool     `json:"required"`
	Validation   string   `json:"validation"`
	Choices      []string `json:"choices"`
	Secret       bool     `json:"secret"`
}

type schemaCommand struct {
	Command     string `json:"command"`
	Description string `json:"description"`
	InstallHint string `json:"installHint"`
}

type schemaBody struct {
	Description      string           `json:"description"`
	Epilog           string           `json:"epilog"`
	Arguments        []schemaArgument `json:"arguments"`
	Options          []schemaOption   `json:"options"`
	RequiredCommands []schemaCommand  `json:"requiredCommands"`
	Effects          []string         `json:"effects"`
	Constraints      []constraint     `json:"constraints"`
	Stdin            *stream          `json:"stdin"`
	Stdout           *stream          `json:"stdout"`
	Commands         []schemaNode     `json:"commands"`
}

type schemaNode struct {
	Name string `json:"name"`
	schemaBody
}

type schema struct {
	Clyops int    `json:"clyops"`
	Script string `json:"script"`
	schemaBody
}

// JSONSchema is the JSON description of the CLI (spec section 8).
func (c *Cli) JSONSchema() string {
	c.ensureHelp()
	return jsonIndent(schema{1, c.Name, c.schemaBody()})
}

func (c *Cli) schemaBody() schemaBody {
	s := schemaBody{Description: c.description, Epilog: c.epilog, Arguments: []schemaArgument{}, Options: []schemaOption{},
		RequiredCommands: []schemaCommand{}, Effects: append([]string{}, c.effects...),
		Constraints: append([]constraint{}, c.constraints...), Stdin: c.stdin, Stdout: c.stdout, Commands: []schemaNode{}}
	for _, a := range c.args {
		s.Arguments = append(s.Arguments, schemaArgument{a.name, a.description, !a.variadic && a.def == "", a.variadic, a.def, a.rule})
	}
	for _, o := range c.options {
		def, typ, choices := o.def, "string", []string{}
		r := o.rule
		switch {
		case o.kind == "flag" || r == "bool":
			typ = "boolean"
		case strings.HasPrefix(r, "int") || r == "port":
			typ = "integer"
		case strings.HasPrefix(r, "float"):
			typ = "number"
		case strings.HasPrefix(r, "choice:"):
			typ = "choice"
		case isPathRule(r):
			typ = "path"
		}
		if o.kind == "flag" {
			def = "false"
		}
		if strings.HasPrefix(r, "choice:") {
			choices = strings.Split(r[7:], ",")
		}
		s.Options = append(s.Options, schemaOption{o.long, o.short, o.variable, o.description, def, o.group, typ,
			o.kind == "flag", o.kind == "array", o.required, r, choices, o.secret})
	}
	for _, cmd := range c.commands {
		s.RequiredCommands = append(s.RequiredCommands, schemaCommand{cmd.name, cmd.description, cmd.hint})
	}
	for _, k := range c.children {
		s.Commands = append(s.Commands, schemaNode{k.word, k.schemaBody()})
	}
	return s
}

// CompletionScript is the shell script that enables completion for this
// program (spec section 9): eval "$(prog --completion bash)". ok is false for
// an unknown shell.
func (c *Cli) CompletionScript(shell string) (script string, ok bool) {
	template, ok := completionScripts[shell]
	if !ok {
		return "", false
	}
	fn := reNonIdent.ReplaceAllString(c.Name, "_")
	return strings.ReplaceAll(strings.ReplaceAll(template, "__CLYOPS_FUNC__", fn), "__CLYOPS_PROG__", c.Name), true
}

// CompletionData is the tab-separated completion records (spec section 9).
// words are the words typed after the program name; a program with commands
// follows them.
func (c *Cli) CompletionData(words ...string) string {
	c.ensureHelp()
	clean := func(s string) string { return strings.NewReplacer("\t", " ", "\n", " ").Replace(s) }
	orDash := func(s string) string {
		if s == "" {
			return "-"
		}
		return s
	}
	lines := []string{"#clyops-completion 1"}
	node := c
	if len(c.children) > 0 {
		skip := 0
	walk:
		for _, w := range words {
			for _, k := range node.children {
				if k.word == w {
					node, skip = k, skip+1
					continue walk
				}
			}
			break
		}
		if len(node.children) > 0 && skip < len(words) && !strings.HasPrefix(words[skip], "-") {
			return lines[0] + "\n"
		}
		lines = append(lines, "skip\t"+strconv.Itoa(skip))
		for _, k := range node.children {
			lines = append(lines, "cmd\t"+k.word+"\t"+clean(k.description))
		}
	}
	var options []*option
	for n := node; n != nil; n = n.parent {
		options = append(options, n.options...)
	}
	for _, o := range options {
		short := "-"
		if o.short != "" {
			short = "-" + o.short
		}
		if o.kind == "flag" {
			lines = append(lines, "opt\t--"+o.long+"\t"+short+"\tflag\tnone\t-\t"+clean(o.description))
		} else {
			kind, values := completionKind(o.rule, o.searchDirs)
			lines = append(lines, "opt\t--"+o.long+"\t"+short+"\tvalue\t"+kind+"\t"+orDash(values)+"\t"+clean(o.description))
		}
		if o.boolLike() {
			lines = append(lines, "opt\t--no-"+o.long+"\t-\tflag\tnone\t-\t"+clean(o.description))
		}
	}
	for _, a := range node.args {
		kind, values := completionKind(a.rule, nil)
		arity := "single"
		if a.variadic {
			arity = "variadic"
		}
		lines = append(lines, "arg\t"+a.name+"\t"+arity+"\t"+kind+"\t"+orDash(values)+"\t"+clean(a.description))
	}
	return strings.Join(lines, "\n") + "\n"
}
