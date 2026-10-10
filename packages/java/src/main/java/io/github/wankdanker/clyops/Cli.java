package io.github.wankdanker.clyops;

import java.io.File;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

/**
 * Declarative, one-line-per-option CLI parsing: validation, help text, a JSON schema of the
 * interface, config files, environment variables and shell completion. Behavior follows
 * spec/SPEC.md in https://github.com/wankdanker/clyops.
 *
 * <pre>{@code
 * Cli cli = new Cli("mytool");
 * cli.arg("input", "Input file", "", "path");
 * cli.opt("PORT", "port", "p", "8080", "Server port", "Network", "port");
 * cli.opt("VERBOSE", "verbose", "v", "flag", "Verbose output");
 * Values v = cli.run(args);
 * System.out.println(v.getString("input") + " " + v.getInt("PORT") + " " + v.getBool("VERBOSE"));
 * }</pre>
 */
public class Cli {
    /** The clyops version this library implements. */
    public static final String VERSION = "0.3.0";

    // -----------------------------------------------------------------------
    // Rules
    // -----------------------------------------------------------------------

    private static final Map<String, String> FIXED_RULES = Map.ofEntries(
        Map.entry("int", "integer"), Map.entry("float", "number"), Map.entry("string", "text"),
        Map.entry("path", "path"), Map.entry("ip", "IP address"), Map.entry("hostname", "hostname"),
        Map.entry("url", "URL"), Map.entry("port", "port: 1-65535"), Map.entry("email", "email address"),
        Map.entry("uuid", "UUID"), Map.entry("bool", "true/false, yes/no, 1/0, on/off"),
        Map.entry("date:YYYY-MM-DD", "date: YYYY-MM-DD"), Map.entry("file:exists", "existing file"),
        Map.entry("file:readable", "readable file"), Map.entry("file:writable", "writable file"),
        Map.entry("dir:exists", "existing directory"), Map.entry("dir:writable", "writable directory"));

    private static final Pattern INT_RULE = Pattern.compile("int:(\\d+-\\d*|-\\d+)");
    private static final Pattern FLOAT_RULE = Pattern.compile("float:(\\d*\\.?\\d+-(\\d*\\.?\\d+)?|-\\d*\\.?\\d+)");
    private static final Pattern STRING_RULE = Pattern.compile("string:(\\d+|\\d+-\\d*|-\\d+)");
    private static final Pattern INT = Pattern.compile("-?[0-9]+");
    private static final Pattern FLOAT = Pattern.compile("-?[0-9]*\\.?[0-9]+");
    private static final Pattern DIGITS = Pattern.compile("[0-9]+");
    private static final Pattern IPV4 = Pattern.compile("([0-9]{1,3}\\.){3}[0-9]{1,3}");
    private static final Pattern IPV6 = Pattern.compile("([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}");
    private static final Pattern HOSTNAME = Pattern.compile(
        "[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*");
    private static final Pattern URL = Pattern.compile("https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?", Pattern.DOTALL);
    private static final Pattern EMAIL = Pattern.compile("[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}");
    private static final Pattern UUID = Pattern.compile(
        "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}");
    private static final Pattern DATE = Pattern.compile("[0-9]{4}-[0-9]{2}-[0-9]{2}");
    private static final Pattern SCHEME = Pattern.compile("^[A-Za-z][A-Za-z0-9+.-]+:");
    private static final Pattern DOT_RELATIVE = Pattern.compile("^\\.\\.?(/|$)");
    private static final Pattern INCLUDE = Pattern.compile("\\s*@include\\s+(.+)");

    static Boolean boolWord(String value) {
        return switch (value.toLowerCase()) {
            case "true", "yes", "1", "on" -> Boolean.TRUE;
            case "false", "no", "0", "off" -> Boolean.FALSE;
            default -> null;
        };
    }

    static boolean knownRule(String rule) {
        if (rule.isEmpty() || FIXED_RULES.containsKey(rule)) return true;
        if (INT_RULE.matcher(rule).matches() || FLOAT_RULE.matcher(rule).matches() || STRING_RULE.matcher(rule).matches()) return true;
        if (rule.startsWith("choice:") && rule.length() > 7) return true;
        if (rule.startsWith("regex:") && rule.length() > 6) {
            try {
                Pattern.compile(rule.substring(6));
                return true;
            } catch (PatternSyntaxException e) {
                return false;
            }
        }
        return false;
    }

    private static String[] bounds(String rule) {
        String range = rule.substring(rule.indexOf(':') + 1);
        int dash = range.indexOf('-');
        return new String[] {range.substring(0, dash), range.substring(dash + 1)};
    }

    static boolean isPathRule(String rule) {
        return rule.equals("path") || rule.startsWith("file:") || rule.startsWith("dir:");
    }

    private static List<String> splitAll(String s, String sep) {
        return Arrays.asList(s.split(Pattern.quote(sep), -1));
    }

    /** Help text for a validation rule (spec section 5). */
    public static String describeRule(String rule) {
        if (FIXED_RULES.containsKey(rule)) return FIXED_RULES.get(rule);
        String[][] prefixes = {{"int:", "integer", ""}, {"float:", "number", ""}, {"string:", "text", " chars"}};
        for (String[] p : prefixes) {
            if (!rule.startsWith(p[0])) continue;
            if (!rule.contains("-")) return p[1] + ": " + rule.substring(p[0].length()) + p[2];
            String[] b = bounds(rule);
            if (!b[0].isEmpty() && !b[1].isEmpty()) return p[1] + ": " + b[0] + "-" + b[1] + p[2];
            return b[0].isEmpty() ? p[1] + ": <=" + b[1] + p[2] : p[1] + ": >=" + b[0] + p[2];
        }
        if (rule.startsWith("choice:")) return "choices: " + String.join(", ", splitAll(rule.substring(7), ","));
        if (rule.startsWith("regex:")) return "pattern: " + rule.substring(6);
        return rule;
    }

    private static int length(String s) { return s.codePointCount(0, s.length()); }

    private static double number(String s) { return Double.parseDouble(s.startsWith(".") ? "0" + s : s); }

