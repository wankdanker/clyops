/*
 * clyops — declarative CLI parsing for C11 (POSIX). Behavior follows spec/SPEC.md.
 *
 *     clyops_t* cli = clyops_new(NULL);
 *     clyops_arg(cli, "input", .description = "Input file", .rule = "path");
 *     clyops_opt(cli, "PORT", "port", "8080", .short_name = 'p', .description = "Server port", .group = "Network", .rule = "port");
 *     clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Verbose output");
 *     clyops_run(cli, argc, argv);
 *     printf("%s %lld %d\n", clyops_get(cli, "input"), clyops_get_int(cli, "PORT"), clyops_get_bool(cli, "VERBOSE"));
 *     clyops_free(cli);
 *
 * The registration macros wrap their trailing designated initializers in a
 * clyops_meta_t compound literal, so every option is one line with named
 * optional fields. The plain clyops_add_* functions accept a reusable
 * clyops_meta_t as well.
 */
#ifndef CLYOPS_H
#define CLYOPS_H

/** Library release version. */
#define CLYOPS_VERSION "0.4.0"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Opaque CLI handle. Create with clyops_new and destroy with clyops_free. */
typedef struct clyops clyops_t;

/** Optional registration fields. Unset fields are zero/NULL. */
typedef struct {
    int _; /**< Reserved placeholder for the registration macros. */
    char short_name; /**< Single-character alias, zero for none. */
    const char* description; /**< Help description. */
    const char* group; /**< Help section; defaults to Options. */
    const char* rule; /**< Validation rule from spec section 5. */
    const char* default_value; /**< Positional default; NULL or empty makes it required. */
} clyops_meta_t;

/** Non-exiting parse outcome. */
typedef enum {
    CLYOPS_OK = 0, /**< Parsing succeeded. */
    CLYOPS_HELP = 1, /**< Help was requested. */
    CLYOPS_ERROR = 2 /**< Read clyops_error for the failure message. */
} clyops_status_t;

/** Create a CLI. `name` is shown in usage; NULL uses the basename of argv[0] at run time. */
clyops_t* clyops_new(const char* name);
/** Free the CLI and all its child commands. Returned value pointers become invalid. */
void clyops_free(clyops_t* cli);

/** Base directory for default/env path values and search dirs (relative to the cwd). Default ".". */
void clyops_root(clyops_t* cli, const char* dir);
/** Set the description displayed below the usage line. */
void clyops_description(clyops_t* cli, const char* text);
/** Set the final help text. */
void clyops_epilog(clyops_t* cli, const char* text);
/** `option` holds the config file path; `prefixes` is comma-separated. */
void clyops_config(clyops_t* cli, const char* option, const char* prefixes);
/** Require an executable on PATH during parsing; description and install_hint explain how to install it. */
void clyops_require_command(clyops_t* cli, const char* command, const char* description, const char* install_hint);
/** Fallback dirs (colon-separated, relative to root) for bare relative values of a path option. */
void clyops_path_search(clyops_t* cli, const char* long_name, const char* dirs);

/** What running the program does: a NULL-terminated list of read-only, idempotent, destructive, network. */
void clyops_set_effects(clyops_t* cli, const char* const* effects);
/** Declare effects as a variadic list of strings. */
#define clyops_effects(cli, ...) clyops_set_effects((cli), (const char* const[]){ __VA_ARGS__, NULL })
/** What the program reads on stdin; `content_type` is a MIME type or a comma-separated list. */
void clyops_stdin(clyops_t* cli, const char* description, const char* content_type);
/** What the program writes on stdout; undeclared means text. */
void clyops_stdout(clyops_t* cli, const char* description, const char* content_type);

/**
 * Option relationships (spec section 1.6) over a NULL-terminated list of long
 * names: "exclusive" (at most one given), "requires" (the first needs the
 * others) or "oneOf" (at least one given).
 */
void clyops_add_constraint(clyops_t* cli, const char* type, const char* const* long_names);
/** Declare that at most one listed option may be given. */
#define clyops_exclusive(cli, ...) clyops_add_constraint((cli), "exclusive", (const char* const[]){ __VA_ARGS__, NULL })
/** Declare that the first listed option requires the remaining options. */
#define clyops_requires(cli, ...) clyops_add_constraint((cli), "requires", (const char* const[]){ __VA_ARGS__, NULL })
/** Declare that at least one listed option must be given. */
#define clyops_one_of(cli, ...) clyops_add_constraint((cli), "oneOf", (const char* const[]){ __VA_ARGS__, NULL })

/**
 * Register a command (spec section 1.7) and return it, to register its options
 * and arguments on. It belongs to `cli` and is freed with it. After parsing,
 * the selected words are the value "command" (clyops_get_count/clyops_get_at).
 */
clyops_t* clyops_command(clyops_t* cli, const char* name, const char* description);

