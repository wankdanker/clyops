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

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct clyops clyops_t;

/** Optional registration fields. Unset fields are zero/NULL. */
typedef struct {
    int _;                     /* placeholder so the macros accept no named fields */
    char short_name;           /* single-character alias, 0 for none */
    const char* description;
    const char* group;         /* help section, default "Options" */
    const char* rule;          /* validation rule, spec section 5 */
    const char* default_value; /* positional arguments only; NULL/"" makes them required */
} clyops_meta_t;

typedef enum { CLYOPS_OK = 0, CLYOPS_HELP = 1, CLYOPS_ERROR = 2 } clyops_status_t;

/** Create a CLI. `name` is shown in usage; NULL uses the basename of argv[0] at run time. */
clyops_t* clyops_new(const char* name);
void clyops_free(clyops_t* cli);

/** Base directory for default/env path values and search dirs (relative to the cwd). Default ".". */
void clyops_root(clyops_t* cli, const char* dir);
void clyops_description(clyops_t* cli, const char* text);
void clyops_epilog(clyops_t* cli, const char* text);
/** `option` holds the config file path; `prefixes` is comma-separated. */
void clyops_config(clyops_t* cli, const char* option, const char* prefixes);
void clyops_require_command(clyops_t* cli, const char* command, const char* description, const char* install_hint);
/** Fallback dirs (colon-separated, relative to root) for bare relative values of a path option. */
void clyops_path_search(clyops_t* cli, const char* long_name, const char* dirs);

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

#define clyops_opt(cli, var, long_name, default_value, ...) \
    clyops_add_opt((cli), (var), (long_name), (default_value), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))
#define clyops_opt_array(cli, var, long_name, ...) \
    clyops_add_opt_array((cli), (var), (long_name), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))
#define clyops_arg(cli, name, ...) \
    clyops_add_arg((cli), (name), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))
#define clyops_arg_variadic(cli, name, ...) \
    clyops_add_arg_variadic((cli), (name), ((clyops_meta_t){ ._ = 0, __VA_ARGS__ }))

/** Parse without exiting. On CLYOPS_ERROR, clyops_error() holds the message. */
clyops_status_t clyops_parse(clyops_t* cli, int argc, char** argv);
/**
 * Parse like a CLI: handles --help, --help-json-schema, --bash-completion and
 * --completion, prints errors and exits on failure. argv[0] is the program.
 */
void clyops_run(clyops_t* cli, int argc, char** argv);
const char* clyops_error(const clyops_t* cli);

/** String value of an option var or argument; flags are "true"/"false"; NULL when unset. */
const char* clyops_get(const clyops_t* cli, const char* name);
long long clyops_get_int(const clyops_t* cli, const char* name);
double clyops_get_double(const clyops_t* cli, const char* name);
/** True for flags/bool values that are "true". */
int clyops_get_bool(const clyops_t* cli, const char* name);
/** Number of values of an array option or variadic argument. */
size_t clyops_get_count(const clyops_t* cli, const char* name);
const char* clyops_get_at(const clyops_t* cli, const char* name, size_t index);

/** Where an option's value came from: "cli", "config", "env", "default" or "unset". */
const char* clyops_source(const clyops_t* cli, const char* long_name);
int clyops_is_set(const clyops_t* cli, const char* long_name);
int clyops_is_explicitly_set(const clyops_t* cli, const char* long_name);

/* Output; each returns a malloc'd string the caller frees. */
char* clyops_usage(clyops_t* cli);
char* clyops_json_schema(clyops_t* cli);
char* clyops_completion_data(clyops_t* cli);
char* clyops_values_json(const clyops_t* cli);

/* Logging: "YYYY-MM-DD HH:MM:SS [level] message" on stderr, printf-style. */
void clyops_set_silent(int silent);
void clyops_info(const char* fmt, ...);
void clyops_warn(const char* fmt, ...);
void clyops_errorf(const char* fmt, ...);
void clyops_success(const char* fmt, ...);
void clyops_die(int code, const char* fmt, ...);

#ifdef __cplusplus
}
#endif

#endif /* CLYOPS_H */
