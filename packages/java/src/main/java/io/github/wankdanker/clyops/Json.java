package io.github.wankdanker.clyops;

import java.util.List;
import java.util.Map;

/** Two-space indented JSON, laid out like Python's json.dumps(indent=2, ensure_ascii=False). */
final class Json {
    private Json() {}

    static String write(Object value) {
        StringBuilder out = new StringBuilder();
        write(out, value, "");
        return out.toString();
    }

    private static void write(StringBuilder out, Object value, String indent) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String s) {
            string(out, s);
        } else if (value instanceof Boolean || value instanceof Number) {
            out.append(value);
        } else if (value instanceof Map<?, ?> map) {
            if (map.isEmpty()) {
                out.append("{}");
                return;
            }
            String inner = indent + "  ";
            out.append("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : map.entrySet()) {
                out.append(first ? "\n" : ",\n").append(inner);
                string(out, String.valueOf(e.getKey()));
                out.append(": ");
                write(out, e.getValue(), inner);
                first = false;
            }
            out.append("\n").append(indent).append("}");
        } else if (value instanceof List<?> list) {
            if (list.isEmpty()) {
                out.append("[]");
                return;
            }
            String inner = indent + "  ";
            out.append("[");
            for (int i = 0; i < list.size(); i++) {
                out.append(i == 0 ? "\n" : ",\n").append(inner);
                write(out, list.get(i), inner);
            }
            out.append("\n").append(indent).append("]");
        } else {
            throw new IllegalArgumentException("not JSON: " + value.getClass());
        }
    }

    private static void string(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        out.append('"');
    }
}
