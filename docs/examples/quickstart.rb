require "clyops"

cli = Clyops::Cli.new(name: "docs-demo")
cli.opt "NAME", "name", "n", "World", "Who to greet"
cli.opt "COUNT", "count", "c", "1", "Repeat count", "Options", "int:1-3"
cli.opt "VERBOSE", "verbose", "v", "flag", "Verbose output"
args = cli.run
puts "#{args.NAME} #{args.COUNT} #{args.VERBOSE}"
