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

static void role_bad_name(void) { clyops_role(clyops_new("t"), "7up", "out", .description = "X"); }
static void role_colon(void) { clyops_role(clyops_new("t"), "a:b", "out", .description = "X"); }
static void role_direction(void) { clyops_role(clyops_new("t"), "log", "both", .description = "X"); }
static void role_duplicate(void) {
    clyops_t* cli = clyops_new("t");
    clyops_role(cli, "log", "out", .description = "X");
    clyops_role(cli, "log", "in", .description = "Y");
}
static void role_emit_unknown(void) { clyops_emit(clyops_new("t"), "nope", "x"); }
static void role_emit_input(void) {
    clyops_t* cli = clyops_new("t");
    clyops_role(cli, "extra", "in", .description = "X");
    clyops_emit(cli, "extra", "x");
}

/* Run `fn` in a child (the mapping is read once per process); true when its checks all passed. */
static int in_child(void (*fn)(void)) {
    fflush(NULL);
    pid_t pid = fork();
    if (pid == 0) {
        failures = 0;
        fn();
        _exit(failures ? 1 : 0);
    }
    int status = 0;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static void child_mapping(void) {
    FILE* tmp = tmpfile();
    int fd = fileno(tmp);
    char mapping[64], forwarded[64];
    snprintf(mapping, sizeof mapping, " progress:%d , extra:999, log:%d", fd, fd);
    setenv("CLYOPS_FDS", mapping, 1);
    clyops_t* cli = clyops_new("t");
    clyops_role(cli, "progress", "out", .description = "Progress", .schema = "{\"type\":\"object\"}");
    clyops_role(cli, "extra", "in", .description = "Extra");
    char* none[] = {NULL};
    CHECK(clyops_parse(cli, 0, none) == CLYOPS_OK);
    CHECK(getenv("CLYOPS_FDS") == NULL);
    CHECK(clyops_fd_open(cli, "progress") == fd);
    CHECK(clyops_fd_open(cli, "extra") == -1);
    CHECK(clyops_fd_open(cli, "log") == -1);
    clyops_emit(cli, "progress", "{\"pct\":50}");
    clyops_emit(cli, "progress", "plain text");
    clyops_emit(cli, "progress", "ends with newline\n");
    char* fw = clyops_forward_fds(cli, "progress", "extra", "log", "nope");
    snprintf(forwarded, sizeof forwarded, "progress:%d,log:%d", fd, fd);
    CHECK(strcmp(fw, forwarded) == 0);
    free(fw);
    char got[128] = {0};
    rewind(tmp);
    CHECK(fread(got, 1, sizeof got - 1, tmp) > 0);
    CHECK(strcmp(got, "{\"pct\":50}\nplain text\nends with newline\n") == 0);
    fclose(tmp);
    char* schema = clyops_json_schema(cli);
    CHECK(strstr(schema, "{\"name\": \"progress\", \"direction\": \"out\", \"description\": \"Progress\", \"contentType\": \"\", \"schema\": {\"type\":\"object\"}}") != NULL);
    free(schema);
    clyops_free(cli);
}

static void child_unmapped(void) {
    unsetenv("CLYOPS_FDS");
    clyops_t* cli = clyops_new("t");
    clyops_role(cli, "progress", "out", .description = "Progress");
    char* none[] = {NULL};
    CHECK(clyops_parse(cli, 0, none) == CLYOPS_OK);
    CHECK(clyops_fd_open(cli, "progress") == -1);
    clyops_emit(cli, "progress", "nothing happens");
    char* fw = clyops_forward_fds(cli, "progress");
    CHECK(strcmp(fw, "") == 0);
    free(fw);
    clyops_free(cli);
}

static void child_scope(void) {
    setenv("CLYOPS_FDS", "progress:2,plan:2", 1);
    clyops_t* cli = clyops_new("m");
    clyops_role(cli, "progress", "out", .description = "Progress");
    clyops_t* db = clyops_command(cli, "db", "Database");
    clyops_t* migrate = clyops_command(db, "migrate", "Migrate");
    clyops_role(migrate, "plan", "out", .description = "Migration plan");
    clyops_command(db, "status", "Status");
    char* status[] = {"db", "status"};
    CHECK(clyops_parse(cli, 2, status) == CLYOPS_OK);
    CHECK(clyops_fd_open(cli, "progress") == 2);
    CHECK(clyops_fd_open(cli, "plan") == -1);
    char* argv[] = {"db", "migrate"};
    CHECK(clyops_parse(cli, 2, argv) == CLYOPS_OK);
    CHECK(clyops_fd_open(cli, "plan") == 2);
    char* usage = clyops_usage(cli);
    CHECK(strstr(usage, "\nOutput [plan]: Migration plan\n") != NULL);
    CHECK(strstr(usage, "[progress]") == NULL);
    free(usage);
    clyops_free(cli);
}

static void test_roles(void) {
    CHECK(dies_with(role_bad_name, "Invalid role name '7up'"));
    CHECK(dies_with(role_colon, "Invalid role name 'a:b'"));
    CHECK(dies_with(role_direction, "Unknown role direction 'both'"));
    CHECK(dies_with(role_duplicate, "Duplicate role 'log'"));
    CHECK(dies_with(role_emit_unknown, "Unknown role 'nope'"));
    CHECK(dies_with(role_emit_input, "Role 'extra' is not an output"));
    CHECK(in_child(child_mapping));
    CHECK(in_child(child_unmapped));
    CHECK(in_child(child_scope));
}

static int completer_calls;

/* Returns the words it got, then values to drop: empty, a comma, a space, a duplicate. */
static clyops_complete_request_t last_request;

static int echo_words(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    completer_calls++;
    last_request = *req;
    clyops_values_add(out, (const char*)userdata);
    for (int i = 0; i < req->nwords; i++) clyops_values_add(out, req->words[i]);
    clyops_values_add(out, "");
    clyops_values_add(out, "a,b");
    clyops_values_add(out, "a b");
    clyops_values_add(out, "tab\there");
    clyops_values_add(out, (const char*)userdata);
    return 0;
}

static int failing(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)req, (void)userdata;
    completer_calls++;
    clyops_values_add(out, "ignored");
    return 1;
}

