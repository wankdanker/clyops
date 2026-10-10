"""Checked by mypy against an installed wheel rather than repository sources."""
from clyops import Cli, Values

cli = Cli(name="consumer")
cli.opt("COUNT", "count", "c", "1", "Count", rule="int")
values: Values = cli.run([])
count = values["COUNT"]
if isinstance(count, int):
    print(count + 1)
outcome = cli.parse(["--count", "2"])
assert outcome.status == "ok"
