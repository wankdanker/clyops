/* Unit tests for the C API surface the conformance suite cannot see. */
#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

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

static void test_secret_and_relationships(void) {
    unsetenv("A");
    clyops_t* cli = clyops_new("t");
    clyops_opt(cli, "TOKEN", "token", "optional", .rule = "secret:string:3-");
    clyops_opt(cli, "A", "a", "flag", .short_name = 'a');
    clyops_opt(cli, "B", "b", "flag", .short_name = 'b');
    clyops_opt(cli, "C", "c", "optional", .short_name = 'c');
    clyops_exclusive(cli, "a", "b");
    clyops_requires(cli, "c", "a");
    clyops_one_of(cli, "a", "b", "c");
    char* ok[] = {"--token", "abcd", "-a", "--no-b"};
    CHECK(clyops_parse(cli, 4, ok) == CLYOPS_OK);
    CHECK(strcmp(clyops_get(cli, "TOKEN"), "abcd") == 0);
    char* values = clyops_values_json(cli);
    CHECK(strstr(values, "\"TOKEN\": \"***\"") != NULL);
    free(values);
    char* schema = clyops_json_schema(cli);
    CHECK(strstr(schema, "\"secret\": true") != NULL && strstr(schema, "\"validation\": \"string:3-\"") != NULL);
    free(schema);
    char* both[] = {"-ab"};
    CHECK(clyops_parse(cli, 1, both) == CLYOPS_ERROR);
    CHECK(strcmp(clyops_error(cli), "Options --a and --b cannot be used together") == 0);
    char* needs[] = {"-c", "x"};
    CHECK(clyops_parse(cli, 2, needs) == CLYOPS_ERROR);
    CHECK(strcmp(clyops_error(cli), "Option --c requires --a") == 0);
    CHECK(clyops_parse(cli, 0, NULL) == CLYOPS_ERROR);
    CHECK(strcmp(clyops_error(cli), "One of --a, --b, --c is required") == 0);
    clyops_free(cli);
}

static void test_commands(void) {
    clyops_t* cli = clyops_new("m");
    clyops_opt(cli, "CONFIG", "config", "optional", .short_name = 'c', .group = "Global");
    clyops_t* migrate = clyops_command(clyops_command(cli, "db", "Database"), "migrate", "Migrate");
    clyops_opt(migrate, "TO", "to", "optional", .rule = "int");
    clyops_arg(migrate, "name", .default_value = "all");
    char* argv[] = {"db", "-c", "x", "migrate", "--to", "3"};
    CHECK(clyops_parse(cli, 6, argv) == CLYOPS_OK);
    CHECK(clyops_get_count(cli, "command") == 2 && strcmp(clyops_get_at(cli, "command", 1), "migrate") == 0);
    CHECK(clyops_get_int(cli, "TO") == 3 && strcmp(clyops_get(cli, "CONFIG"), "x") == 0);
    char* early[] = {"--to", "3", "db", "migrate"};
    CHECK(clyops_parse(cli, 4, early) == CLYOPS_ERROR && strcmp(clyops_error(cli), "Unknown option: --to") == 0);
    char* group[] = {"db"};
    CHECK(clyops_parse(cli, 1, group) == CLYOPS_ERROR && strcmp(clyops_error(cli), "Missing command") == 0);
    char* unknown[] = {"db", "seed"};
    CHECK(clyops_parse(cli, 2, unknown) == CLYOPS_ERROR && strcmp(clyops_error(cli), "Unknown command: seed") == 0);
    char* help[] = {"db", "migrate", "-h"};
    CHECK(clyops_parse(cli, 3, help) == CLYOPS_HELP);
    char* usage = clyops_usage(cli);
    CHECK(strncmp(usage, "Usage: m db migrate [<name>] [OPTIONS]", 38) == 0);
    free(usage);
    clyops_free(cli);
}

/* Run `fn` in a child with stderr captured; true when it exits 2 printing `message`. */
static int dies_with(void (*fn)(void), const char* message) {
    int pipefd[2];
    if (pipe(pipefd) != 0) return 0;
    pid_t pid = fork();
    if (pid == 0) {
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[0]);
        fn();
        _exit(0);
    }
    close(pipefd[1]);
    char buf[512] = {0};
    size_t len = 0;
    ssize_t n;
    while (len < sizeof buf - 1 && (n = read(pipefd[0], buf + len, sizeof buf - 1 - len)) > 0) len += (size_t)n;
    close(pipefd[0]);
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) && WEXITSTATUS(status) == 2 && strstr(buf, message) != NULL;
}