static int nothing(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)req, (void)out, (void)userdata;
    completer_calls++;
    return 0;
}

static void complete_unknown(void) { clyops_complete(make(), "nope", nothing, NULL); }
static void complete_flag(void) { clyops_complete(make(), "fast", nothing, NULL); }

static void test_complete(void) {
    CHECK(dies_with(complete_unknown, "Unknown option or argument 'nope' for complete"));
    CHECK(dies_with(complete_flag, "Flag --fast takes no value to complete"));

    clyops_t* cli = make();
    clyops_complete(cli, "count", echo_words, "first");
    clyops_complete(cli, "tag", failing, NULL);
    clyops_complete(cli, "file", nothing, NULL);
    completer_calls = 0;
    char* argv[] = {"a.txt", "--count", "4"};
    CHECK(clyops_parse(cli, 3, argv) == CLYOPS_OK);
    char* usage = clyops_usage(cli);
    char* schema = clyops_json_schema(cli);
    CHECK(completer_calls == 0);
    CHECK(strstr(schema, "\"name\": \"file\"") != NULL);
    CHECK(strstr(schema, "\"schema\": null,\n      \"dynamic\": true\n") != NULL);
    CHECK(strstr(schema, "\"secret\": false,\n      \"dynamic\": true\n") != NULL);
    CHECK(strstr(schema, "\"secret\": false,\n      \"dynamic\": false\n") != NULL);
    char* words[] = {"x", "-v", NULL};
    char* data = clyops_completion_data_for(cli, 2, words);
    CHECK(completer_calls == 3);
    CHECK(last_request.limit == 0 && last_request.offset == 0 && strcmp(last_request.prefix, "") == 0);
    CHECK(strstr(data, "opt\t--count\t-n\tvalue\tchoice\tfirst,x,-v\t") != NULL);
    CHECK(strstr(data, "opt\t--tag\t-t\tvalue\tdefault\t-\t") != NULL);
    CHECK(strstr(data, "arg\tfile\tsingle\tchoice\t-\tFile\n") != NULL);
    free(data);
    free(usage);
    free(schema);
    clyops_free(cli);

    /* With commands, a completer gets the words after them; a parent option uses its own. */
    clyops_t* m = clyops_new("m");
    clyops_opt(m, "URL", "url", "optional", .description = "URL");
    clyops_complete(m, "url", echo_words, "top");
    clyops_t* db = clyops_command(m, "db", "Database");
    clyops_arg(db, "name", .default_value = "main");
    clyops_complete(db, "name", echo_words, "n");
    char* cwords[] = {"db", "y", NULL};
    char* cdata = clyops_completion_data_for(m, 2, cwords);
    CHECK(strstr(cdata, "skip\t1\n") != NULL);
    CHECK(strstr(cdata, "opt\t--url\t-\tvalue\tchoice\ttop,y\t") != NULL);
    CHECK(strstr(cdata, "arg\tname\tsingle\tchoice\tn,y\t") != NULL);
    free(cdata);
    clyops_free(m);
}

/* A fixed list: alpha, beta, albert, has space, a,b, a duplicate and an empty value. */
static int fixed_list(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)req, (void)userdata;
    const char* all[] = {"alpha", "beta", "albert", "has space", "a,b", "alpha", ""};
    for (size_t i = 0; i < sizeof all / sizeof *all; i++) clyops_values_add(out, all[i]);
    return 0;
}

/* Paged: returns x, y, z up to the request's limit. */
static int xyz(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)userdata;
    last_request = *req;
    completer_calls = req->nwords == 1 && strcmp(req->words[0], "-f") == 0;
    const char* all[] = {"x", "y", "z"};
    for (int i = 0; i < 3 && i < req->limit; i++) clyops_values_add(out, all[i]);
    return 0;
}

static int only(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)req, (void)userdata;
    clyops_values_add(out, "only");
    return 0;
}

