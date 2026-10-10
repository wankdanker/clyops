import io.github.wankdanker.clyops.Cli;
import io.github.wankdanker.clyops.Values;

public class DocsDemo {
    public static void main(String[] argv) {
        Cli cli = new Cli("docs-demo");
        cli.opt("NAME", "name", "n", "World", "Who to greet");
        cli.opt("COUNT", "count", "c", "1", "Repeat count", "Options", "int:1-3");
        cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output");
        Values args = cli.run(argv);
        System.out.printf("%s %d %s%n", args.getString("NAME"), args.getInt("COUNT"), args.getBool("VERBOSE"));
    }
}
