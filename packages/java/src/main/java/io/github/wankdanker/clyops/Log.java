package io.github.wankdanker.clyops;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Map;

/** Logging to stderr with timestamps and colors (spec section 11): {@code import static ...Log.*}. */
public final class Log {
    private static final Map<String, String> COLORS = Map.of(
        "info", "\033[1;37m", "warning", "\033[0;33m", "error", "\033[0;31m", "success", "\033[0;32m");
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static volatile boolean silent = "true".equals(System.getenv("CLYOPS_SILENT"));

    private Log() {}

    /** Suppress info/warn/error/success output (die and parse errors still print). */
    public static void setSilent(boolean value) { silent = value; }

    static void emit(String level, String msg, boolean force) {
        if (silent && !force) return;
        // System.console() is null unless both stdin and stdout are terminals; stderr can't be checked directly.
        String tag = System.console() != null && System.getenv("NO_COLOR") == null ? COLORS.get(level) + level + "\033[0m" : level;
        System.err.println(LocalDateTime.now().format(TIME) + " [" + tag + "] " + msg);
    }

    public static void info(String format, Object... args) { emit("info", String.format(format, args), false); }
    public static void warn(String format, Object... args) { emit("warning", String.format(format, args), false); }
    public static void error(String format, Object... args) { emit("error", String.format(format, args), false); }
    public static void success(String format, Object... args) { emit("success", String.format(format, args), false); }

    /** Log an error (never suppressed) and exit with {@code code}. */
    public static void die(int code, String format, Object... args) {
        emit("error", String.format(format, args), true);
        System.exit(code);
    }
}