    /**
     * Validate {@code value} against {@code rule} and return its typed form: Long for int* and
     * port (BigInteger beyond a long), Double for float*, Boolean for bool, the String otherwise.
     *
     * @throws ValidationError with the spec's error text
     */
    public static Object validate(String value, String rule, String name) {
        if (rule.equals("int") || rule.startsWith("int:")) {
            if (!INT.matcher(value).matches()) throw fail(name, "must be an integer, got '" + value + "'");
            // Integers beyond a long stay exact, as BigInteger.
            BigInteger big = new BigInteger(value);
            if (!rule.equals("int")) checkBounds(big.doubleValue(), value, rule, name);
            return big.bitLength() < 64 ? (Object) big.longValue() : big;
        }
        if (rule.equals("float") || rule.startsWith("float:")) {
            if (!FLOAT.matcher(value).matches()) throw fail(name, "must be a number, got '" + value + "'");
            double f = Double.parseDouble(value.replaceFirst("^(-?)\\.", "$10."));
            if (!rule.equals("float")) checkBounds(f, value, rule, name);
            return f;
        }
        if (rule.startsWith("string:")) {
            int len = length(value);
            if (!rule.contains("-")) {
                if (len != Integer.parseInt(rule.substring(7))) {
                    throw fail(name, "must be exactly " + rule.substring(7) + " characters, got " + len);
                }
            } else {
                String[] b = bounds(rule);
                if (!b[0].isEmpty() && len < Integer.parseInt(b[0])) throw fail(name, "must be at least " + b[0] + " characters, got " + len);
                if (!b[1].isEmpty() && len > Integer.parseInt(b[1])) throw fail(name, "must be at most " + b[1] + " characters, got " + len);
            }
            return value;
        }
        if (rule.startsWith("choice:")) {
            List<String> choices = splitAll(rule.substring(7), ",");
            if (!choices.contains(value)) throw fail(name, "must be one of: " + String.join(", ", choices) + ", got '" + value + "'");
            return value;
        }
        if (rule.startsWith("regex:")) {
            if (!Pattern.compile(rule.substring(6)).matcher(value).find()) {
                throw fail(name, "does not match required pattern, got '" + value + "'");
            }
            return value;
        }
        switch (rule) {
            case "bool" -> {
                Boolean b = boolWord(value);
                if (b == null) throw fail(name, "must be a boolean (true/false, yes/no, 1/0, on/off), got '" + value + "'");
                return b;
            }
            case "port" -> {
                if (!DIGITS.matcher(value).matches() || value.length() > 5 || Long.parseLong(value) < 1 || Long.parseLong(value) > 65535) {
                    throw fail(name, "must be a valid port (1-65535), got '" + value + "'");
                }
                return Long.parseLong(value);
            }
            case "ip" -> {
                if (!IPV4.matcher(value).matches() && !IPV6.matcher(value).matches()) throw fail(name, "must be a valid IP address, got '" + value + "'");
            }
            case "hostname" -> {
                if (!HOSTNAME.matcher(value).matches()) throw fail(name, "must be a valid hostname, got '" + value + "'");
            }
            case "url" -> {
                if (!URL.matcher(value).matches()) throw fail(name, "must be a valid URL, got '" + value + "'");
            }
            case "email" -> {
                if (!EMAIL.matcher(value).matches()) throw fail(name, "must be a valid email address, got '" + value + "'");
            }
            case "uuid" -> {
                if (!UUID.matcher(value).matches()) throw fail(name, "must be a valid UUID, got '" + value + "'");
            }
            case "date:YYYY-MM-DD" -> {
                if (!DATE.matcher(value).matches()) throw fail(name, "must be in YYYY-MM-DD format, got '" + value + "'");
            }
            case "file:exists" -> {
                if (!Files.isRegularFile(Paths.get(value))) throw fail(name, "file does not exist: " + value);
            }
            case "file:readable" -> {
                if (!Files.isReadable(Paths.get(value))) throw fail(name, "file is not readable: " + value);
            }
            case "file:writable" -> {
                Path p = Paths.get(value);
                if (Files.exists(p, LinkOption.NOFOLLOW_LINKS)) {
                    if (!Files.isWritable(p)) throw fail(name, "file is not writable: " + value);
                } else {
                    String dir = parent(value);
                    if (!Files.isDirectory(Paths.get(dir)) || !Files.isWritable(Paths.get(dir))) throw fail(name, "directory is not writable: " + dir);
                }
            }
            case "dir:exists" -> {
                if (!Files.isDirectory(Paths.get(value))) throw fail(name, "directory does not exist: " + value);
            }
            case "dir:writable" -> {
                if (!Files.isDirectory(Paths.get(value)) || !Files.isWritable(Paths.get(value))) {
                    throw fail(name, "directory does not exist or is not writable: " + value);
                }
            }
            default -> { }
        }
        return value;
    }

    private static ValidationError fail(String name, String msg) { return new ValidationError(name + " " + msg); }

    private static void checkBounds(double num, String value, String rule, String name) {
        String[] b = bounds(rule);
        if (!b[0].isEmpty() && num < number(b[0])) throw fail(name, "must be >= " + b[0] + ", got " + value);
        if (!b[1].isEmpty() && num > number(b[1])) throw fail(name, "must be <= " + b[1] + ", got " + value);
    }

    /** Like Python's os.path.dirname. */
    private static String parent(String path) {
        int slash = path.lastIndexOf('/');
        if (slash < 0) return "";
        String head = path.substring(0, slash + 1);
        return head.matches("/+") ? head : head.replaceAll("/+$", "");
    }

    /** Join and normalize like Python's os.path.normpath(os.path.join(base, value)). */
    static String normpath(String base, String value) {
        return Paths.get(base).resolve(value).normalize().toString();
    }

    /** Resolve a path value against {@code base} (spec section 6), trying {@code searchDirs} for bare names. */
    public static String resolvePath(String value, String base, List<String> searchDirs) {
        if (value.isEmpty() || value.equals("-") || value.equals("disabled") || value.equals("optional")) return value;
        if (value.startsWith("/") || SCHEME.matcher(value).find()) return value;
        String fromBase = normpath(base, value);
        if (!DOT_RELATIVE.matcher(value).find() && !searchDirs.isEmpty() && !Files.exists(Paths.get(fromBase))) {
            for (String dir : searchDirs) {
                String candidate = normpath(dir, value);
                if (Files.exists(Paths.get(candidate))) return candidate;
            }
        }
        return fromBase;
    }