/**
 * Register an option. `default_value` is a default, "flag" for a boolean flag,
 * "optional" for no default, or "" to make the option required.
 * Registration errors (unknown rule, duplicate name) print a message and exit(2).
 */
void clyops_add_opt(clyops_t* cli, const char* var, const char* long_name, const char* default_value, clyops_meta_t meta);
/** Register a repeatable option whose values accumulate into a list. */
void clyops_add_opt_array(clyops_t* cli, const char* var, const char* long_name, clyops_meta_t meta);
/** Register a positional argument (meta.default_value; empty makes it required). */
void clyops_add_arg(clyops_t* cli, const char* name, clyops_meta_t meta);
/** Register a final positional argument that collects all remaining tokens. */
void clyops_add_arg_variadic(clyops_t* cli, const char* name, clyops_meta_t meta);

/** Register an option with optional designated metadata fields. */
#define clyops_opt(cli, var, long_name, default_value, ...) \
    clyops_add_opt((cli), (var), (long_name), (default_value), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))
/** Register a repeatable option with optional designated metadata fields. */
#define clyops_opt_array(cli, var, long_name, ...) \
    clyops_add_opt_array((cli), (var), (long_name), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))
/** Register a positional argument with optional designated metadata fields. */
#define clyops_arg(cli, name, ...) \
    clyops_add_arg((cli), (name), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))
/** Register a variadic positional argument with optional designated metadata fields. */
#define clyops_arg_variadic(cli, name, ...) \
    clyops_add_arg_variadic((cli), (name), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))

/** Parse without exiting. On CLYOPS_ERROR, clyops_error() holds the message. */
clyops_status_t clyops_parse(clyops_t* cli, int argc, char** argv);
/**
 * Parse like a CLI: handles --help, --help-json-schema, --bash-completion and
 * --completion, prints errors and exits on failure. argv[0] is the program.
 */
void clyops_run(clyops_t* cli, int argc, char** argv);
/** Borrowed error text from the last parse; valid until the CLI changes or is freed. */
const char* clyops_error(const clyops_t* cli);

/** String value of an option var or argument; flags are "true"/"false"; NULL when unset. */
const char* clyops_get(const clyops_t* cli, const char* name);
/** Integer value, or zero for an unset or nonnumeric value. */
long long clyops_get_int(const clyops_t* cli, const char* name);
/** Floating-point value, or zero for an unset or nonnumeric value. */
double clyops_get_double(const clyops_t* cli, const char* name);
/** True for flags/bool values that are "true". */
int clyops_get_bool(const clyops_t* cli, const char* name);
/** Number of values of an array option or variadic argument. */
size_t clyops_get_count(const clyops_t* cli, const char* name);
/** Borrowed item at index, or NULL if absent; valid until the next parse or CLI destruction. */
const char* clyops_get_at(const clyops_t* cli, const char* name, size_t index);

/** Where an option's value came from: "cli", "config", "env", "default" or "unset". */
const char* clyops_source(const clyops_t* cli, const char* long_name);
/** Nonzero if the option was supplied on the command line. */
int clyops_is_set(const clyops_t* cli, const char* long_name);
/** Nonzero if the option came from CLI, config, or environment rather than a default. */
int clyops_is_explicitly_set(const clyops_t* cli, const char* long_name);

/* Output; each returns a malloc'd string the caller frees. */
/** Return allocated help text; the caller must free it. */
char* clyops_usage(clyops_t* cli);
/** Return an allocated JSON schema; the caller must free it. */
char* clyops_json_schema(clyops_t* cli);
/** Return allocated completion records at the root; the caller must free them. */
char* clyops_completion_data(clyops_t* cli);
/** Completion records for the words typed after the program name; a program with commands follows them. */
char* clyops_completion_data_for(clyops_t* cli, int nwords, char** words);
/** Return allocated resolved values as JSON, masking secrets; the caller must free it. */
char* clyops_values_json(const clyops_t* cli);
/** Script enabling completion in "bash", "zsh" or "fish" (spec section 9); NULL for an unknown shell. */
char* clyops_completion_script(const clyops_t* cli, const char* shell);

/* Logging: "YYYY-MM-DD HH:MM:SS [level] message" on stderr, printf-style. */
/** Suppress ordinary logging when nonzero; die and parse errors still print. */
void clyops_set_silent(int silent);
/** Log an informational message to stderr with printf-style arguments. */
void clyops_info(const char* fmt, ...);
/** Log a warning to stderr with printf-style arguments. */
void clyops_warn(const char* fmt, ...);
/** Log an error message to stderr with printf-style arguments. */
void clyops_errorf(const char* fmt, ...);
/** Log a success message to stderr with printf-style arguments. */
void clyops_success(const char* fmt, ...);
/** Log an error and exit with code; never suppressed. */
void clyops_die(int code, const char* fmt, ...);

#ifdef __cplusplus
}
#endif

#endif /* CLYOPS_H */
