package io.github.wankdanker.clyops;

import java.util.List;

/**
 * What a {@link Completer} is asked for (spec section 9.2).
 *
 * @param words the words typed after the program's command words
 * @param prefix the text being completed; empty for shell completion
 * @param limit the most values wanted; 0 means no limit
 * @param offset how many matching values to skip
 */
public record CompleteRequest(List<String> words, String prefix, int limit, int offset) {
    /** Copies {@code words} so the completer can't change the caller's list. */
    public CompleteRequest {
        words = List.copyOf(words);
    }
}