    /** Greedy word wrap that keeps existing line breaks (spec section 7). */
    public static List<String> wrapText(String text, int width) {
        List<String> out = new ArrayList<>();
        for (String original : text.split("\r?\n", -1)) {
            String trimmed = original.strip();
            if (trimmed.isEmpty()) {
                out.add("");
                continue;
            }
            String line = "";
            for (String word : trimmed.split("\\s+")) {
                if (line.isEmpty()) {
                    line = word;
                } else if (length(line) + 1 + length(word) <= width) {
                    line += " " + word;
                } else {
                    out.add(line);
                    line = word;
                }
            }
            out.add(line);
        }
        return out;
    }

    private static String[] completionKind(String rule, List<String> searchDirs) {
        if (rule.equals("path") || rule.startsWith("file:")) return new String[] {"file", String.join(":", searchDirs)};
        if (rule.startsWith("dir:")) return new String[] {"dir", String.join(":", searchDirs)};
        if (rule.startsWith("choice:")) return new String[] {"choice", rule.substring(7)};
        if (rule.equals("bool")) return new String[] {"choice", "true,false"};
        if (rule.equals("hostname") || rule.equals("ip")) return new String[] {"host", ""};
        return new String[] {rule.isEmpty() ? "default" : "none", ""};
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    private static final class Option {
        final String var, lng, shrt, kind, def, description, group;
        final boolean required;
        String rule;
        List<String> searchDirs = List.of();
        boolean secret;

        Option(String var, String lng, String shrt, String kind, String def, boolean required, String description, String group, String rule) {
            this.var = var; this.lng = lng; this.shrt = shrt; this.kind = kind; this.def = def;
            this.required = required; this.description = description; this.group = group; this.rule = rule;
        }

        String label() {
            String head = shrt.isEmpty() ? "    --" + lng : "-" + shrt + ", --" + lng;
            return kind.equals("flag") ? head : head + "=<value>";
        }

        boolean boolLike() {
            return kind.equals("flag") || rule.equals("bool") || rule.equals("choice:true,false") || rule.equals("choice:false,true");
        }
    }

    private record Argument(String name, String description, String def, String rule, boolean variadic) {}

    private record Command(String name, String description, String hint) {}

    private record ConfigValue(String value, String dir) {}

    private static final class ParseError extends RuntimeException {
        ParseError(String message) { super(message); }
    }

    private String name;
    private String cwd = System.getProperty("user.dir");
    private String root;
    private Map<String, String> env = System.getenv();
    private String description = "";
    private String epilog = "";
    private Values values = new Values();
    private final List<Option> options = new ArrayList<>();
    private final Map<String, Option> byLong = new HashMap<>();
    private final Map<String, Option> byShort = new HashMap<>();
    private final List<Argument> args = new ArrayList<>();
    private final List<Command> commands = new ArrayList<>();
    private String configOption = "";
    private List<String> configPrefixes = List.of();
    private Map<String, List<String>> raw = new HashMap<>();
    private Map<String, List<String>> argRaw = new HashMap<>();
    private Map<String, String> sources = new HashMap<>();
    private Map<String, ConfigValue> config = new LinkedHashMap<>();
    private List<String> effects = List.of();
    private Map<String, Object> stdin;
    private Map<String, Object> stdout;
    private final List<Map<String, Object>> constraints = new ArrayList<>();
    private final List<Cli> children = new ArrayList<>();
    private Cli parent;
    private String word = "";
    // The command selected by the last parse (this one when it has no commands).
    private Cli selected = this;

    /** A Cli for the program {@code name}, shown in help and used for completion. */
    public Cli(String name) {
        this.name = name;
        this.root = cwd;
    }

    /** Base for default path values (default: the working directory); relative to the working directory. */
    public Cli setRoot(String root) {
        this.root = normpath(cwd, root == null || root.isEmpty() ? "." : root);
        return this;
    }

    /** Base for command-line path values (default: the working directory). Resets the root to it. */
    public Cli setCwd(String cwd) {
        this.cwd = cwd;
        this.root = cwd;
        return this;
    }

    /** The environment to read (default: the process environment). */
    public Cli setEnv(Map<String, String> env) {
        this.env = env;
        return this;
    }

    public Cli setDescription(String text) {
        this.description = text;
        return this;
    }

    public Cli setEpilog(String text) {
        this.epilog = text;
        return this;
    }

    /** What running the program does: read-only, idempotent, destructive, network. */
    public Cli setEffects(String... effects) {
        for (String e : effects) {
            if (!List.of("read-only", "idempotent", "destructive", "network").contains(e)) {
                throw new IllegalArgumentException("Unknown effect '" + e + "'");
            }
        }
        this.effects = List.of(effects);
        return this;
    }

    /** What the program reads on stdin; {@code contentType} is a MIME type or a comma-separated list. */
    public Cli setStdin(String description, String contentType) {
        this.stdin = stream(description, contentType);
        return this;
    }

    /** What the program writes on stdout; undeclared means text. */
    public Cli setStdout(String description, String contentType) {
        this.stdout = stream(description, contentType);
        return this;
    }

    private static Map<String, Object> stream(String description, String contentType) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("description", description);
        m.put("contentType", contentType);
        return m;
    }

    /** At most one of these options may be given. */
    public Cli exclusive(String... lngs) { return addConstraint("exclusive", List.of(lngs)); }

    /** When {@code lng} is given, the others must be too. */
    public Cli requires(String lng, String... lngs) {
        List<String> all = new ArrayList<>(List.of(lng));
        all.addAll(List.of(lngs));
        return addConstraint("requires", all);
    }

    /** At least one of these options must be given. */
    public Cli oneOf(String... lngs) { return addConstraint("oneOf", List.of(lngs)); }

