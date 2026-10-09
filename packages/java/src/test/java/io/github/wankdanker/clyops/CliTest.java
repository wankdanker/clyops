package io.github.wankdanker.clyops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigInteger;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CliTest {
    private static Cli make() {
        Cli cli = new Cli("t").setCwd("/work").setRoot("/root").setEnv(Map.of());
        cli.arg("file", "File", "", "path");
        cli.opt("COUNT", "count", "n", "2", "Count", "Options", "int:1-5");
        cli.opt("FAST", "fast", "f", "flag", "Fast");
        cli.optArray("TAG", "tag", "t", "Tags");
        return cli;
    }

    @Test
    void parseReturnsTypedValues() {
        Cli cli = make();
        assertEquals("ok", cli.parse("a.txt", "-fn", "4", "-t", "x", "--tag=y").status());
        Values v = cli.values();
        assertEquals("/work/a.txt", v.getString("file"));
        assertEquals(4, v.getInt("COUNT"));
        assertEquals(4L, v.get("COUNT"));
        assertTrue(v.getBool("FAST"));
        assertEquals(List.of("x", "y"), v.getStrings("TAG"));
        assertTrue(cli.isSet("--fast"));
        assertEquals("cli", cli.source("count"));
        assertEquals("unset", cli.source("nope"));
    }

    @Test
    void parseReportsErrorsAndHelp() {
        ParseResult r = make().parse("a", "--count", "9");
        assertEquals("error", r.status());
        assertEquals("--count must be <= 5, got 9", r.error());
        assertEquals("help", make().parse("--help").status());
        assertEquals("Unknown option: --bogus", make().parse("a", "--bogus").error());
    }

    @Test
    void environmentByVariableName() {
        Cli cli = new Cli("t").setEnv(Map.of("COUNT", "3")).opt("COUNT", "count", "", "1", "Count", "Options", "int");
        cli.parse();
        assertEquals(3, cli.values().getInt("COUNT"));
        assertEquals("env", cli.source("count"));
    }

    @Test
    void registrationErrors() {
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> new Cli("t").opt("A", "a", "", "", "A", "Options", "nope"));
        assertEquals("Unknown validation rule 'nope' for --a", e.getMessage());
        assertThrows(IllegalArgumentException.class, () -> new Cli("t").argVariadic("r", "R").arg("x", "X", ""));
    }

    @Test
    void validate() {
        assertEquals(Boolean.TRUE, Cli.validate("ON", "bool", "v"));
        assertEquals(-2.5, Cli.validate("-2.5", "float:-3", "v"));
        assertEquals(0.5, Cli.validate(".5", "float:.1-1", "v"));
        assertEquals(new BigInteger("123456789012345678901234567890"), Cli.validate("123456789012345678901234567890", "int", "v"));
        assertEquals("--s must be at most 3 characters, got 4", assertThrows(ValidationError.class, () -> Cli.validate("abcd", "string:-3", "--s")).getMessage());
        // $ must not match before a trailing newline
        assertThrows(ValidationError.class, () -> Cli.validate("abc@example.com\n", "email", "e"));
        assertEquals("héllo😀", Cli.validate("héllo😀", "string:6", "s"), "lengths count characters");
        assertEquals("text: >=2 chars", Cli.describeRule("string:2-"));
    }

    @Test
    void resolvePath() {
        assertEquals("-", Cli.resolvePath("-", "/b", List.of()));
        assertEquals("s3://bucket/key", Cli.resolvePath("s3://bucket/key", "/b", List.of()));
        assertEquals("/b/x", Cli.resolvePath("../x", "/b/c", List.of()));
        assertEquals("/abs", Cli.resolvePath("/abs", "/b", List.of()));
    }

    @Test
    void wrapText() {
        assertEquals(List.of("aa bb", "cc", "", "supercalifragilistic", "dd"), Cli.wrapText("aa bb cc\n\nsupercalifragilistic dd", 5));
    }

    @Test
    void json() {
        Cli cli = make().setDescription("Quote \" and tab\t");
        cli.parse("a");
        assertEquals("{\n  \"COUNT\": 2,\n  \"FAST\": false,\n  \"TAG\": [],\n  \"HELP\": false,\n  \"file\": \"/work/a\"\n}", cli.valuesJson());
        assertTrue(cli.jsonSchema().contains("\"description\": \"Quote \\\" and tab\\t\""));
        assertTrue(cli.jsonSchema().contains("\"requiredCommands\": []"));
        assertNull(cli.completionScript("powershell"));
        assertTrue(cli.completionScript("bash").contains("_clyops_t"));
    }
}
