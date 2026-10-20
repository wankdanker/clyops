import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
from clyops import Cli, ValidationError, describe_rule, resolve_path, validate, wrap_text  # noqa: E402


def make():
    cli = Cli(name="t", env={}, cwd="/work", root="/root")
    cli.arg("file", "File", rule="path")
    cli.opt("COUNT", "count", "n", "2", "Count", rule="int:1-5")
    cli.opt("FAST", "fast", "f", "flag", "Fast")
    cli.opt_array("TAG", "tag", "t", "Tags")
    return cli


class CliTest(unittest.TestCase):
    def test_parse_returns_typed_values(self):
        cli = make()
        self.assertEqual(cli.parse(["a.txt", "-fn", "4", "-t", "x", "--tag=y"]).status, "ok")
        self.assertEqual(cli.values.file, "/work/a.txt")
        self.assertEqual(cli.values.COUNT, 4)
        self.assertIs(cli.values.FAST, True)
        self.assertEqual(cli.values.TAG, ["x", "y"])
        self.assertTrue(cli.is_set("--fast"))
        self.assertEqual(cli.source("count"), "cli")

    def test_parse_reports_errors_and_help(self):
        result = make().parse(["a", "--count", "9"])
        self.assertEqual((result.status, result.error), ("error", "--count must be <= 5, got 9"))
        self.assertEqual(make().parse(["--help"]).status, "help")

    def test_run_exits(self):
        with self.assertRaises(SystemExit) as ctx:
            make().run(["a", "--bogus"])
        self.assertEqual(ctx.exception.code, 1)

    def test_environment_by_variable_name(self):
        cli = Cli(name="t", env={"COUNT": "3"}).opt("COUNT", "count", "", "1", "Count", rule="int")
        cli.parse([])
        self.assertEqual((cli.values.COUNT, cli.source("count")), (3, "env"))

    def test_registration_errors(self):
        with self.assertRaisesRegex(ValueError, "Unknown validation rule 'nope' for --a"):
            Cli().opt("A", "a", "", "", "A", rule="nope")
        with self.assertRaisesRegex(ValueError, "after a variadic"):
            Cli().arg_variadic("r", "R").arg("x", "X")

    def test_validate(self):
        self.assertIs(validate("ON", "bool", "v"), True)
        self.assertEqual(validate("-2.5", "float:-3", "v"), -2.5)
        with self.assertRaisesRegex(ValidationError, "--s must be at most 3 characters, got 4"):
            validate("abcd", "string:-3", "--s")
        # $ must not match before a trailing newline
        with self.assertRaises(ValidationError):
            validate("abc@example.com\n", "email", "e")
        self.assertEqual(describe_rule("string:2-"), "text: >=2 chars")

    def test_resolve_path(self):
        self.assertEqual(resolve_path("-", "/b"), "-")
        self.assertEqual(resolve_path("s3://bucket/key", "/b"), "s3://bucket/key")
        self.assertEqual(resolve_path("../x", "/b/c"), "/b/x")

    def test_wrap_text(self):
        self.assertEqual(wrap_text("aa bb cc\n\nsupercalifragilistic dd", 5),
                         ["aa bb", "cc", "", "supercalifragilistic", "dd"])

    def test_new_registration_errors(self):
        with self.assertRaisesRegex(ValueError, "Unknown effect 'sideways'"):
            Cli(name="t").set_effects("sideways")
        with self.assertRaisesRegex(ValueError, "Unknown option --b in constraint"):
            Cli(name="t").opt("A", "a", "", "flag", "A").exclusive("a", "b")
        with self.assertRaisesRegex(ValueError, "Cannot mix commands and positional arguments"):
            Cli(name="t").arg("x", "X").command("c", "C")

    def test_secret_values_are_masked(self):
        cli = Cli(name="t", env={})
        cli.opt("TOKEN", "token", "", "", "Token", "Auth", "secret:string:3-")
        self.assertEqual(cli.parse(["--token", "abcd"]).status, "ok")
        self.assertEqual(cli.values.TOKEN, "abcd")
        self.assertEqual(json.loads(cli.values_json())["TOKEN"], "***")
        schema = json.loads(cli.json_schema())
        self.assertTrue(schema["options"][0]["secret"])
        self.assertEqual(schema["options"][0]["validation"], "string:3-")

    def test_relationships(self):
        def make2(env=None):
            cli = Cli(name="t", env=env or {})
            cli.opt("A", "a", "a", "flag", "A").opt("B", "b", "b", "flag", "B").opt("C", "c", "c", "optional", "C")
            return cli.exclusive("a", "b").requires("c", "a").one_of("a", "b", "c")
        self.assertEqual(make2().parse(["-a", "-b"]).error, "Options --a and --b cannot be used together")
        self.assertEqual(make2().parse(["-a", "--no-b"]).status, "ok")
        self.assertEqual(make2().parse(["-c", "x"]).error, "Option --c requires --a")
        self.assertEqual(make2({"A": "true"}).parse(["-c", "x"]).status, "ok")
        self.assertEqual(make2().parse([]).error, "One of --a, --b, --c is required")

    def test_commands(self):
        cli = Cli(name="m", env={})
        cli.opt("CONFIG", "config", "c", "optional", "Config", "Global")
        migrate = cli.command("db", "Database").command("migrate", "Migrate")
        migrate.opt("TO", "to", "", "optional", "Target", "Options", "int")
        migrate.arg("name", "Name", "all")
        self.assertEqual(cli.parse(["db", "-c", "x", "migrate", "--to", "3"]).status, "ok")
        self.assertEqual(cli.command_path, ["db", "migrate"])
        self.assertEqual(cli.values.command, ["db", "migrate"])
        self.assertEqual(cli.values.TO, 3)
        self.assertEqual(cli.values.CONFIG, "x")
        self.assertEqual(cli.parse(["--to", "3", "db", "migrate"]).error, "Unknown option: --to")
        self.assertEqual(cli.parse(["db"]).error, "Missing command")
        self.assertEqual(cli.parse(["db", "seed"]).error, "Unknown command: seed")
        self.assertEqual(cli.parse(["db", "migrate", "-h"]).status, "help")
        self.assertTrue(cli.usage().startswith("Usage: m db migrate [<name>] [OPTIONS]"))
        schema = json.loads(cli.json_schema())
        self.assertEqual(schema["commands"][0]["commands"][0]["options"][0]["name"], "to")

    def test_role_registration_errors(self):
        def cli():
            return Cli(name="t", env={})
        for build, message in [
            (lambda: cli().role("7up", "out", "X"), "Invalid role name '7up'"),
            (lambda: cli().role("a:b", "out", "X"), "Invalid role name 'a:b'"),
            (lambda: cli().role("log", "both", "X"), "Unknown role direction 'both'"),
            (lambda: cli().role("log", "out", "X").role("log", "in", "Y"), "Duplicate role 'log'"),
        ]:
            with self.assertRaisesRegex(ValueError, message):
                build()
        cli().role("progress", "out", "X").role("my.role-2_x", "in", "Y")

    def test_role_schema_dict_or_text(self):
        cli = Cli(name="t", env={}).role("meta", "out", "A", "application/json", {"type": "object"})
        cli.role("extra", "in", "B", schema='{"type":"string"}')
        self.assertEqual(json.loads(cli.json_schema())["roles"], [
            {"name": "meta", "direction": "out", "description": "A", "contentType": "application/json",
             "schema": {"type": "object"}},
            {"name": "extra", "direction": "in", "description": "B", "contentType": "", "schema": {"type": "string"}},
        ])

    def test_role_emit_and_forward_follow_the_mapping(self):
        import tempfile
        with tempfile.TemporaryFile("w+") as fh:
            fd = fh.fileno()

            def make(env):
                c = Cli(name="t", env=env).role("progress", "out", "Progress").role("extra", "in", "Extra")
                self.assertEqual(c.parse([]).status, "ok")
                return c
            unmapped = make({})
            self.assertIsNone(unmapped.fd_open("progress"))
            unmapped.emit("progress", {"pct": 1})
            self.assertEqual(unmapped.forward_fds("progress"), "")
            cli = make({"CLYOPS_FDS": f"progress:{fd}, extra:999, log:{fd}"})
            self.assertEqual(cli.fd_open("progress"), fd)
            self.assertIsNone(cli.fd_open("extra"))
            self.assertIsNone(cli.fd_open("log"))
            cli.emit("progress", {"pct": 50})
            cli.emit("progress", "plain text")
            cli.emit("progress", "ends with newline\n")
            self.assertEqual(cli.forward_fds("progress", "extra", "log", "nope"), f"progress:{fd},log:{fd}")
            with self.assertRaisesRegex(ValueError, "Unknown role 'nope'"):
                cli.emit("nope", "x")
            with self.assertRaisesRegex(ValueError, "Role 'extra' is not an output"):
                cli.emit("extra", "x")
            fh.seek(0)
            self.assertEqual(fh.read(), '{"pct":50}\nplain text\nends with newline\n')

    def test_role_mapping_is_read_once_and_removed(self):
        os.environ["CLYOPS_FDS"] = "progress:2"
        cli = Cli(name="t").role("progress", "out", "Progress")
        cli.parse([])
        self.assertNotIn("CLYOPS_FDS", os.environ)
        cli.parse([])
        self.assertEqual(cli.fd_open("progress"), 2)
        os.environ["CLYOPS_FDS"] = "other:5"
        Cli(name="t", env={"CLYOPS_FDS": "progress:2"}).parse([])
        self.assertEqual(os.environ.pop("CLYOPS_FDS"), "other:5")

    def test_role_scope_and_help(self):
        cli = Cli(name="m", env={"CLYOPS_FDS": "progress:2,plan:2"}).role("progress", "out", "Progress")
        db = cli.command("db", "Database")
        db.command("migrate", "Migrate").role("plan", "out", "Migration plan")
        db.command("status", "Status")
        cli.parse(["db", "status"])
        self.assertEqual(cli.fd_open("progress"), 2)
        self.assertIsNone(cli.fd_open("plan"))
        cli.parse(["db", "migrate"])
        self.assertEqual(cli.fd_open("plan"), 2)
        self.assertIn("\nOutput [plan]: Migration plan\n", cli.usage())
        self.assertNotIn("[progress]", cli.usage())

if __name__ == "__main__":
    unittest.main()