    private Cli addConstraint(String type, List<String> lngs) {
        for (String l : lngs) {
            if (findOption(l, false) == null) throw new IllegalArgumentException("Unknown option --" + l + " in constraint");
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        m.put("options", List.copyOf(lngs));
        constraints.add(m);
        return this;
    }

    /** Register a command (spec section 1.7) and return it, to register its options and arguments on. */
    public Cli command(String word, String description) {
        if (!args.isEmpty()) throw new IllegalArgumentException("Cannot mix commands and positional arguments");
        for (Cli c : children) if (c.word.equals(word)) throw new IllegalArgumentException("Duplicate command " + word);
        Cli child = new Cli(name + " " + word);
        child.cwd = cwd;
        child.root = root;
        child.env = env;
        child.description = description;
        child.parent = this;
        child.word = word;
        children.add(child);
        return child;
    }

    /** The command words selected by the last parse, e.g. [db, migrate]. */
    public List<String> commandPath() {
        List<String> words = new ArrayList<>();
        for (Cli node = selected; node != null && node != this; node = node.parent) words.add(0, node.word);
        return words;
    }

    /** The selected command, its parent, ... up to this one. */
    private List<Cli> chain() {
        List<Cli> out = new ArrayList<>();
        for (Cli node = selected; node != null; node = node == this ? null : node.parent) out.add(node);
        return out;
    }

    private List<Option> chainOptions() {
        List<Option> out = new ArrayList<>();
        for (Cli n : chain()) out.addAll(n.options);
        return out;
    }

    /** From the program down. */
    private List<Cli> chainDown() {
        List<Cli> out = chain();
        Collections.reverse(out);
        return out;
    }

    /** An option by long (or short) name, in this level and its ancestors. */
    private Option findOption(String nm, boolean isShort) {
        for (Cli node = this; node != null; node = node.parent) {
            Option opt = isShort ? node.byShort.get(nm) : node.byLong.get(nm);
            if (opt != null) return opt;
        }
        return null;
    }

    /** {@code option} holds the config file path; {@code prefixes} is comma-separated. */
    public Cli setConfig(String option, String prefixes) {
        this.configOption = option;
        List<String> list = new ArrayList<>();
        for (String p : prefixes.split(",")) if (!p.strip().isEmpty()) list.add(p.strip());
        this.configPrefixes = list;
        return this;
    }

    /** Declare an external command the program needs. */
    public Cli requireCommand(String command, String description, String installHint) {
        commands.add(new Command(command, description, installHint));
        return this;
    }

    /** Fallback directories (colon-separated, relative to the root) for bare relative values of a path option. */
    public Cli setPathSearch(String lng, String dirs) {
        Option opt = byLong.get(lng);
        if (opt == null) throw new IllegalArgumentException("No option --" + lng);
        List<String> list = new ArrayList<>();
        for (String d : dirs.split(":")) if (!d.isEmpty()) list.add(normpath(root, d));
        opt.searchDirs = list;
        if (opt.rule.isEmpty()) opt.rule = "path";
        return this;
    }

    /**
     * Register an option. {@code def} is a value, "flag", "optional", or "" (required).
     * {@code groupAndRule} is an optional group (default "Options") and validation rule.
     */
    public Cli opt(String var, String lng, String shrt, String def, String description, String... groupAndRule) {
        String kind = def.equals("flag") ? "flag" : "value";
        String value = def.equals("flag") || def.equals("optional") ? "" : def;
        return add(new Option(var, lng, shrt, kind, value, def.isEmpty(), description, group(groupAndRule), rule(groupAndRule)));
    }

    /** Register a repeatable option whose values accumulate into a list. */
    public Cli optArray(String var, String lng, String shrt, String description, String... groupAndRule) {
        return add(new Option(var, lng, shrt, "array", "", false, description, group(groupAndRule), rule(groupAndRule)));
    }

    /** Register a positional argument. An empty {@code def} makes it required. */
    public Cli arg(String name, String description, String def, String... rule) {
        return addArg(new Argument(name, description, def, rule.length > 0 ? rule[0] : "", false));
    }

    /** Register a final positional argument that collects all remaining tokens. */
    public Cli argVariadic(String name, String description, String... rule) {
        return addArg(new Argument(name, description, "", rule.length > 0 ? rule[0] : "", true));
    }

    private static String group(String[] extra) { return extra.length > 0 && !extra[0].isEmpty() ? extra[0] : "Options"; }

    private static String rule(String[] extra) { return extra.length > 1 ? extra[1] : ""; }

    private Cli add(Option opt) {
        if (byLong.containsKey(opt.lng)) throw new IllegalArgumentException("Duplicate option --" + opt.lng);
        if (!opt.shrt.isEmpty() && (length(opt.shrt) != 1 || byShort.containsKey(opt.shrt))) {
            throw new IllegalArgumentException("Invalid or duplicate short option -" + opt.shrt);
        }
        if (opt.rule.equals("secret") || opt.rule.startsWith("secret:")) {
            opt.secret = true;
            opt.rule = opt.rule.length() > 6 ? opt.rule.substring(7) : "";
        }
        if (!knownRule(opt.rule)) throw new IllegalArgumentException("Unknown validation rule '" + opt.rule + "' for --" + opt.lng);
        options.add(opt);
        byLong.put(opt.lng, opt);
        if (!opt.shrt.isEmpty()) byShort.put(opt.shrt, opt);
        return this;
    }

    private Cli addArg(Argument arg) {
        if (!children.isEmpty()) throw new IllegalArgumentException("Cannot mix commands and positional arguments");
        if (args.stream().anyMatch(Argument::variadic)) {
            throw new IllegalArgumentException("Argument " + arg.name() + " registered after a variadic argument");
        }
        if (!knownRule(arg.rule())) throw new IllegalArgumentException("Unknown validation rule '" + arg.rule() + "' for " + arg.name());
        args.add(arg);
        return this;
    }

    private void ensureHelp() {
        if (!byLong.containsKey("help")) {
            add(new Option("HELP", "help", byShort.containsKey("h") ? "" : "h", "flag", "", false, "Show this help message and exit", "Global", ""));
        }
    }

    // -----------------------------------------------------------------------
    // Parsing
    // -----------------------------------------------------------------------

    /** Parse without exiting. Values are in {@link #values()} when the status is "ok". */
    public ParseResult parse(String... argv) {
        raw = new HashMap<>();
        argRaw = new HashMap<>();
        sources = new HashMap<>();
        config = new LinkedHashMap<>();
        values = new Values();
        selected = this;
        ensureHelp();

        String scanError = null;
        try {
            scan(argv);
            if (!configOption.isEmpty()) loadConfig();
        } catch (ParseError e) {
            scanError = e.getMessage();
        }
        if (raw.containsKey("help") && raw.get("help").get(0).equals("true")) return ParseResult.help();
        if (scanError != null) return ParseResult.error(scanError);

        try {
            resolve();
        } catch (ParseError | ValidationError e) {
            return ParseResult.error(e.getMessage());
        }

        List<Command> missingCmds = chainDown().stream().flatMap(n -> n.commands.stream()).filter(c -> !which(c.name())).toList();
        if (!missingCmds.isEmpty()) {
            List<String> detail = new ArrayList<>();
            for (Command c : missingCmds) {
                detail.add("  " + c.name() + " - " + c.description());
                if (!c.hint().isEmpty()) detail.add("    Install: " + c.hint());
            }
            String names = String.join(", ", missingCmds.stream().map(Command::name).toList());
            return new ParseResult("error", "Missing required command(s): " + names, false, detail);
        }

        List<String> missing = new ArrayList<>();
        for (Option o : chainOptions()) {
            if (o.required && (!raw.containsKey(o.lng) || raw.get(o.lng).get(0).isEmpty())) missing.add("--" + o.lng);
        }
        if (!missing.isEmpty()) return ParseResult.error("Missing required argument(s): " + String.join(" ", missing));
        String conflict = checkConstraints();
        if (conflict != null) return ParseResult.error(conflict);
        return ParseResult.ok();
    }

    private boolean given(String lng) {
        Object v = values.get(selected.findOption(lng, false).var);
        return List.of("cli", "config", "env").contains(source(lng)) && !Boolean.FALSE.equals(v)
            && !(v instanceof List<?> list && list.isEmpty());
    }

    /** Spec section 1.6: the first relationship that fails, from the program down. */
    @SuppressWarnings("unchecked")
    private String checkConstraints() {
        for (Cli node : chainDown()) {
            for (Map<String, Object> c : node.constraints) {
                List<String> lngs = (List<String>) c.get("options");
                List<String> on = lngs.stream().filter(this::given).toList();
                switch ((String) c.get("type")) {
                    case "exclusive" -> {
                        if (on.size() > 1) return "Options --" + on.get(0) + " and --" + on.get(1) + " cannot be used together";
                    }
                    case "requires" -> {
                        if (given(lngs.get(0))) {
                            for (String l : lngs.subList(1, lngs.size())) {
                                if (!given(l)) return "Option --" + lngs.get(0) + " requires --" + l;
                            }
                        }
                    }
                    default -> {
                        if (on.isEmpty()) return "One of --" + String.join(", --", lngs) + " is required";
                    }
                }
            }
        }
        return null;
    }

    private boolean which(String cmd) {
        for (String dir : env.getOrDefault("PATH", "").split(Pattern.quote(File.pathSeparator))) {
            if (dir.isEmpty()) continue;
            Path p = Paths.get(dir, cmd);
            if (Files.isExecutable(p) && !Files.isDirectory(p)) return true;
        }
        return false;
    }

    private void setCli(Option opt, String value) {
        if (opt.kind.equals("array")) {
            List<String> current = "cli".equals(sources.get(opt.lng)) ? raw.get(opt.lng) : new ArrayList<>();
            current.add(value);
            raw.put(opt.lng, current);
        } else {
            raw.put(opt.lng, new ArrayList<>(List.of(value)));
        }
        sources.put(opt.lng, "cli");
    }

    private void scan(String[] argv) {
        int pos = 0;
        List<String> rest = null;
        boolean endOfOptions = false;
        int i = 0;
        while (i < argv.length) {
            String token = argv[i++];
            if (endOfOptions || token.equals("-") || !token.startsWith("-")) {
                Cli node = selected;
                if (rest != null) {
                    rest.add(token);
                } else if (!node.children.isEmpty()) {
                    Cli child = node.children.stream().filter(c -> c.word.equals(token)).findFirst().orElse(null);
                    if (child == null) throw new ParseError("Unknown command: " + token);
                    selected = child;
                } else if (pos >= node.args.size()) {
                    throw new ParseError("Unexpected argument: " + token);
                } else {
                    Argument arg = node.args.get(pos++);
                    List<String> value = new ArrayList<>(List.of(token));
                    argRaw.put(arg.name(), value);
                    if (arg.variadic()) rest = value;
                }
            } else if (token.equals("--")) {
                endOfOptions = true;
            } else if (token.startsWith("--")) {
                String body = token.substring(2);
                int eqAt = body.indexOf('=');
                boolean eq = eqAt >= 0;
                String nm = eq ? body.substring(0, eqAt) : body;
                String value = eq ? body.substring(eqAt + 1) : "";
                Option opt = selected.findOption(nm, false);
                if (opt != null && eq) {
                    if (opt.kind.equals("flag")) {
                        Boolean b = boolWord(value);
                        if (b == null) throw new ParseError("Option --" + nm + " expects a boolean value, got '" + value + "'");
                        value = b.toString();
                    }
                    setCli(opt, value);
                } else if (opt != null) {
                    if (opt.kind.equals("flag")) {
                        setCli(opt, "true");
                    } else {
                        if (i >= argv.length || argv[i].startsWith("--")) throw new ParseError("Option --" + nm + " requires an argument");
                        setCli(opt, argv[i++]);
                    }
                } else if (nm.startsWith("no-") && !eq && selected.findOption(nm.substring(3), false) != null) {
                    Option target = selected.findOption(nm.substring(3), false);
                    if (!target.boolLike()) throw new ParseError("Option --" + nm + " can only be used with flag/boolean options");
                    setCli(target, "false");
                } else {
                    throw new ParseError("Unknown option: --" + nm);
                }
            } else {
                int[] cluster = token.substring(1).codePoints().toArray();
                for (int j = 0; j < cluster.length; j++) {
                    String ch = new String(Character.toChars(cluster[j]));
                    Option opt = selected.findOption(ch, true);
                    if (opt == null) throw new ParseError("Unknown option: -" + ch);
                    if (opt.kind.equals("flag")) {
                        setCli(opt, "true");
                        continue;
                    }
                    if (j + 1 < cluster.length) {
                        setCli(opt, new String(cluster, j + 1, cluster.length - j - 1));
                        break;
                    }
                    if (i >= argv.length || argv[i].startsWith("-")) throw new ParseError("Option -" + ch + " requires an argument");
                    setCli(opt, argv[i++]);
                    break;
                }
            }
        }
    }

    private void loadConfig() {
        Option opt = selected.findOption(configOption, false);
        if (opt == null) return;
        String path = raw.containsKey(opt.lng) ? raw.get(opt.lng).get(0) : null;
        String source = "cli";
        if (path == null && !env.getOrDefault(opt.var, "").isEmpty()) {
            path = env.get(opt.var);
            source = "env";
        }
        if (path == null && !opt.def.isEmpty()) {
            path = opt.def;
            source = "default";
        }
        if (path == null || path.isEmpty() || path.equals("disabled")) return;
        String resolved = resolvePath(path, cwd, opt.searchDirs);
        raw.put(opt.lng, new ArrayList<>(List.of(resolved)));
        sources.put(opt.lng, source);
        readConfig(resolved, 0, new HashSet<>());

        for (Map.Entry<String, ConfigValue> e : config.entrySet()) {
            String key = e.getKey();
            String value = e.getValue().value();
            Option target = selected.findOption(key, false);
            if (target == null || target == opt || "cli".equals(sources.get(key))) continue;
            if (target.kind.equals("flag")) {
                Boolean b = boolWord(value);
                if (b == null) throw new ParseError("Config value for --" + key + " must be a boolean, got '" + value + "'");
                raw.put(key, new ArrayList<>(List.of(b.toString())));
            } else {
                raw.put(key, new ArrayList<>(List.of(value)));
            }
            sources.put(key, "config");
        }
    }

    private void readConfig(String path, int depth, Set<String> stack) {
        if (depth > 10) throw new ParseError("Config include depth exceeded (10) while processing: " + path);
        if (!Files.isRegularFile(Paths.get(path))) throw new ParseError("Config file not found: " + path);
        if (stack.contains(path)) throw new ParseError("Circular config include detected: " + path);
        stack.add(path);
        String dir = parent(path);
        String text;
        try {
            text = Files.readString(Paths.get(path), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new ParseError("Config file not found: " + path);
        }
        for (String line : text.split("\n", -1)) {
            if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
            String trimmed = line.strip();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
            Matcher include = INCLUDE.matcher(line);
            if (include.matches()) {
                String target = include.group(1).strip();
                if (target.length() >= 2 && (target.charAt(0) == '"' || target.charAt(0) == '\'') && target.charAt(target.length() - 1) == target.charAt(0)) {
                    target = target.substring(1, target.length() - 1);
                }
                readConfig(normpath(dir, target), depth + 1, stack);
                continue;
            }
            String body = line;
            if (!configPrefixes.isEmpty()) {
                String prefix = null;
                for (String p : configPrefixes) {
                    if (line.startsWith(p)) {
                        prefix = p;
                        break;
                    }
                }
                if (prefix == null) continue;
                body = line.substring(prefix.length());
            }
            int eqAt = body.indexOf('=');
            if (eqAt < 0) continue;
            String key = body.substring(0, eqAt).strip();
            if (key.startsWith("--")) key = key.substring(2);
            if (key.isEmpty()) continue;
            config.put(key, new ConfigValue(body.substring(eqAt + 1).strip(), dir));
        }
        stack.remove(path);
    }

    private void resolve() {
        if (!selected.children.isEmpty()) throw new ParseError("Missing command");
        List<Option> options = chainOptions();
        List<Argument> args = selected.args;
        for (Argument arg : args) {
            if (argRaw.containsKey(arg.name())) continue;
            if (arg.variadic()) argRaw.put(arg.name(), new ArrayList<>());
            else if (arg.def().isEmpty()) throw new ParseError("Missing required positional argument: " + arg.name());
            else argRaw.put(arg.name(), new ArrayList<>(List.of(arg.def())));
        }

        for (Option opt : options) {
            if (sources.containsKey(opt.lng)) continue;
            String envValue = opt.kind.equals("array") ? null : env.get(opt.var);
            if (envValue != null && !envValue.isEmpty()) {
                if (opt.kind.equals("flag")) {
                    Boolean b = boolWord(envValue);
                    if (b == null) throw new ParseError("Environment variable " + opt.var + " must be a boolean, got '" + envValue + "'");
                    envValue = b.toString();
                }
                raw.put(opt.lng, new ArrayList<>(List.of(envValue)));
                sources.put(opt.lng, "env");
            } else if (opt.kind.equals("flag")) {
                raw.put(opt.lng, new ArrayList<>(List.of("false")));
                sources.put(opt.lng, "default");
            } else if (!opt.def.isEmpty()) {
                raw.put(opt.lng, new ArrayList<>(List.of(opt.def)));
                sources.put(opt.lng, "default");
            }
        }

        // Path resolution: the base depends on where the value came from.
        for (Option opt : options) {
            if (!isPathRule(opt.rule) || !raw.containsKey(opt.lng) || opt.lng.equals(configOption)) continue;
            String source = sources.get(opt.lng);
            String base = source.equals("cli") ? cwd : source.equals("config") ? config.get(opt.lng).dir() : root;
            raw.get(opt.lng).replaceAll(v -> resolvePath(v, base, opt.searchDirs));
        }
        for (Argument arg : args) {
            if (isPathRule(arg.rule())) argRaw.get(arg.name()).replaceAll(v -> resolvePath(v, cwd, List.of()));
        }

        for (Option opt : options) {
            List<String> r = raw.get(opt.lng);
            if (r == null) values.put(opt.var, opt.kind.equals("array") ? new ArrayList<>() : null);
            else if (opt.kind.equals("flag")) values.put(opt.var, r.get(0).equals("true"));
            else if (opt.kind.equals("array")) values.put(opt.var, convertAll(r, opt.rule, "--" + opt.lng));
            else values.put(opt.var, convert(r.get(0), opt.rule, "--" + opt.lng));
        }
        for (Argument arg : args) {
            List<String> r = argRaw.get(arg.name());
            values.put(arg.name(), arg.variadic() ? convertAll(r, arg.rule(), arg.name()) : convert(r.get(0), arg.rule(), arg.name()));
        }
        if (!children.isEmpty()) values.put("command", commandPath());
    }

    private static Object convert(String v, String rule, String name) {
        return v.isEmpty() || rule.isEmpty() ? v : validate(v, rule, name);
    }

    private static List<Object> convertAll(List<String> values, String rule, String name) {
        List<Object> out = new ArrayList<>();
        for (String v : values) out.add(convert(v, rule, name));
        return out;
    }

    /**
     * Parse like a CLI: handles --help, --help-json-schema, --completion and --bash-completion,
     * prints errors and exits on failure. Returns the values.
     */
    public Values run(String... argv) {
        List<String> all = Arrays.asList(argv);
        List<String> head = all.contains("--") ? all.subList(0, all.indexOf("--")) : all;
        if (head.contains("--help-json-schema")) {
            System.out.println(jsonSchema());
            System.exit(0);
        }
        if (head.contains("--bash-completion")) {
            System.out.print(completionData(all.contains("--") ? all.subList(all.indexOf("--") + 1, all.size()) : List.of()));
            System.out.flush();
            System.exit(0);
        }
        if (head.contains("--completion")) {
            int at = head.indexOf("--completion");
            String shell = at + 1 < head.size() ? head.get(at + 1) : "";
            String script = completionScript(shell);
            if (script == null) Log.die(1, "Unknown shell '%s' (expected bash, zsh or fish)", shell);
            System.out.print(script);
            System.out.flush();
            System.exit(0);
        }

        ParseResult result = parse(argv);
        if (result.status().equals("help")) {
            System.out.print(usage());
            System.out.flush();
            System.exit(0);
        }
        if (result.status().equals("error")) {
            Log.emit("error", result.error(), true);
            for (String line : result.detail()) System.err.println(line);
            if (result.showUsage()) System.err.print(usage());
            System.err.flush();
            System.exit(1);
        }
        return values;
    }

    // -----------------------------------------------------------------------
    // Accessors
    // -----------------------------------------------------------------------

    public String name() { return name; }

    /** The resolved values from the last parse. */
    public Values values() { return values; }

    public Object get(String name) { return values.get(name); }

    /** Where an option's value came from: cli, config, env, default or unset. */
    public String source(String lng) { return sources.getOrDefault(lng.startsWith("--") ? lng.substring(2) : lng, "unset"); }

    public boolean isSet(String lng) { return source(lng).equals("cli"); }

    public boolean isExplicitlySet(String lng) { return List.of("cli", "config", "env").contains(source(lng)); }

    /** Resolved values as JSON (spec section 10), in registration order. */
    public String valuesJson() {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Option o : chainOptions()) {
            Object v = values.get(o.var);
            if (o.secret && v instanceof List<?> list) v = list.stream().map(x -> "***").toList();
            else if (o.secret && v != null) v = "***";
            out.put(o.var, v);
        }
        for (Argument a : selected.args) out.put(a.name(), values.get(a.name()));
        if (!children.isEmpty()) out.put("command", commandPath());
        return Json.write(out);
    }

    // -----------------------------------------------------------------------
    // Output
    // -----------------------------------------------------------------------

    /** Help text (spec section 7), for the selected command. */
    @SuppressWarnings("unchecked")
    public String usage() {
        ensureHelp();
        Cli node = selected;
        List<Option> options = chainOptions();
        String w = env.getOrDefault("CLYOPS_MAX_WIDTH", "");
        int maxWidth = DIGITS.matcher(w).matches() && w.length() < 6 && Integer.parseInt(w) > 0 ? Integer.parseInt(w) : 100;
        int longest = Math.max(options.stream().mapToInt(o -> length(o.label())).max().orElse(0),
            node.children.stream().mapToInt(c -> length(c.word)).max().orElse(0));
        int indent = Math.min(50, Math.max(32, longest + 4));
        int textWidth = Math.max(20, maxWidth - indent);

        List<List<String>> sections = new ArrayList<>();
        StringBuilder usage = new StringBuilder("Usage: " + node.name);
        if (!node.children.isEmpty()) usage.append(" <command>");
        for (Argument a : node.args) {
            usage.append(a.variadic() ? " [<" + a.name() + "...>]" : !a.def().isEmpty() ? " [<" + a.name() + ">]" : " <" + a.name() + ">");
        }
        sections.add(List.of(usage + " [OPTIONS]"));
        if (!node.description.isEmpty()) sections.add(wrapText(node.description, maxWidth));

        List<String> io = new ArrayList<>();
        for (Object[] d : new Object[][] {{"Input:", node.stdin}, {"Output:", node.stdout}}) {
            Map<String, Object> decl = (Map<String, Object>) d[1];
            if (decl == null) continue;
            String line = (String) d[0];
            if (!((String) decl.get("description")).isEmpty()) line += " " + decl.get("description");
            if (!((String) decl.get("contentType")).isEmpty()) line += " (" + decl.get("contentType") + ")";
            io.add(line);
        }
        if (!io.isEmpty()) sections.add(io);

        if (!node.children.isEmpty()) {
            List<String> lines = new ArrayList<>(List.of("Commands:"));
            for (Cli c : node.children) lines.addAll(row(c.word, c.description, indent, textWidth));
            sections.add(lines);
        }

        if (!node.args.isEmpty()) {
            List<String> lines = new ArrayList<>(List.of("Positional Arguments:"));
            for (Argument a : node.args) {
                List<String> notes = new ArrayList<>();
                if (a.variadic()) notes.add("variadic");
                if (!a.def().isEmpty()) notes.add("default: " + a.def());
                if (!a.rule().isEmpty()) notes.add("accepts: " + describeRule(a.rule()));
                lines.addAll(row(a.name(), annotate(a.description(), notes), indent, textWidth));
            }
            sections.add(lines);
        }
        List<Command> required = chainDown().stream().flatMap(n -> n.commands.stream()).toList();
        if (!required.isEmpty()) {
            List<String> lines = new ArrayList<>(List.of("Required Commands:"));
            for (Command c : required) {
                String status = which(c.name()) ? "installed" : "not found";
                lines.addAll(row(c.name() + " [" + status + "]", c.hint().isEmpty() ? c.description() : c.description() + " (" + c.hint() + ")", indent, textWidth));
            }
            sections.add(lines);
        }
        Set<String> groups = new LinkedHashSet<>();
        for (Option o : options) groups.add(o.group);
        for (String group : groups) {
            List<String> lines = new ArrayList<>(List.of(group + ":"));
            for (Option o : options) {
                if (!o.group.equals(group)) continue;
                List<String> notes = new ArrayList<>();
                if (o.required) notes.add("required");
                if (o.kind.equals("array")) notes.add("multiple");
                if (o.secret) notes.add("secret");
                if (config.containsKey(o.lng)) notes.add("config: " + (o.secret ? "***" : config.get(o.lng).value()));
                if (!o.def.isEmpty()) notes.add("default: " + o.def);
                if (!o.rule.isEmpty()) notes.add("accepts: " + describeRule(o.rule));
                for (Cli n : chainDown()) {
                    for (Map<String, Object> c : n.constraints) {
                        List<String> lngs = (List<String>) c.get("options");
                        if (!lngs.contains(o.lng)) continue;
                        switch ((String) c.get("type")) {
                            case "exclusive" -> notes.add("conflicts with: --" + String.join(", --", lngs.stream().filter(l -> !l.equals(o.lng)).toList()));
                            case "requires" -> {
                                if (lngs.get(0).equals(o.lng)) notes.add("requires: --" + String.join(", --", lngs.subList(1, lngs.size())));
                            }
                            default -> notes.add("one of: --" + String.join(", --", lngs));
                        }
                    }
                }
                lines.addAll(row(o.label(), annotate(o.description, notes), indent, textWidth));
            }
            sections.add(lines);
        }
        if (!node.epilog.isEmpty()) sections.add(splitAll(node.epilog.replaceAll("\n+$", ""), "\n"));

        List<String> parts = new ArrayList<>();
        for (List<String> s : sections) parts.add(String.join("\n", s));
        StringBuilder out = new StringBuilder();
        for (String line : String.join("\n\n", parts).split("\n", -1)) out.append(line.stripTrailing()).append("\n");
        return out.toString();
    }

    private static List<String> row(String label, String text, int indent, int textWidth) {
        String left = "  " + label;
        left = length(left) < indent ? left + " ".repeat(indent - length(left)) : left + " ";
        List<String> lines = wrapText(text, textWidth);
        List<String> out = new ArrayList<>(List.of(left + lines.get(0)));
        for (String line : lines.subList(1, lines.size())) out.add(" ".repeat(indent) + line);
        return out;
    }

    private static String annotate(String text, List<String> notes) {
        return notes.isEmpty() ? text : text + " (" + String.join(", ", notes) + ")";
    }

    /** JSON description of the CLI (spec section 8). */
    public String jsonSchema() {
        ensureHelp();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("clyops", 1);
        out.put("script", name);
        out.putAll(schemaNode());
        return Json.write(out);
    }

    private Map<String, Object> schemaNode() {
        Map<String, Object> out = new LinkedHashMap<>();
        if (parent != null) out.put("name", word);
        out.put("description", description);
        out.put("epilog", epilog);
        List<Object> argList = new ArrayList<>();
        for (Argument a : args) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", a.name());
            m.put("description", a.description());
            m.put("required", !a.variadic() && a.def().isEmpty());
            m.put("isVariadic", a.variadic());
            m.put("default", a.def());
            m.put("validation", a.rule());
            argList.add(m);
        }
        out.put("arguments", argList);
        List<Object> optList = new ArrayList<>();
        for (Option o : options) {
            String r = o.rule;
            String type = o.kind.equals("flag") || r.equals("bool") ? "boolean"
                : r.startsWith("int") || r.equals("port") ? "integer"
                : r.startsWith("float") ? "number"
                : r.startsWith("choice:") ? "choice"
                : isPathRule(r) ? "path" : "string";
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", o.lng);
            m.put("shortName", o.shrt);
            m.put("variableName", o.var);
            m.put("description", o.description);
            m.put("default", o.kind.equals("flag") ? "false" : o.def);
            m.put("group", o.group);
            m.put("type", type);
            m.put("isFlag", o.kind.equals("flag"));
            m.put("isArray", o.kind.equals("array"));
            m.put("required", o.required);
            m.put("validation", r);
            m.put("choices", r.startsWith("choice:") ? splitAll(r.substring(7), ",") : List.of());
            m.put("secret", o.secret);
            optList.add(m);
        }
        out.put("options", optList);
        List<Object> cmdList = new ArrayList<>();
        for (Command c : commands) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("command", c.name());
            m.put("description", c.description());
            m.put("installHint", c.hint());
            cmdList.add(m);
        }
        out.put("requiredCommands", cmdList);
        out.put("effects", effects);
        out.put("constraints", constraints);
        out.put("stdin", stdin);
        out.put("stdout", stdout);
        out.put("commands", children.stream().map(Cli::schemaNode).toList());
        return out;
    }

    /**
     * Shell script that enables completion for this program (spec section 9):
     * {@code eval "$(prog --completion bash)"}. Null for an unknown shell.
     */
    public String completionScript(String shell) {
        String template = Completions.SCRIPTS.get(shell);
        if (template == null) return null;
        return template.replace("__CLYOPS_FUNC__", name.replaceAll("[^A-Za-z0-9_]", "_")).replace("__CLYOPS_PROG__", name);
    }

    /** Tab-separated completion records (spec section 9) for the program itself. */
    public String completionData() { return completionData(List.of()); }

    /**
     * Tab-separated completion records (spec section 9). {@code words} are the words typed
     * after the program name; a program with commands follows them.
     */
    public String completionData(List<String> words) {
        ensureHelp();
        List<String> lines = new ArrayList<>(List.of("#clyops-completion 1"));
        Cli node = this;
        if (!children.isEmpty()) {
            int skip = 0;
            for (String w : words) {
                Cli child = node.children.stream().filter(c -> c.word.equals(w)).findFirst().orElse(null);
                if (child == null) break;
                node = child;
                skip++;
            }
            if (!node.children.isEmpty() && skip < words.size() && !words.get(skip).startsWith("-")) return lines.get(0) + "\n";
            lines.add("skip\t" + skip);
            for (Cli c : node.children) lines.add("cmd\t" + c.word + "\t" + clean(c.description));
        }
        List<Option> options = new ArrayList<>();
        for (Cli n = node; n != null; n = n.parent) options.addAll(n.options);
        for (Option o : options) {
            String shrt = o.shrt.isEmpty() ? "-" : "-" + o.shrt;
            String desc = clean(o.description);
            if (o.kind.equals("flag")) {
                lines.add("opt\t--" + o.lng + "\t" + shrt + "\tflag\tnone\t-\t" + desc);
            } else {
                String[] k = completionKind(o.rule, o.searchDirs);
                lines.add("opt\t--" + o.lng + "\t" + shrt + "\tvalue\t" + k[0] + "\t" + (k[1].isEmpty() ? "-" : k[1]) + "\t" + desc);
            }
            if (o.boolLike()) lines.add("opt\t--no-" + o.lng + "\t-\tflag\tnone\t-\t" + desc);
        }
        for (Argument a : node.args) {
            String[] k = completionKind(a.rule(), List.of());
            lines.add("arg\t" + a.name() + "\t" + (a.variadic() ? "variadic" : "single") + "\t" + k[0] + "\t" + (k[1].isEmpty() ? "-" : k[1]) + "\t" + clean(a.description()));
        }
        return String.join("\n", lines) + "\n";
    }

    private static String clean(String s) { return s.replace('\t', ' ').replace('\n', ' '); }
}
