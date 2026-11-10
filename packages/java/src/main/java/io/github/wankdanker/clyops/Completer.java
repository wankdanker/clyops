package io.github.wankdanker.clyops;

import java.util.List;

/**
 * Lists the values of an option or argument (spec section 9.2). It gets a {@link CompleteRequest}
 * and returns the values; throwing (or returning null) keeps the completion of the option's rule
 * and makes {@code --complete-values} fail. It runs only for {@code --bash-completion} and
 * {@code --complete-values}, so it should be quick and must not write to standard output.
 */
@FunctionalInterface
public interface Completer {
    /** The values for a request: the words typed after the program's commands, a prefix, a limit and an offset. */
    List<String> complete(CompleteRequest request) throws Exception;
}
