/* Unit tests for the C API surface the conformance suite cannot see. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "clyops.h"

static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            fprintf(stderr, "not ok - %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                 \
        }                                                               \
    } while (0)

static clyops_t* make(void) {
    clyops_t* cli = clyops_new("t");
    clyops_arg(cli, "file", .description = "File");
    clyops_opt(cli, "COUNT", "count", "2", .short_name = 'n', .rule = "int:1-5");
    clyops_opt(cli, "FAST", "fast", "flag", .short_name = 'f');
    clyops_opt(cli, "ON", "on", "yes", .rule = "bool");
    clyops_opt_array(cli, "TAG", "tag", .short_name = 't');
    return cli;
}

static void test_typed_values(void) {
    clyops_t* cli = make();
    char* argv[] = {"a.txt", "-fn", "4", "-t", "x", "--tag=y"};
    CHECK(clyops_parse(cli, 6, argv) == CLYOPS_OK);
    CHECK(strcmp(clyops_get(cli, "file"), "a.txt") == 0);
    CHECK(clyops_get_int(cli, "COUNT") == 4);
    CHECK(clyops_get_bool(cli, "FAST"));
    CHECK(clyops_get_bool(cli, "ON")); /* bool rule normalizes "yes" to "true" */
    CHECK(clyops_get_count(cli, "TAG") == 2);
    CHECK(strcmp(clyops_get_at(cli, "TAG", 1), "y") == 0);
    CHECK(clyops_get_at(cli, "TAG", 2) == NULL);
    CHECK(clyops_is_set(cli, "--fast"));
    CHECK(strcmp(clyops_source(cli, "count"), "cli") == 0);
    CHECK(strcmp(clyops_source(cli, "on"), "default") == 0);
    clyops_free(cli);
}

static void test_errors_and_help(void) {
    clyops_t* cli = make();
    char* bad[] = {"a", "--count", "9"};
    CHECK(clyops_parse(cli, 3, bad) == CLYOPS_ERROR);
    CHECK(strcmp(clyops_error(cli), "--count must be <= 5, got 9") == 0);
    char* help[] = {"--help"};
    CHECK(clyops_parse(cli, 1, help) == CLYOPS_HELP);
    clyops_free(cli);
}

static void test_environment(void) {
    setenv("COUNT", "3", 1);
    clyops_t* cli = make();
    char* argv[] = {"a"};
    CHECK(clyops_parse(cli, 1, argv) == CLYOPS_OK);
    CHECK(clyops_get_int(cli, "COUNT") == 3);
    CHECK(clyops_is_explicitly_set(cli, "count") && !clyops_is_set(cli, "count"));
    unsetenv("COUNT");
    clyops_free(cli);
}

static void test_output(void) {
    clyops_t* cli = make();
    char* usage = clyops_usage(cli);
    CHECK(strstr(usage, "Usage: t <file> [OPTIONS]\n") == usage);
    CHECK(strstr(usage, "  -n, --count=<value>           (default: 2, accepts: integer: 1-5)\n") != NULL);
    char* schema = clyops_json_schema(cli);
    CHECK(strstr(schema, "\"variableName\": \"COUNT\"") != NULL);
    free(usage);
    free(schema);
    clyops_free(cli);
}

int main(void) {
    test_typed_values();
    test_errors_and_help();
    test_environment();
    test_output();
    if (failures) {
        fprintf(stderr, "%d failed\n", failures);
        return 1;
    }
    puts("all passed");
    return 0;
}
