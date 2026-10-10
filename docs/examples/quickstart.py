from clyops import Cli

cli = Cli(name="docs-demo")
cli.opt("NAME", "name", "n", "World", "Who to greet")
cli.opt("COUNT", "count", "c", "1", "Repeat count", rule="int:1-3")
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
args = cli.run()
print(f"{args.NAME} {args.COUNT} {str(args.VERBOSE).lower()}")
