# clyops (Python)

One-line-per-option CLI parsing with validation, help text, JSON schema, config files and shell
completion. Pure standard library, Python 3.8+. See the [main README](https://github.com/wankdanker/clyops).

```python
from clyops import Cli

cli = Cli()
cli.arg("input", "Input file", "", "path")
cli.opt("PORT", "port", "p", "8080", "Server port", "Network", "port")
cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
args = cli.run()
print(args.input, args.PORT, args.VERBOSE)
```
