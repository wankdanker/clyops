package io.github.wankdanker.clyops;

/** A value that fails its validation rule; the message is the spec's error text. */
public class ValidationError extends RuntimeException {
    /** Construct a validation error with the rule failure message. */
    public ValidationError(String message) { super(message); }
}
