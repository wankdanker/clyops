package clyops

import (
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func newTestCli() *Cli {
	cli := New()
	cli.Name, cli.Env, cli.Cwd, cli.Root = "t", map[string]string{}, "/work", "/root"
	cli.Arg("file", "File", "", "path")
	cli.Opt("COUNT", "count", "n", "2", "Count", "", "int:1-5")
	cli.Opt("FAST", "fast", "f", "flag", "Fast")
	cli.OptArray("TAG", "tag", "t", "Tags")
	return cli
}

func TestParseReturnsTypedValues(t *testing.T) {
	cli := newTestCli()
	if r := cli.Parse([]string{"a.txt", "-fn", "4", "-t", "x", "--tag=y"}); r.Status != "ok" {
		t.Fatalf("status %q: %s", r.Status, r.Error)
	}
	v := cli.Values
	if v.String("file") != "/work/a.txt" || v.Int("COUNT") != 4 || !v.Bool("FAST") {
		t.Fatalf("values %#v", v)
	}
	if !reflect.DeepEqual(v.Strings("TAG"), []string{"x", "y"}) {
		t.Fatalf("TAG %#v", v["TAG"])
	}
	if !cli.IsSet("--fast") || cli.Source("count") != "cli" || cli.Source("nope") != "unset" {
		t.Fatal("sources")
	}
}

func TestParseReportsErrorsAndHelp(t *testing.T) {
	r := newTestCli().Parse([]string{"a", "--count", "9"})
	if r.Status != "error" || r.Error != "--count must be <= 5, got 9" {
		t.Fatalf("%#v", r)
	}
	if r := newTestCli().Parse([]string{"--help"}); r.Status != "help" {
		t.Fatalf("%#v", r)
	}
	if r := newTestCli().Parse([]string{"a", "--bogus"}); r.Error != "Unknown option: --bogus" {
		t.Fatalf("%#v", r)
	}
}

func TestRunExits(t *testing.T) {
	if os.Getenv("CLYOPS_TEST_RUN") == "1" {
		newTestCli().RunArgs([]string{"a", "--bogus"})
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestRunExits")
	cmd.Env = append(os.Environ(), "CLYOPS_TEST_RUN=1")
	out, err := cmd.CombinedOutput()
	exit, ok := err.(*exec.ExitError)
	if !ok || exit.ExitCode() != 1 || !strings.Contains(string(out), "Unknown option: --bogus") {
		t.Fatalf("err %v, output %s", err, out)
	}
}

func TestEnvironmentByVariableName(t *testing.T) {
	cli := New()
	cli.Env = map[string]string{"COUNT": "3"}
	cli.Opt("COUNT", "count", "", "1", "Count", "", "int")
	cli.Parse(nil)
	if cli.Values.Int("COUNT") != 3 || cli.Source("count") != "env" {
		t.Fatalf("%#v %s", cli.Values, cli.Source("count"))
	}
}

func TestRegistrationErrors(t *testing.T) {
	expectPanic := func(want string, fn func()) {
		t.Helper()
		defer func() {
			if r := recover(); r == nil || !strings.Contains(r.(string), want) {
				t.Fatalf("panic %v, want %q", r, want)
			}
		}()
		fn()
	}
	expectPanic("unknown validation rule 'nope' for --a", func() { New().Opt("A", "a", "", "", "A", "", "nope") })
	expectPanic("after a variadic", func() { New().ArgVariadic("r", "R").Arg("x", "X", "") })
	expectPanic("duplicate option --a", func() { New().Opt("A", "a", "", "", "A").Opt("B", "a", "", "", "B") })
}

func TestValidate(t *testing.T) {
	if v, err := Validate("ON", "bool", "v"); v != true || err != nil {
		t.Fatal(v, err)
	}
	if v, err := Validate("-2.5", "float:-3", "v"); v != -2.5 || err != nil {
		t.Fatal(v, err)
	}
	if _, err := Validate("abcd", "string:-3", "--s"); err == nil || err.Error() != "--s must be at most 3 characters, got 4" {
		t.Fatal(err)
	}
	if _, err := Validate("abc@example.com\n", "email", "e"); err == nil {
		t.Fatal("$ must not match before a trailing newline")
	}
	if v, err := Validate("héllo", "string:5", "s"); v != "héllo" || err != nil {
		t.Fatal("lengths count characters, not bytes:", err)
	}
	if DescribeRule("string:2-") != "text: >=2 chars" || DescribeRule("int:-9") != "integer: <=9" {
		t.Fatal(DescribeRule("string:2-"))
	}
}

func TestResolvePath(t *testing.T) {
	for _, c := range [][3]string{{"-", "/b", "-"}, {"s3://bucket/key", "/b", "s3://bucket/key"}, {"../x", "/b/c", "/b/x"}, {"x", "/b", "/b/x"}} {
		if got := ResolvePath(c[0], c[1], nil); got != c[2] {
			t.Errorf("ResolvePath(%q, %q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestWrapText(t *testing.T) {
	got := WrapText("aa bb cc\n\nsupercalifragilistic dd", 5)
	want := []string{"aa bb", "cc", "", "supercalifragilistic", "dd"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
}

func TestJSONOutputs(t *testing.T) {
	cli := newTestCli()
	cli.SetDescription("Uses <angle> & ampersands")
	cli.Parse([]string{"a"})
	var values map[string]any
	if err := json.Unmarshal([]byte(cli.ValuesJSON()), &values); err != nil {
		t.Fatal(err)
	}
	if values["COUNT"] != 2.0 || values["FAST"] != false || len(values["TAG"].([]any)) != 0 {
		t.Fatalf("%#v", values)
	}
	if !strings.HasPrefix(cli.ValuesJSON(), "{\n  \"COUNT\": 2,") {
		t.Fatalf("values keep registration order: %s", cli.ValuesJSON())
	}
	schema := cli.JSONSchema()
	if !strings.Contains(schema, `"description": "Uses <angle> & ampersands"`) || !strings.Contains(schema, `"requiredCommands": []`) {
		t.Fatalf("schema: %s", schema)
	}
	if _, ok := cli.CompletionScript("powershell"); ok {
		t.Fatal("unknown shell")
	}
	if s, _ := cli.CompletionScript("bash"); !strings.Contains(s, "complete -F _clyops_t t") && !strings.Contains(s, "_clyops_t") {
		t.Fatal(s)
	}
}

func mustPanic(t *testing.T, want string, fn func()) {
	t.Helper()
	defer func() {
		if r := recover(); r == nil || !strings.Contains(r.(string), want) {
			t.Fatalf("panic %v, want %q", r, want)
		}
	}()
	fn()
}

func TestNewRegistrationErrors(t *testing.T) {
	mustPanic(t, "unknown effect 'sideways'", func() { New().SetEffects("sideways") })
	mustPanic(t, "unknown option --b in constraint", func() { New().Opt("A", "a", "", "flag", "A").Exclusive("a", "b") })
	mustPanic(t, "cannot mix commands and positional arguments", func() { New().Arg("x", "X", "").Command("c", "C") })
}

func TestSecretValuesAreMasked(t *testing.T) {
	cli := New()
	cli.Name, cli.Env = "t", map[string]string{}
	cli.Opt("TOKEN", "token", "", "", "Token", "Auth", "secret:string:3-")
	if r := cli.Parse([]string{"--token", "abcd"}); r.Status != "ok" {
		t.Fatal(r.Error)
	}
	var values map[string]any
	_ = json.Unmarshal([]byte(cli.ValuesJSON()), &values)
	if cli.Values.String("TOKEN") != "abcd" || values["TOKEN"] != "***" {
		t.Fatalf("values %v / %v", cli.Values, values)
	}
	var schema struct {
		Options []struct {
			Secret     bool
			Validation string
		}
	}
	_ = json.Unmarshal([]byte(cli.JSONSchema()), &schema)
	if !schema.Options[0].Secret || schema.Options[0].Validation != "string:3-" {
		t.Fatalf("schema %+v", schema)
	}
}

func TestRelationships(t *testing.T) {
	make2 := func(env map[string]string) *Cli {
		cli := New()
		cli.Name, cli.Env = "t", env
		cli.Opt("A", "a", "a", "flag", "A").Opt("B", "b", "b", "flag", "B").Opt("C", "c", "c", "optional", "C")
		return cli.Exclusive("a", "b").Requires("c", "a").OneOf("a", "b", "c")
	}
	none := map[string]string{}
	for _, tc := range []struct {
		env  map[string]string
		argv []string
		want string
	}{
		{none, []string{"-a", "-b"}, "Options --a and --b cannot be used together"},
		{none, []string{"-a", "--no-b"}, ""},
		{none, []string{"-c", "x"}, "Option --c requires --a"},
		{map[string]string{"A": "true"}, []string{"-c", "x"}, ""},
		{none, nil, "One of --a, --b, --c is required"},
	} {
		if r := make2(tc.env).Parse(tc.argv); r.Error != tc.want {
			t.Errorf("%v: %q, want %q", tc.argv, r.Error, tc.want)
		}
	}
}

func TestCommands(t *testing.T) {
	cli := New()
	cli.Name, cli.Env = "m", map[string]string{}
	cli.Opt("CONFIG", "config", "c", "optional", "Config", "Global")
	migrate := cli.Command("db", "Database").Command("migrate", "Migrate")
	migrate.Opt("TO", "to", "", "optional", "Target", "Options", "int")
	migrate.Arg("name", "Name", "all")
	if r := cli.Parse([]string{"db", "-c", "x", "migrate", "--to", "3"}); r.Status != "ok" {
		t.Fatal(r.Error)
	}
	if !reflect.DeepEqual(cli.CommandPath(), []string{"db", "migrate"}) || cli.Values.Int("TO") != 3 || cli.Values.String("CONFIG") != "x" {
		t.Fatalf("values %v", cli.Values)
	}
	for argv, want := range map[string]string{"--to 3 db migrate": "Unknown option: --to", "db": "Missing command", "db seed": "Unknown command: seed"} {
		if r := cli.Parse(strings.Fields(argv)); r.Error != want {
			t.Errorf("%s: %q, want %q", argv, r.Error, want)
		}
	}
	if r := cli.Parse([]string{"db", "migrate", "-h"}); r.Status != "help" || !strings.HasPrefix(cli.Usage(), "Usage: m db migrate [<name>] [OPTIONS]") {
		t.Fatal(cli.Usage())
	}
}
