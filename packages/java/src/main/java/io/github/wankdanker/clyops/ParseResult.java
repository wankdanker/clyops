package io.github.wankdanker.clyops;

import java.util.List;

/** The outcome of {@link Cli#parse}: status is "ok", "help" or "error". */
public record ParseResult(String status, String error, boolean showUsage, List<String> detail) {
    static ParseResult ok() { return new ParseResult("ok", "", true, List.of()); }
    static ParseResult help() { return new ParseResult("help", "", true, List.of()); }
    static ParseResult error(String message) { return new ParseResult("error", message, true, List.of()); }
}
