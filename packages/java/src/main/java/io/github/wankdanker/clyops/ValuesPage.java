package io.github.wankdanker.clyops;

import java.util.List;

/**
 * A page of values (spec section 9.3), from {@link Cli#completeValues}.
 *
 * @param values the values, at most the limit asked for
 * @param more whether values beyond the limit were left out
 */
public record ValuesPage(List<String> values, boolean more) {
    /** Copies {@code values}. */
    public ValuesPage {
        values = List.copyOf(values);
    }
}
