package io.github.wankdanker.clyops;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * Resolved values keyed by option variable and argument name, in registration order. Types
 * follow spec section 10: Boolean for flags and bool, Long for int and port, Double for float,
 * String otherwise, a List for arrays and variadics, null when unset.
 */
public class Values extends LinkedHashMap<String, Object> {
    /** The value as a string ("" when unset). */
    public String getString(String name) {
        Object v = get(name);
        return v == null ? "" : v.toString();
    }

    /** The value as an int (0 when unset). */
    public int getInt(String name) { return (int) getLong(name); }

    /** The value as a long (0 when unset). */
    public long getLong(String name) { return get(name) instanceof Number n ? n.longValue() : 0; }

    /** The value as a double (0 when unset). */
    public double getDouble(String name) { return get(name) instanceof Number n ? n.doubleValue() : 0; }

    /** The value as a boolean (false when unset). */
    public boolean getBool(String name) { return get(name) instanceof Boolean b && b; }

    /** An array option's or variadic argument's values. */
    @SuppressWarnings("unchecked")
    public List<Object> getList(String name) { return get(name) instanceof List<?> l ? (List<Object>) l : List.of(); }

    /** An array option's or variadic argument's values as strings. */
    public List<String> getStrings(String name) {
        List<String> out = new ArrayList<>();
        for (Object item : getList(name)) out.add(String.valueOf(item));
        return out;
    }
}