static int many(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)req, (void)userdata;
    char v[16];
    for (int i = 0; i < 1500; i++) {
        snprintf(v, sizeof v, "v%d", i);
        clyops_values_add(out, v);
    }
    return 0;
}

static int words_back(const clyops_complete_request_t* req, clyops_values_t* out, void* userdata) {
    (void)userdata;
    for (int i = 0; i < req->nwords; i++) clyops_values_add(out, req->words[i]);
    return 0;
}

static int page_is(const clyops_values_page_t* page, const char* joined, int more) {
    char buf[256] = "";
    for (size_t i = 0; i < page->count; i++) {
        if (i) strcat(buf, "|");
        strcat(buf, page->values[i]);
    }
    return strcmp(buf, joined) == 0 && page->more == more;
}

/* Run clyops_complete_values and compare the page, freeing it. */
static int values_are(clyops_t* cli, const char* name, const char* prefix, int limit, int offset, int nwords, const char* const* words, const char* joined, int more) {
    clyops_values_page_t page;
    if (clyops_complete_values(cli, name, prefix, limit, offset, nwords, words, &page) != 0) return 0;
    int ok = page_is(&page, joined, more);
    clyops_values_page_free(&page);
    return ok;
}

static int values_fail(clyops_t* cli, const char* name, int nwords, const char* const* words, const char* message) {
    clyops_values_page_t page;
    return clyops_complete_values(cli, name, "", 5, 0, nwords, words, &page) == -1 && page.count == 0 && strcmp(clyops_error(cli), message) == 0;
}

static void test_complete_values(void) {
    clyops_t* cli = make();
    clyops_complete(cli, "count", fixed_list, NULL);
    CHECK(values_are(cli, "count", "", 10, 0, 0, NULL, "alpha|beta|albert|has space|a,b", 0));
    CHECK(values_are(cli, "count", "al", 1, 0, 0, NULL, "alpha", 1));
    CHECK(values_are(cli, "count", "al", 1, 1, 0, NULL, "albert", 0));
    clyops_free(cli);

    clyops_t* paged = make();
    clyops_complete_paged(paged, "count", xyz, NULL);
    const char* f[] = {"-f"};
    completer_calls = 0;
    CHECK(values_are(paged, "count", "q", 2, 40, 1, f, "x|y", 1));
    CHECK(completer_calls == 1);
    CHECK(strcmp(last_request.prefix, "q") == 0 && last_request.limit == 3 && last_request.offset == 40);
    /* Registering again replaces the completer and its mode. */
    clyops_complete(paged, "count", only, NULL);
    CHECK(values_are(paged, "count", "", 5, 0, 0, NULL, "only", 0));
    clyops_free(paged);

    clyops_t* none = make();
    CHECK(values_fail(none, "count", 0, NULL, "No completer for 'count'"));
    clyops_complete(none, "count", failing, NULL);
    CHECK(values_fail(none, "count", 0, NULL, "Completer for 'count' failed"));
    clyops_free(none);

    /* Shell completion keeps at most 1000 values. */
    clyops_t* lots = make();
    clyops_complete(lots, "count", many, NULL);
    char* data = clyops_completion_data(lots);
    const char* rec = strstr(data, "opt\t--count\t-n\tvalue\tchoice\t");
    CHECK(rec != NULL);
    if (rec) {
        const char* p = rec + strlen("opt\t--count\t-n\tvalue\tchoice\t");
        size_t commas = 0;
        for (; *p && *p != '\t'; p++) commas += *p == ',';
        CHECK(commas == 999);
    }
    free(data);
    clyops_free(lots);
}

static void test_complete_values_commands(void) {
    clyops_t* cli = clyops_new("t");
    clyops_t* db = clyops_command(cli, "db", "Database");
    clyops_opt(db, "URL", "url", "optional", .description = "URL");
    clyops_complete(db, "url", only, NULL);
    clyops_t* migrate = clyops_command(db, "migrate", "Migrate");
    clyops_arg(migrate, "target", .description = "Target");
    clyops_complete(migrate, "target", words_back, NULL);
    const char* dm[] = {"db", "migrate"};
    CHECK(values_are(cli, "url", "", 5, 0, 2, dm, "only", 0));
    const char* dmx[] = {"db", "migrate", "-n", "x"};
    CHECK(values_are(cli, "target", "", 5, 0, 4, dmx, "-n|x", 0));
    const char* d[] = {"db"};
    CHECK(values_fail(cli, "target", 1, d, "No completer for 'target'"));
    CHECK(values_fail(cli, "url", 0, NULL, "No completer for 'url'"));
    clyops_free(cli);
}

int main(void) {
    test_roles(); /* first: the CLYOPS_FDS mapping is read by the first parse in a process */
    test_typed_values();
    test_errors_and_help();
    test_environment();
    test_output();
    test_secret_and_relationships();
    test_commands();
    test_complete();
    test_complete_values();
    test_complete_values_commands();
    if (failures) {
        fprintf(stderr, "%d failed\n", failures);
        return 1;
    }
    puts("all passed");
    return 0;
}