static void fd_low(void) { clyops_fd(clyops_new("t"), 2, "out", .description = "X"); }
static void fd_direction(void) { clyops_fd(clyops_new("t"), 3, "both", .description = "X"); }
static void fd_digit_role(void) { clyops_fd(clyops_new("t"), 3, "out", .description = "X", .role = "7"); }
static void fd_duplicate(void) {
    clyops_t* cli = clyops_new("t");
    clyops_fd(cli, 3, "out", .description = "X");
    clyops_fd(cli, 3, "in", .description = "Y");
}
static void fd_duplicate_role(void) {
    clyops_t* cli = clyops_new("t");
    clyops_fd(cli, 3, "out", .description = "X", .role = "log");
    clyops_fd(cli, 4, "out", .description = "Y", .role = "log");
}
static void fd_emit_undeclared(void) { clyops_emit(clyops_new("t"), "nope", "x"); }
static void fd_emit_input(void) {
    clyops_t* cli = clyops_new("t");
    clyops_fd(cli, 9, "in", .description = "X");
    clyops_emit(cli, "9", "x");
}

static void test_fds(void) {
    CHECK(dies_with(fd_low, "Invalid file descriptor 2"));
    CHECK(dies_with(fd_direction, "Unknown fd direction 'both'"));
    CHECK(dies_with(fd_digit_role, "Invalid fd role '7'"));
    CHECK(dies_with(fd_duplicate, "Duplicate file descriptor 3"));
    CHECK(dies_with(fd_duplicate_role, "Duplicate fd role 'log'"));
    CHECK(dies_with(fd_emit_undeclared, "No file descriptor declared for 'nope'"));
    CHECK(dies_with(fd_emit_input, "File descriptor 9 is not an output"));

    FILE* tmp = tmpfile();
    int fd = fileno(tmp);
    char num[16], listed[32];
    snprintf(num, sizeof num, "%d", fd);
    clyops_t* cli = clyops_new("t");
    clyops_fd(cli, fd, "out", .description = "Progress", .role = "progress", .schema = "{\"type\":\"object\"}");
    clyops_fd(cli, 999, "in", .description = "Extra");
    char* none[] = {NULL};
    CHECK(clyops_parse(cli, 0, none) == CLYOPS_OK);
    unsetenv("CLYOPS_FDS");
    CHECK(clyops_fd_open(cli, "progress") == -1);
    clyops_emit(cli, "progress", "never");
    snprintf(listed, sizeof listed, " %d , 999", fd);
    setenv("CLYOPS_FDS", listed, 1);
    CHECK(clyops_fd_open(cli, "progress") == fd);
    CHECK(clyops_fd_open(cli, num) == fd);
    CHECK(clyops_fd_open(cli, "999") == -1);
    clyops_emit(cli, "progress", "{\"pct\":50}");
    clyops_emit(cli, num, "plain text");
    clyops_emit(cli, "progress", "ends with newline\n");
    unsetenv("CLYOPS_FDS");
    char got[128] = {0};
    rewind(tmp);
    CHECK(fread(got, 1, sizeof got - 1, tmp) > 0);
    CHECK(strcmp(got, "{\"pct\":50}\nplain text\nends with newline\n") == 0);
    fclose(tmp);
    char* schema = clyops_json_schema(cli);
    CHECK(strstr(schema, "\"role\": \"progress\", \"description\": \"Progress\", \"contentType\": \"\", \"schema\": {\"type\":\"object\"}}") != NULL);
    CHECK(strstr(schema, "{\"fd\": 999, \"direction\": \"in\", \"role\": \"\"") != NULL);
    free(schema);
    clyops_free(cli);

    cli = clyops_new("m");
    clyops_fd(cli, 3, "out", .description = "Progress", .role = "progress");
    clyops_t* migrate = clyops_command(clyops_command(cli, "db", "Database"), "migrate", "Migrate");
    clyops_fd(migrate, 4, "out", .description = "Migration progress", .role = "progress");
    char* argv[] = {"db", "migrate"};
    CHECK(clyops_parse(cli, 2, argv) == CLYOPS_OK);
    char* usage = clyops_usage(cli);
    CHECK(strstr(usage, "\nOutput fd 4 [progress]: Migration progress\n") != NULL);
    CHECK(strstr(usage, "fd 3") == NULL);
    free(usage);
    clyops_free(cli);
}

int main(void) {
    test_typed_values();
    test_errors_and_help();
    test_environment();
    test_output();
    test_secret_and_relationships();
    test_commands();
    test_fds();
    if (failures) {
        fprintf(stderr, "%d failed\n", failures);
        return 1;
    }
    puts("all passed");
    return 0;
}
