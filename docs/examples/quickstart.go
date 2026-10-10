package main

import (
	"fmt"
	"github.com/wankdanker/clyops/packages/go"
)

func main() {
	cli := clyops.New()
	cli.Name = "docs-demo"
	cli.Opt("NAME", "name", "n", "World", "Who to greet")
	cli.Opt("COUNT", "count", "c", "1", "Repeat count", "Options", "int:1-3")
	cli.Opt("VERBOSE", "verbose", "v", "flag", "Verbose output")
	args := cli.Run()
	fmt.Printf("%s %d %t\n", args.String("NAME"), args.Int("COUNT"), args.Bool("VERBOSE"))
}
