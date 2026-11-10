package io.github.wankdanker.clyops;

import java.util.List;

/**
 * Lists the values to offer when completing an option or argument (spec section 9.2). It gets
 * the words typed after the program's commands and returns the values; throwing (or returning
 * null) keeps the completion of the option's rule. It runs only for {@code --bash-completion},
 * so it should be quick and must not write to standard output.
 */
@FunctionalInterface
public interface Completer {
    /** The values to offer, given the words typed after the program's commands. */
    List<String> complete(List<String> words) throws Exception;
}
