package io.github.wankdanker.clyops;

/** A value that fails its validation rule; the message is the spec's error text. */
public class ValidationError extends RuntimeException {
    public ValidationError(String message) { super(message); }
}
