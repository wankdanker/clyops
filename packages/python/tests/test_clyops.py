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


if __name__ == "__main__":
    unittest.main()
