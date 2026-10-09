/* clyops — declarative CLI parsing for C11 (POSIX). Behavior follows spec/SPEC.md. */
#define _POSIX_C_SOURCE 200809L

#include "clyops.h"
#include "completions.h"

#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <regex.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

static void* xalloc(size_t n) {
    void* p = calloc(1, n ? n : 1);
    if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
    return p;
}

static char* xstrdup(const char* s) {
    if (!s) return NULL;
    size_t n = strlen(s);
    char* d = xalloc(n + 1);
    memcpy(d, s, n);
    return d;
}

static char* xstrndup(const char* s, size_t n) {
    char* d = xalloc(n + 1);
    memcpy(d, s, n);
    return d;
}

static char* vfmt(const char* fmt, va_list ap) {
    va_list cp;
    va_copy(cp, ap);
    int n = vsnprintf(NULL, 0, fmt, cp);
    va_end(cp);
    char* out = xalloc((size_t)n + 1);
    vsnprintf(out, (size_t)n + 1, fmt, ap);
    return out;
}

static char* fmt(const char* f, ...) {
    va_list ap;
    va_start(ap, f);
    char* out = vfmt(f, ap);
    va_end(ap);
    return out;
}

static int streq(const char* a, const char* b) { return a && b && strcmp(a, b) == 0; }
static int empty(const char* s) { return !s || !*s; }
static int starts(const char* s, const char* p) { return strncmp(s, p, strlen(p)) == 0; }

/* Growable string */
typedef struct { char* s; size_t len, cap; } sbuf;

static void sb_putn(sbuf* b, const char* s, size_t n) {
    if (b->len + n + 1 > b->cap) {
        b->cap = (b->len + n + 1) * 2;
        char* p = realloc(b->s, b->cap);
        if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
        b->s = p;
    }
    memcpy(b->s + b->len, s, n);
    b->len += n;
    b->s[b->len] = 0;
}
static void sb_put(sbuf* b, const char* s) { sb_putn(b, s, strlen(s)); }
static void sb_putc(sbuf* b, char c) { sb_putn(b, &c, 1); }
static void sb_printf(sbuf* b, const char* f, ...) {
    va_list ap;
    va_start(ap, f);
    char* s = vfmt(f, ap);
    va_end(ap);
    sb_put(b, s);
    free(s);
}
static char* sb_take(sbuf* b) { return b->s ? b->s : xstrdup(""); }

/* Growable string list */
typedef struct { char** v; size_t len, cap; } svec;

static void sv_push(svec* l, char* owned) {
    if (l->len == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 4;
        char** p = realloc(l->v, l->cap * sizeof(char*));
        if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
        l->v = p;
    }
    l->v[l->len++] = owned;
}
static void sv_clear(svec* l) {
    for (size_t i = 0; i < l->len; i++) free(l->v[i]);
    l->len = 0;
}
static void sv_free(svec* l) { sv_clear(l); free(l->v); l->v = NULL; l->cap = 0; }

static size_t utf8_len(const char* s) {
    size_t n = 0;
    for (; *s; s++) if (((unsigned char)*s & 0xC0) != 0x80) n++;
    return n;
}

/* Full-match (anchored) or search an ERE. */
static int re_match(const char* pattern, const char* s) {
    regex_t re;
    if (regcomp(&re, pattern, REG_EXTENDED | REG_NOSUB) != 0) return 0;
    int ok = regexec(&re, s, 0, NULL, 0) == 0;
    regfree(&re);
    return ok;
}

static int bool_word(const char* v, int* out) {
    static const char* t[] = {"true", "yes", "1", "on"};
    static const char* f[] = {"false", "no", "0", "off"};
    char lower[8];
    size_t n = strlen(v);
    if (n >= sizeof lower) return 0;
    for (size_t i = 0; i <= n; i++) lower[i] = (char)tolower((unsigned char)v[i]);
    for (int i = 0; i < 4; i++) {
        if (streq(lower, t[i])) { *out = 1; return 1; }
        if (streq(lower, f[i])) { *out = 0; return 1; }
    }
    return 0;
}

/* ------------------------------------------------------------------------- */
/* Logging                                                                   */
/* ------------------------------------------------------------------------- */

static int g_silent = -1;

void clyops_set_silent(int silent) { g_silent = silent; }

static void emit(const char* level, const char* msg, int force) {
    if (g_silent < 0) g_silent = streq(getenv("CLYOPS_SILENT"), "true");
    if (g_silent && !force) return;
    char ts[32];
    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tm);
    if (isatty(STDERR_FILENO) && !getenv("NO_COLOR")) {
        const char* color = streq(level, "info") ? "1;37" : streq(level, "warning") ? "0;33" : streq(level, "success") ? "0;32" : "0;31";
        fprintf(stderr, "%s [\033[%sm%s\033[0m] %s\n", ts, color, level, msg);
    } else {
        fprintf(stderr, "%s [%s] %s\n", ts, level, msg);
    }
}

#define LOGFN(fn, level)                     \
    void fn(const char* f, ...) {            \
        va_list ap;                          \
        va_start(ap, f);                     \
        char* m = vfmt(f, ap);               \
        va_end(ap);                          \
        emit(level, m, 0);                   \
        free(m);                             \
    }
LOGFN(clyops_info, "info")
LOGFN(clyops_warn, "warning")
LOGFN(clyops_errorf, "error")
LOGFN(clyops_success, "success")

void clyops_die(int code, const char* f, ...) {
    va_list ap;
    va_start(ap, f);
    char* m = vfmt(f, ap);
    va_end(ap);
    emit("error", m, 1);
    free(m);
    exit(code);
}

/* ------------------------------------------------------------------------- */
/* Model                                                                     */
/* ------------------------------------------------------------------------- */

enum { K_FLAG, K_VALUE, K_ARRAY };

typedef struct {
    char *var, *long_name, *dflt, *desc, *group, *rule, *search_raw;
    char short_name;
    int kind, required, secret;
    svec search; /* absolute search dirs, computed per parse */
    /* per parse */
    int has;
    char* raw;
    svec list;
    const char* src;
    const char* cfg_dir;
} opt_t;

typedef struct {
    char *name, *desc, *dflt, *rule;
    int variadic;
    int has;
    char* raw;
    svec list;
} arg_t;

typedef struct { char *key, *value, *dir; } cfg_t;

struct clyops {
    char *name, *root, *cwd, *root_abs, *description, *epilog, *config_option;
    svec prefixes;
    opt_t* opts;
    size_t nopts, capopts;
    arg_t* args;
    size_t nargs, capargs;
    svec cmds, cmd_desc, cmd_hint;
    cfg_t* cfg;
    size_t ncfg, capcfg;
    char* error;
    svec detail;
    int show_usage;
    svec effects;
    char *stdin_desc, *stdin_type, *stdout_desc, *stdout_type; /* NULL desc: undeclared */
    svec con_type, con_opts; /* relationships: type and space-separated long names */
    clyops_t** kids;
    size_t nkids, capkids;
    clyops_t* parent;
    char* word;
    /* On the program: the selected command, its words, and the chain's options, deepest first. */
    clyops_t* selected;
    svec words;
    opt_t** chain;
    size_t nchain;
};

clyops_t* clyops_new(const char* name) {
    clyops_t* cli = xalloc(sizeof *cli);
    cli->name = xstrdup(name);
    cli->root = xstrdup(".");
    cli->selected = cli;
    return cli;
}

/* The commands from the program down to the selected one (at most 64 deep). */
static size_t nodes_down(const clyops_t* root, const clyops_t** out) {
    size_t n = 0;
    for (const clyops_t* c = root->selected; c && n < 64; c = c == root ? NULL : c->parent) out[n++] = c;
    for (size_t i = 0; i < n / 2; i++) {
        const clyops_t* t = out[i];
        out[i] = out[n - 1 - i];
        out[n - 1 - i] = t;
    }
    return n;
}

/* Collect the chain's options, deepest command first. */
static void rebuild_chain(clyops_t* root) {
    root->nchain = 0;
    for (const clyops_t* c = root->selected; c; c = c == root ? NULL : c->parent) {
        root->chain = realloc(root->chain, (root->nchain + c->nopts + 1) * sizeof *root->chain);
        if (!root->chain) { fputs("clyops: out of memory\n", stderr); exit(70); }
        for (size_t i = 0; i < c->nopts; i++) root->chain[root->nchain++] = &c->opts[i];
    }
}

static void reset_parse(clyops_t* cli) {
    for (size_t i = 0; i < cli->nkids; i++) reset_parse(cli->kids[i]);
    sv_clear(&cli->words);
    for (size_t i = 0; i < cli->nopts; i++) {
        opt_t* o = &cli->opts[i];
        o->has = 0;
        free(o->raw);
        o->raw = NULL;
        sv_clear(&o->list);
        o->src = NULL;
        o->cfg_dir = NULL;
    }
    for (size_t i = 0; i < cli->nargs; i++) {
        arg_t* a = &cli->args[i];
        a->has = 0;
        free(a->raw);
        a->raw = NULL;
        sv_clear(&a->list);
    }
    for (size_t i = 0; i < cli->ncfg; i++) {
        free(cli->cfg[i].key);
        free(cli->cfg[i].value);
        free(cli->cfg[i].dir);
    }
    cli->ncfg = 0;
    free(cli->error);
    cli->error = NULL;
    sv_clear(&cli->detail);
    cli->show_usage = 1;
}

void clyops_free(clyops_t* cli) {
    if (!cli) return;
    reset_parse(cli);
    for (size_t i = 0; i < cli->nopts; i++) {
        opt_t* o = &cli->opts[i];
        free(o->var); free(o->long_name); free(o->dflt); free(o->desc); free(o->group); free(o->rule); free(o->search_raw);
        sv_free(&o->search);
        sv_free(&o->list);
    }
    for (size_t i = 0; i < cli->nargs; i++) {
        arg_t* a = &cli->args[i];
        free(a->name); free(a->desc); free(a->dflt); free(a->rule);
        sv_free(&a->list);
    }
    for (size_t i = 0; i < cli->nkids; i++) clyops_free(cli->kids[i]);
    free(cli->kids); free(cli->chain); sv_free(&cli->words);
    free(cli->opts); free(cli->args); free(cli->cfg);
    sv_free(&cli->cmds); sv_free(&cli->cmd_desc); sv_free(&cli->cmd_hint); sv_free(&cli->prefixes); sv_free(&cli->detail);
    sv_free(&cli->effects); sv_free(&cli->con_type); sv_free(&cli->con_opts);
    free(cli->stdin_desc); free(cli->stdin_type); free(cli->stdout_desc); free(cli->stdout_type); free(cli->word);
    free(cli->name); free(cli->root); free(cli->cwd); free(cli->root_abs);
    free(cli->description); free(cli->epilog); free(cli->config_option);
    free(cli);
}

static void set_str(char** dst, const char* s) { free(*dst); *dst = xstrdup(s ? s : ""); }

void clyops_root(clyops_t* cli, const char* dir) { set_str(&cli->root, empty(dir) ? "." : dir); }
void clyops_description(clyops_t* cli, const char* text) { set_str(&cli->description, text); }
void clyops_epilog(clyops_t* cli, const char* text) { set_str(&cli->epilog, text); }

static char* trim_dup(const char* s, size_t n) {
    while (n && isspace((unsigned char)*s)) { s++; n--; }
    while (n && isspace((unsigned char)s[n - 1])) n--;
    return xstrndup(s, n);
}

void clyops_config(clyops_t* cli, const char* option, const char* prefixes) {
    set_str(&cli->config_option, option);
    sv_clear(&cli->prefixes);
    const char* p = prefixes ? prefixes : "";
    while (1) {
        const char* comma = strchr(p, ',');
        size_t n = comma ? (size_t)(comma - p) : strlen(p);
        char* item = trim_dup(p, n);
        if (*item) sv_push(&cli->prefixes, item); else free(item);
        if (!comma) break;
        p = comma + 1;
    }
}

void clyops_require_command(clyops_t* cli, const char* command, const char* description, const char* install_hint) {
    sv_push(&cli->cmds, xstrdup(command));
    sv_push(&cli->cmd_desc, xstrdup(description ? description : ""));
    sv_push(&cli->cmd_hint, xstrdup(install_hint ? install_hint : ""));
}

static opt_t* find_opt(const clyops_t* cli, const char* long_name) {
    for (size_t i = 0; i < cli->nopts; i++)
        if (streq(cli->opts[i].long_name, long_name)) return &cli->opts[i];
    return NULL;
}

static opt_t* find_short(const clyops_t* cli, char c) {
    for (size_t i = 0; i < cli->nopts; i++)
        if (cli->opts[i].short_name == c) return &cli->opts[i];
    return NULL;
}

/* An option of the selected chain, by long (or, when long_name is NULL, short) name. */
static opt_t* chain_find(const clyops_t* root, const char* long_name, char c) {
    for (size_t i = 0; i < root->nchain; i++)
        if (long_name ? streq(root->chain[i]->long_name, long_name) : root->chain[i]->short_name == c) return root->chain[i];
    return NULL;
}

void clyops_set_effects(clyops_t* cli, const char* const* effects) {
    sv_clear(&cli->effects);
    for (; *effects; effects++) {
        if (!streq(*effects, "read-only") && !streq(*effects, "idempotent") && !streq(*effects, "destructive") && !streq(*effects, "network"))
            clyops_die(2, "Unknown effect '%s'", *effects);
        sv_push(&cli->effects, xstrdup(*effects));
    }
}

void clyops_stdin(clyops_t* cli, const char* description, const char* content_type) {
    set_str(&cli->stdin_desc, description);
    set_str(&cli->stdin_type, content_type);
}

void clyops_stdout(clyops_t* cli, const char* description, const char* content_type) {
    set_str(&cli->stdout_desc, description);
    set_str(&cli->stdout_type, content_type);
}

void clyops_add_constraint(clyops_t* cli, const char* type, const char* const* long_names) {
    sbuf b = {0};
    for (; *long_names; long_names++) {
        const clyops_t* c = cli;
        while (c && !find_opt(c, *long_names)) c = c->parent;
        if (!c) clyops_die(2, "Unknown option --%s in constraint", *long_names);
        if (b.len) sb_putc(&b, ' ');
        sb_put(&b, *long_names);
    }
    sv_push(&cli->con_type, xstrdup(type));
    sv_push(&cli->con_opts, sb_take(&b));
}

clyops_t* clyops_command(clyops_t* cli, const char* name, const char* description) {
    if (cli->nargs) clyops_die(2, "Cannot mix commands and positional arguments");
    for (size_t i = 0; i < cli->nkids; i++)
        if (streq(cli->kids[i]->word, name)) clyops_die(2, "Duplicate command %s", name);
    if (cli->nkids == cli->capkids) {
        cli->capkids = cli->capkids ? cli->capkids * 2 : 4;
        clyops_t** p = realloc(cli->kids, cli->capkids * sizeof *p);
        if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
        cli->kids = p;
    }
    clyops_t* kid = clyops_new(NULL);
    kid->word = xstrdup(name);
    kid->description = xstrdup(description ? description : "");
    kid->parent = cli;
    cli->kids[cli->nkids++] = kid;
    return kid;
}

static clyops_t* find_kid(const clyops_t* cli, const char* word) {
    for (size_t i = 0; i < cli->nkids; i++) if (streq(cli->kids[i]->word, word)) return cli->kids[i];
    return NULL;
}

void clyops_path_search(clyops_t* cli, const char* long_name, const char* dirs) {
    opt_t* o = find_opt(cli, long_name);
    if (!o) clyops_die(2, "clyops_path_search: unknown option --%s", long_name);
    set_str(&o->search_raw, dirs);
    if (empty(o->rule)) set_str(&o->rule, "path");
}

static int known_rule(const char* r) {
    static const char* fixed[] = {"int", "float", "string", "path", "ip", "hostname", "url", "port", "email", "uuid", "bool",
                                  "date:YYYY-MM-DD", "file:exists", "file:readable", "file:writable", "dir:exists", "dir:writable"};
    if (empty(r)) return 1;
    for (size_t i = 0; i < sizeof fixed / sizeof *fixed; i++) if (streq(r, fixed[i])) return 1;
    if (re_match("^int:([0-9]+-[0-9]*|-[0-9]+)$", r)) return 1;
    if (re_match("^float:([0-9]*\\.?[0-9]+-([0-9]*\\.?[0-9]+)?|-[0-9]*\\.?[0-9]+)$", r)) return 1;
    if (re_match("^string:([0-9]+|[0-9]+-[0-9]*|-[0-9]+)$", r)) return 1;
    if (starts(r, "choice:") && r[7]) return 1;
    if (starts(r, "regex:") && r[6]) {
        regex_t re;
        if (regcomp(&re, r + 6, REG_EXTENDED | REG_NOSUB) != 0) return 0;
        regfree(&re);
        return 1;
    }
    return 0;
}

static void add_opt(clyops_t* cli, const char* var, const char* long_name, int kind, const char* dflt, int required, clyops_meta_t m) {
    if (find_opt(cli, long_name)) clyops_die(2, "Duplicate option --%s", long_name);
    if (m.short_name && find_short(cli, m.short_name)) clyops_die(2, "Invalid or duplicate short option -%c", m.short_name);
    int secret = m.rule && (streq(m.rule, "secret") || starts(m.rule, "secret:"));
    if (secret) m.rule = m.rule[6] ? m.rule + 7 : "";
    if (!known_rule(m.rule)) clyops_die(2, "Unknown validation rule '%s' for --%s", m.rule, long_name);
    if (cli->nopts == cli->capopts) {
        cli->capopts = cli->capopts ? cli->capopts * 2 : 16;
        opt_t* p = realloc(cli->opts, cli->capopts * sizeof *p);
        if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
        cli->opts = p;
    }
    opt_t* o = &cli->opts[cli->nopts++];
    memset(o, 0, sizeof *o);
    o->var = xstrdup(var);
    o->long_name = xstrdup(long_name);
    o->short_name = m.short_name;
    o->kind = kind;
    o->dflt = xstrdup(dflt ? dflt : "");
    o->required = required;
    o->desc = xstrdup(m.description ? m.description : "");
    o->group = xstrdup(empty(m.group) ? "Options" : m.group);
    o->rule = xstrdup(m.rule ? m.rule : "");
    o->search_raw = xstrdup("");
    o->secret = secret;
}

void clyops_add_opt(clyops_t* cli, const char* var, const char* long_name, const char* default_value, clyops_meta_t meta) {
    const char* d = default_value ? default_value : "";
    int flag = streq(d, "flag");
    add_opt(cli, var, long_name, flag ? K_FLAG : K_VALUE, (flag || streq(d, "optional")) ? "" : d, *d == 0, meta);
}

void clyops_add_opt_array(clyops_t* cli, const char* var, const char* long_name, clyops_meta_t meta) {
    add_opt(cli, var, long_name, K_ARRAY, "", 0, meta);
}

static void add_arg(clyops_t* cli, const char* name, clyops_meta_t m, int variadic) {
    if (cli->nkids) clyops_die(2, "Cannot mix commands and positional arguments");
    for (size_t i = 0; i < cli->nargs; i++)
        if (cli->args[i].variadic) clyops_die(2, "Argument %s registered after a variadic argument", name);
    if (!known_rule(m.rule)) clyops_die(2, "Unknown validation rule '%s' for %s", m.rule, name);
    if (cli->nargs == cli->capargs) {
        cli->capargs = cli->capargs ? cli->capargs * 2 : 4;
        arg_t* p = realloc(cli->args, cli->capargs * sizeof *p);
        if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
        cli->args = p;
    }
    arg_t* a = &cli->args[cli->nargs++];
    memset(a, 0, sizeof *a);
    a->name = xstrdup(name);
    a->desc = xstrdup(m.description ? m.description : "");
    a->dflt = xstrdup(variadic || !m.default_value ? "" : m.default_value);
    a->rule = xstrdup(m.rule ? m.rule : "");
    a->variadic = variadic;
}

void clyops_add_arg(clyops_t* cli, const char* name, clyops_meta_t meta) { add_arg(cli, name, meta, 0); }
void clyops_add_arg_variadic(clyops_t* cli, const char* name, clyops_meta_t meta) { add_arg(cli, name, meta, 1); }

static void ensure_help(clyops_t* cli) {
    if (find_opt(cli, "help")) return;
    clyops_meta_t m = {0};
    m.short_name = find_short(cli, 'h') ? 0 : 'h';
    m.description = "Show this help message and exit";
    m.group = "Global";
    add_opt(cli, "HELP", "help", K_FLAG, "", 0, m);
}

/* ------------------------------------------------------------------------- */
/* Rules                                                                     */
/* ------------------------------------------------------------------------- */

static int is_path_rule(const char* r) { return streq(r, "path") || starts(r, "file:") || starts(r, "dir:"); }

static int bool_like(const opt_t* o) {
    return o->kind == K_FLAG || streq(o->rule, "bool") || streq(o->rule, "choice:true,false") || streq(o->rule, "choice:false,true");
}

/* Split "kind:MIN-MAX" into malloc'd bounds. */
static void bounds(const char* rule, char** lo, char** hi) {
    const char* range = strchr(rule, ':') + 1;
    const char* dash = strchr(range, '-');
    *lo = xstrndup(range, (size_t)(dash - range));
    *hi = xstrdup(dash + 1);
}

static char* describe_rule(const char* r) {
    static const char* fixed[][2] = {
        {"int", "integer"}, {"float", "number"}, {"string", "text"}, {"path", "path"}, {"ip", "IP address"},
        {"hostname", "hostname"}, {"url", "URL"}, {"port", "port: 1-65535"}, {"email", "email address"}, {"uuid", "UUID"},
        {"bool", "true/false, yes/no, 1/0, on/off"}, {"date:YYYY-MM-DD", "date: YYYY-MM-DD"},
        {"file:exists", "existing file"}, {"file:readable", "readable file"}, {"file:writable", "writable file"},
        {"dir:exists", "existing directory"}, {"dir:writable", "writable directory"},
    };
    for (size_t i = 0; i < sizeof fixed / sizeof *fixed; i++) if (streq(r, fixed[i][0])) return xstrdup(fixed[i][1]);
    const char* noun = starts(r, "int:") ? "integer" : starts(r, "float:") ? "number" : starts(r, "string:") ? "text" : NULL;
    if (noun) {
        const char* suffix = starts(r, "string:") ? " chars" : "";
        if (!strchr(r, '-')) return fmt("%s: %s%s", noun, strchr(r, ':') + 1, suffix);
        char *lo, *hi, *out;
        bounds(r, &lo, &hi);
        if (*lo && *hi) out = fmt("%s: %s-%s%s", noun, lo, hi, suffix);
        else if (*lo) out = fmt("%s: >=%s%s", noun, lo, suffix);
        else out = fmt("%s: <=%s%s", noun, hi, suffix);
        free(lo);
        free(hi);
        return out;
    }
    if (starts(r, "choice:")) {
        sbuf b = {0};
        sb_put(&b, "choices: ");
        for (const char* p = r + 7; *p; p++) {
            if (*p == ',') sb_put(&b, ", "); else sb_putc(&b, *p);
        }
        return sb_take(&b);
    }
    if (starts(r, "regex:")) return fmt("pattern: %s", r + 6);
    return xstrdup(r);
}

static char* dirname_dup(const char* path) {
    const char* slash = strrchr(path, '/');
    if (!slash) return xstrdup(".");
    if (slash == path) return xstrdup("/");
    return xstrndup(path, (size_t)(slash - path));
}

/* Validate value against rule; returns NULL or a malloc'd error. *bool_norm gets "true"/"false" for bool rules. */
static char* validate(const char* v, const char* rule, const char* name, const char** bool_norm) {
    char *lo = NULL, *hi = NULL, *err = NULL;
    *bool_norm = NULL;
    if (streq(rule, "int") || starts(rule, "int:")) {
        if (!re_match("^-?[0-9]+$", v)) return fmt("%s must be an integer, got '%s'", name, v);
        if (strchr(rule, ':')) {
            bounds(rule, &lo, &hi);
            long long n = strtoll(v, NULL, 10);
            if (*lo && n < strtoll(lo, NULL, 10)) err = fmt("%s must be >= %s, got %s", name, lo, v);
            else if (*hi && n > strtoll(hi, NULL, 10)) err = fmt("%s must be <= %s, got %s", name, hi, v);
        }
    } else if (streq(rule, "float") || starts(rule, "float:")) {
        if (!re_match("^-?[0-9]*\\.?[0-9]+$", v)) return fmt("%s must be a number, got '%s'", name, v);
        if (strchr(rule, ':')) {
            bounds(rule, &lo, &hi);
            double n = strtod(v, NULL);
            if (*lo && n < strtod(lo, NULL)) err = fmt("%s must be >= %s, got %s", name, lo, v);
            else if (*hi && n > strtod(hi, NULL)) err = fmt("%s must be <= %s, got %s", name, hi, v);
        }
    } else if (starts(rule, "string:")) {
        size_t len = utf8_len(v);
        if (!strchr(rule, '-')) {
            if (len != (size_t)strtoul(rule + 7, NULL, 10)) err = fmt("%s must be exactly %s characters, got %zu", name, rule + 7, len);
        } else {
            bounds(rule, &lo, &hi);
            if (*lo && len < (size_t)strtoul(lo, NULL, 10)) err = fmt("%s must be at least %s characters, got %zu", name, lo, len);
            else if (*hi && len > (size_t)strtoul(hi, NULL, 10)) err = fmt("%s must be at most %s characters, got %zu", name, hi, len);
        }
    } else if (starts(rule, "choice:")) {
        const char* p = rule + 7;
        size_t n = strlen(v);
        int found = 0;
        while (!found) {
            const char* comma = strchr(p, ',');
            size_t len = comma ? (size_t)(comma - p) : strlen(p);
            found = len == n && strncmp(p, v, n) == 0;
            if (!comma) break;
            p = comma + 1;
        }
        if (!found) {
            char* d = describe_rule(rule);
            err = fmt("%s must be one of: %s, got '%s'", name, d + strlen("choices: "), v);
            free(d);
        }
    } else if (starts(rule, "regex:")) {
        if (!re_match(rule + 6, v)) err = fmt("%s does not match required pattern, got '%s'", name, v);
    } else if (streq(rule, "bool")) {
        int b;
        if (!bool_word(v, &b)) return fmt("%s must be a boolean (true/false, yes/no, 1/0, on/off), got '%s'", name, v);
        *bool_norm = b ? "true" : "false";
    } else if (streq(rule, "port")) {
        if (!re_match("^[0-9]+$", v) || strlen(v) > 9 || atol(v) < 1 || atol(v) > 65535)
            err = fmt("%s must be a valid port (1-65535), got '%s'", name, v);
    } else if (streq(rule, "ip")) {
        if (!re_match("^([0-9]{1,3}\\.){3}[0-9]{1,3}$", v) && !re_match("^([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}$", v))
            err = fmt("%s must be a valid IP address, got '%s'", name, v);
    } else if (streq(rule, "hostname")) {
        if (!re_match("^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$", v))
            err = fmt("%s must be a valid hostname, got '%s'", name, v);
    } else if (streq(rule, "url")) {
        if (!re_match("^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$", v)) err = fmt("%s must be a valid URL, got '%s'", name, v);
    } else if (streq(rule, "email")) {
        if (!re_match("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", v)) err = fmt("%s must be a valid email address, got '%s'", name, v);
    } else if (streq(rule, "uuid")) {
        if (!re_match("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", v))
            err = fmt("%s must be a valid UUID, got '%s'", name, v);
    } else if (streq(rule, "date:YYYY-MM-DD")) {
        if (!re_match("^[0-9]{4}-[0-9]{2}-[0-9]{2}$", v)) err = fmt("%s must be in YYYY-MM-DD format, got '%s'", name, v);
    } else {
        struct stat st;
        int exists = stat(v, &st) == 0;
        if (streq(rule, "file:exists")) {
            if (!exists || !S_ISREG(st.st_mode)) err = fmt("%s file does not exist: %s", name, v);
        } else if (streq(rule, "file:readable")) {
            if (access(v, R_OK) != 0) err = fmt("%s file is not readable: %s", name, v);
        } else if (streq(rule, "file:writable")) {
            if (exists || lstat(v, &st) == 0) {
                if (access(v, W_OK) != 0) err = fmt("%s file is not writable: %s", name, v);
            } else {
                char* dir = dirname_dup(v);
                if (stat(dir, &st) != 0 || !S_ISDIR(st.st_mode) || access(dir, W_OK) != 0)
                    err = fmt("%s directory is not writable: %s", name, dir);
                free(dir);
            }
        } else if (streq(rule, "dir:exists")) {
            if (!exists || !S_ISDIR(st.st_mode)) err = fmt("%s directory does not exist: %s", name, v);
        } else if (streq(rule, "dir:writable")) {
            if (!exists || !S_ISDIR(st.st_mode) || access(v, W_OK) != 0)
                err = fmt("%s directory does not exist or is not writable: %s", name, v);
        }
    }
    free(lo);
    free(hi);
    return err;
}

/* ------------------------------------------------------------------------- */
/* Paths                                                                     */
/* ------------------------------------------------------------------------- */

/* Lexically join and normalize (no symlink resolution). */
static char* join_norm(const char* base, const char* value) {
    char* joined = value[0] == '/' ? xstrdup(value) : fmt("%s/%s", base, value);
    size_t n = strlen(joined);
    char** parts = xalloc((n + 1) * sizeof(char*));
    size_t np = 0;
    for (char* tok = strtok(joined, "/"); tok; tok = strtok(NULL, "/")) {
        if (streq(tok, ".")) continue;
        if (streq(tok, "..")) { if (np) np--; continue; }
        parts[np++] = tok;
    }
    sbuf b = {0};
    if (!np) sb_put(&b, "/");
    for (size_t i = 0; i < np; i++) { sb_putc(&b, '/'); sb_put(&b, parts[i]); }
    free(parts);
    free(joined);
    return sb_take(&b);
}

static int path_exists(const char* p) {
    struct stat st;
    return stat(p, &st) == 0;
}

static char* resolve_path(const char* value, const char* base, const svec* dirs) {
    if (empty(value) || streq(value, "-") || streq(value, "disabled") || streq(value, "optional") || value[0] == '/')
        return xstrdup(value);
    if (re_match("^[A-Za-z][A-Za-z0-9+.-]+:", value)) return xstrdup(value);
    char* from_base = join_norm(base, value);
    int bare = !(streq(value, ".") || streq(value, "..") || starts(value, "./") || starts(value, "../"));
    if (bare && dirs && dirs->len && !path_exists(from_base)) {
        for (size_t i = 0; i < dirs->len; i++) {
            char* candidate = join_norm(dirs->v[i], value);
            if (path_exists(candidate)) { free(from_base); return candidate; }
            free(candidate);
        }
    }
    return from_base;
}

static int command_available(const char* cmd) {
    struct stat st;
    if (strchr(cmd, '/')) return stat(cmd, &st) == 0 && S_ISREG(st.st_mode) && access(cmd, X_OK) == 0;
    const char* path = getenv("PATH");
    if (!path) return 0;
    char* copy = xstrdup(path);
    int found = 0;
    char* save = NULL;
    for (char* dir = strtok_r(copy, ":", &save); dir && !found; dir = strtok_r(NULL, ":", &save)) {
        char* full = fmt("%s/%s", dir, cmd);
        found = stat(full, &st) == 0 && S_ISREG(st.st_mode) && access(full, X_OK) == 0;
        free(full);
    }
    free(copy);
    return found;
}

/* ------------------------------------------------------------------------- */
/* Parsing                                                                   */
/* ------------------------------------------------------------------------- */

static void set_error(clyops_t* cli, char* owned) { free(cli->error); cli->error = owned; }

static void set_cli(opt_t* o, const char* value) {
    if (o->kind == K_ARRAY) {
        if (!streq(o->src, "cli")) sv_clear(&o->list);
        sv_push(&o->list, xstrdup(value));
    } else {
        free(o->raw);
        o->raw = xstrdup(value);
    }
    o->has = 1;
    o->src = "cli";
}

static int scan(clyops_t* cli, int argc, char** argv) {
    size_t pos = 0;
    arg_t* rest = NULL;
    int end_of_options = 0;
    for (int i = 0; i < argc; i++) {
        const char* tok = argv[i];
        if (end_of_options || streq(tok, "-") || tok[0] != '-') {
            clyops_t* node = cli->selected;
            if (rest) { sv_push(&rest->list, xstrdup(tok)); continue; }
            if (node->nkids) {
                clyops_t* kid = find_kid(node, tok);
                if (!kid) { set_error(cli, fmt("Unknown command: %s", tok)); return 0; }
                cli->selected = kid;
                sv_push(&cli->words, xstrdup(tok));
                rebuild_chain(cli);
                continue;
            }
            if (pos >= node->nargs) { set_error(cli, fmt("Unexpected argument: %s", tok)); return 0; }
            arg_t* a = &node->args[pos++];
            a->has = 1;
            if (a->variadic) { rest = a; sv_push(&a->list, xstrdup(tok)); }
            else a->raw = xstrdup(tok);
        } else if (streq(tok, "--")) {
            end_of_options = 1;
        } else if (starts(tok, "--")) {
            const char* eq = strchr(tok, '=');
            char* name = eq ? xstrndup(tok + 2, (size_t)(eq - tok - 2)) : xstrdup(tok + 2);
            opt_t* o = chain_find(cli, name, 0);
            opt_t* neg = (!o && !eq && starts(name, "no-")) ? chain_find(cli, name + 3, 0) : NULL;
            int ok = 1;
            if (o && eq) {
                if (o->kind == K_FLAG) {
                    int b;
                    if (!bool_word(eq + 1, &b)) { set_error(cli, fmt("Option --%s expects a boolean value, got '%s'", name, eq + 1)); ok = 0; }
                    else set_cli(o, b ? "true" : "false");
                } else set_cli(o, eq + 1);
            } else if (o) {
                if (o->kind == K_FLAG) set_cli(o, "true");
                else if (i + 1 >= argc || starts(argv[i + 1], "--")) { set_error(cli, fmt("Option --%s requires an argument", name)); ok = 0; }
                else set_cli(o, argv[++i]);
            } else if (neg) {
                if (!bool_like(neg)) { set_error(cli, fmt("Option --%s can only be used with flag/boolean options", name)); ok = 0; }
                else set_cli(neg, "false");
            } else {
                set_error(cli, fmt("Unknown option: --%s", name));
                ok = 0;
            }
            free(name);
            if (!ok) return 0;
        } else {
            for (const char* c = tok + 1; *c; c++) {
                opt_t* o = chain_find(cli, NULL, *c);
                if (!o) { set_error(cli, fmt("Unknown option: -%c", *c)); return 0; }
                if (o->kind == K_FLAG) { set_cli(o, "true"); continue; }
                if (c[1]) { set_cli(o, c + 1); break; }
                if (i + 1 >= argc || argv[i + 1][0] == '-') { set_error(cli, fmt("Option -%c requires an argument", *c)); return 0; }
                set_cli(o, argv[++i]);
                break;
            }
        }
    }
    return 1;
}

static cfg_t* find_cfg(const clyops_t* cli, const char* key) {
    for (size_t i = 0; i < cli->ncfg; i++) if (streq(cli->cfg[i].key, key)) return &cli->cfg[i];
    return NULL;
}

static void put_cfg(clyops_t* cli, char* key, char* value, const char* dir) {
    cfg_t* c = find_cfg(cli, key);
    if (c) {
        free(key);
        free(c->value);
        free(c->dir);
    } else {
        if (cli->ncfg == cli->capcfg) {
            cli->capcfg = cli->capcfg ? cli->capcfg * 2 : 16;
            cfg_t* p = realloc(cli->cfg, cli->capcfg * sizeof *p);
            if (!p) { fputs("clyops: out of memory\n", stderr); exit(70); }
            cli->cfg = p;
        }
        c = &cli->cfg[cli->ncfg++];
        c->key = key;
    }
    c->value = value;
    c->dir = xstrdup(dir);
}

static int read_config(clyops_t* cli, const char* path, int depth, svec* stack) {
    struct stat st;
    if (depth > 10) { set_error(cli, fmt("Config include depth exceeded (10) while processing: %s", path)); return 0; }
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode)) { set_error(cli, fmt("Config file not found: %s", path)); return 0; }
    for (size_t i = 0; i < stack->len; i++)
        if (streq(stack->v[i], path)) { set_error(cli, fmt("Circular config include detected: %s", path)); return 0; }
    FILE* f = fopen(path, "r");
    if (!f) { set_error(cli, fmt("Config file not found: %s", path)); return 0; }
    sv_push(stack, xstrdup(path));
    char* dir = dirname_dup(path);
    char* line = NULL;
    size_t cap = 0;
    ssize_t n;
    int ok = 1;
    while (ok && (n = getline(&line, &cap, f)) >= 0) {
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
        const char* t = line;
        while (isspace((unsigned char)*t)) t++;
        if (!*t || *t == '#') continue;
        if (starts(t, "@include") && isspace((unsigned char)t[8])) {
            char* target = trim_dup(t + 8, strlen(t + 8));
            size_t tl = strlen(target);
            if (tl >= 2 && (target[0] == '"' || target[0] == '\'') && target[tl - 1] == target[0]) {
                memmove(target, target + 1, tl - 2);
                target[tl - 2] = 0;
            }
            char* full = join_norm(dir, target);
            ok = read_config(cli, full, depth + 1, stack);
            free(full);
            free(target);
            continue;
        }
        const char* body = line;
        if (cli->prefixes.len) {
            body = NULL;
            for (size_t i = 0; i < cli->prefixes.len && !body; i++)
                if (starts(line, cli->prefixes.v[i])) body = line + strlen(cli->prefixes.v[i]);
            if (!body) continue;
        }
        const char* eq = strchr(body, '=');
        if (!eq) continue;
        char* key = trim_dup(body, (size_t)(eq - body));
        if (starts(key, "--")) memmove(key, key + 2, strlen(key) - 1);
        if (!*key) { free(key); continue; }
        put_cfg(cli, key, trim_dup(eq + 1, strlen(eq + 1)), dir);
    }
    free(line);
    free(dir);
    fclose(f);
    free(stack->v[--stack->len]);
    return ok;
}

static int load_config(clyops_t* cli) {
    opt_t* co = chain_find(cli, cli->config_option, 0);
    if (!co) return 1;
    const char* path = NULL;
    const char* src = "cli";
    const char* env = getenv(co->var);
    if (co->has) path = co->raw;
    else if (!empty(env)) { path = env; src = "env"; }
    else { path = co->dflt; src = "default"; }
    if (empty(path) || streq(path, "disabled")) return 1;

    char* resolved = resolve_path(path, cli->cwd, &co->search);
    free(co->raw);
    co->raw = resolved;
    co->has = 1;
    co->src = src;
    svec stack = {0};
    int ok = read_config(cli, resolved, 0, &stack);
    sv_free(&stack);
    if (!ok) return 0;

    for (size_t i = 0; i < cli->ncfg; i++) {
        cfg_t* c = &cli->cfg[i];
        opt_t* o = chain_find(cli, c->key, 0);
        if (!o || o == co || streq(o->src, "cli")) continue;
        if (o->kind == K_FLAG) {
            int b;
            if (!bool_word(c->value, &b)) { set_error(cli, fmt("Config value for --%s must be a boolean, got '%s'", c->key, c->value)); return 0; }
            free(o->raw);
            o->raw = xstrdup(b ? "true" : "false");
        } else if (o->kind == K_ARRAY) {
            sv_clear(&o->list);
            sv_push(&o->list, xstrdup(c->value));
        } else {
            free(o->raw);
            o->raw = xstrdup(c->value);
        }
        o->has = 1;
        o->src = "config";
        o->cfg_dir = c->dir;
    }
    return 1;
}

static int resolve_values(clyops_t* cli) {
    clyops_t* node = cli->selected;
    if (node->nkids) { set_error(cli, xstrdup("Missing command")); return 0; }
    for (size_t i = 0; i < node->nargs; i++) {
        arg_t* a = &node->args[i];
        if (a->has || a->variadic) continue;
        if (empty(a->dflt)) { set_error(cli, fmt("Missing required positional argument: %s", a->name)); return 0; }
        a->raw = xstrdup(a->dflt);
        a->has = 1;
    }

    for (size_t i = 0; i < cli->nchain; i++) {
        opt_t* o = cli->chain[i];
        if (o->src) continue;
        const char* env = o->kind == K_ARRAY ? NULL : getenv(o->var);
        if (!empty(env)) {
            if (o->kind == K_FLAG) {
                int b;
                if (!bool_word(env, &b)) { set_error(cli, fmt("Environment variable %s must be a boolean, got '%s'", o->var, env)); return 0; }
                env = b ? "true" : "false";
            }
            o->raw = xstrdup(env);
            o->has = 1;
            o->src = "env";
        } else if (o->kind == K_FLAG) {
            o->raw = xstrdup("false");
            o->has = 1;
            o->src = "default";
        } else if (*o->dflt) {
            o->raw = xstrdup(o->dflt);
            o->has = 1;
            o->src = "default";
        }
    }

    /* Path resolution: the base depends on where the value came from. */
    for (size_t i = 0; i < cli->nchain; i++) {
        opt_t* o = cli->chain[i];
        if (!is_path_rule(o->rule) || !o->has || streq(o->long_name, cli->config_option)) continue;
        const char* base = streq(o->src, "cli") ? cli->cwd : streq(o->src, "config") ? o->cfg_dir : cli->root_abs;
        if (o->kind == K_ARRAY) {
            for (size_t k = 0; k < o->list.len; k++) {
                char* r = resolve_path(o->list.v[k], base, &o->search);
                free(o->list.v[k]);
                o->list.v[k] = r;
            }
        } else {
            char* r = resolve_path(o->raw, base, &o->search);
            free(o->raw);
            o->raw = r;
        }
    }
    for (size_t i = 0; i < node->nargs; i++) {
        arg_t* a = &node->args[i];
        if (!is_path_rule(a->rule)) continue;
        if (a->variadic) {
            for (size_t k = 0; k < a->list.len; k++) {
                char* r = resolve_path(a->list.v[k], cli->cwd, NULL);
                free(a->list.v[k]);
                a->list.v[k] = r;
            }
        } else {
            char* r = resolve_path(a->raw, cli->cwd, NULL);
            free(a->raw);
            a->raw = r;
        }
    }

    /* Validation; empty values are not validated. bool rules normalize to true/false. */
    const char* norm;
    for (size_t i = 0; i < cli->nchain; i++) {
        opt_t* o = cli->chain[i];
        if (empty(o->rule) || !o->has) continue;
        char* name = fmt("--%s", o->long_name);
        char* err = NULL;
        if (o->kind == K_ARRAY) {
            for (size_t k = 0; k < o->list.len && !err; k++) {
                if (!*o->list.v[k]) continue;
                err = validate(o->list.v[k], o->rule, name, &norm);
                if (norm) { free(o->list.v[k]); o->list.v[k] = xstrdup(norm); }
            }
        } else if (*o->raw) {
            err = validate(o->raw, o->rule, name, &norm);
            if (norm) { free(o->raw); o->raw = xstrdup(norm); }
        }
        free(name);
        if (err) { set_error(cli, err); return 0; }
    }
    for (size_t i = 0; i < node->nargs; i++) {
        arg_t* a = &node->args[i];
        if (empty(a->rule)) continue;
        char* err = NULL;
        if (a->variadic) {
            for (size_t k = 0; k < a->list.len && !err; k++) {
                if (!*a->list.v[k]) continue;
                err = validate(a->list.v[k], a->rule, a->name, &norm);
                if (norm) { free(a->list.v[k]); a->list.v[k] = xstrdup(norm); }
            }
        } else if (*a->raw) {
            err = validate(a->raw, a->rule, a->name, &norm);
            if (norm) { free(a->raw); a->raw = xstrdup(norm); }
        }
        if (err) { set_error(cli, err); return 0; }
    }
    return 1;
}

/* Absolute search dirs for the options of `cli` and its commands. */
static void prepare_search(clyops_t* cli, const char* root_abs) {
    for (size_t i = 0; i < cli->nopts; i++) {
        opt_t* o = &cli->opts[i];
        sv_clear(&o->search);
        char* copy = xstrdup(o->search_raw);
        char* save = NULL;
        for (char* d = strtok_r(copy, ":", &save); d; d = strtok_r(NULL, ":", &save)) sv_push(&o->search, join_norm(root_abs, d));
        free(copy);
    }
    for (size_t i = 0; i < cli->nkids; i++) prepare_search(cli->kids[i], root_abs);
}

/* An option is given when set by cli, config or env, and not false or an empty list (spec section 1.6). */
static int given(const clyops_t* cli, const char* long_name) {
    const opt_t* o = chain_find(cli, long_name, 0);
    if (!o || !(streq(o->src, "cli") || streq(o->src, "config") || streq(o->src, "env"))) return 0;
    if (o->kind == K_ARRAY) return o->list.len > 0;
    return !((o->kind == K_FLAG || streq(o->rule, "bool")) && streq(o->raw, "false"));
}

/* Spec section 1.6: the first relationship that fails, from the program down. */
static char* check_constraints(const clyops_t* cli) {
    const clyops_t* nodes[64];
    size_t n = nodes_down(cli, nodes);
    for (size_t k = 0; k < n; k++) {
        for (size_t c = 0; c < nodes[k]->con_type.len; c++) {
            const char* type = nodes[k]->con_type.v[c];
            char* copy = xstrdup(nodes[k]->con_opts.v[c]);
            char *save = NULL, *longs[64];
            size_t nl = 0, on[64], non = 0;
            for (char* t = strtok_r(copy, " ", &save); t && nl < 64; t = strtok_r(NULL, " ", &save)) {
                if (given(cli, t)) on[non++] = nl;
                longs[nl++] = t;
            }
            char* err = NULL;
            if (streq(type, "exclusive") && non > 1) {
                err = fmt("Options --%s and --%s cannot be used together", longs[on[0]], longs[on[1]]);
            } else if (streq(type, "requires") && given(cli, longs[0])) {
                for (size_t i = 1; i < nl && !err; i++)
                    if (!given(cli, longs[i])) err = fmt("Option --%s requires --%s", longs[0], longs[i]);
            } else if (streq(type, "oneOf") && non == 0) {
                sbuf b = {0};
                for (size_t i = 0; i < nl; i++) sb_printf(&b, "%s--%s", i ? ", " : "", longs[i]);
                err = fmt("One of %s is required", b.s);
                free(b.s);
            }
            free(copy);
            if (err) return err;
        }
    }
    return NULL;
}

clyops_status_t clyops_parse(clyops_t* cli, int argc, char** argv) {
    reset_parse(cli);
    ensure_help(cli);
    cli->selected = cli;
    rebuild_chain(cli);

    char buf[PATH_MAX];
    free(cli->cwd);
    cli->cwd = xstrdup(getcwd(buf, sizeof buf) ? buf : "/");
    free(cli->root_abs);
    cli->root_abs = join_norm(cli->cwd, cli->root);
    prepare_search(cli, cli->root_abs);

    int ok = scan(cli, argc, argv);
    if (ok && !empty(cli->config_option)) ok = load_config(cli);
    opt_t* help = find_opt(cli, "help");
    if (help && streq(help->src, "cli") && streq(help->raw, "true")) return CLYOPS_HELP;
    if (!ok || !resolve_values(cli)) return CLYOPS_ERROR;

    sbuf missing = {0};
    const clyops_t* nodes[64];
    size_t nn = nodes_down(cli, nodes);
    for (size_t k = 0; k < nn; k++) {
        const clyops_t* c = nodes[k];
        for (size_t i = 0; i < c->cmds.len; i++) {
            if (command_available(c->cmds.v[i])) continue;
            sb_printf(&missing, "%s%s", missing.len ? ", " : "", c->cmds.v[i]);
            sv_push(&cli->detail, fmt("  %s - %s", c->cmds.v[i], c->cmd_desc.v[i]));
            if (*c->cmd_hint.v[i]) sv_push(&cli->detail, fmt("    Install: %s", c->cmd_hint.v[i]));
        }
    }
    if (missing.len) {
        set_error(cli, fmt("Missing required command(s): %s", missing.s));
        free(missing.s);
        cli->show_usage = 0;
        return CLYOPS_ERROR;
    }

    for (size_t i = 0; i < cli->nchain; i++) {
        opt_t* o = cli->chain[i];
        if (o->required && empty(o->raw)) sb_printf(&missing, "%s--%s", missing.len ? " " : "", o->long_name);
    }
    if (missing.len) {
        set_error(cli, fmt("Missing required argument(s): %s", missing.s));
        free(missing.s);
        return CLYOPS_ERROR;
    }
    char* conflict = check_constraints(cli);
    if (conflict) {
        set_error(cli, conflict);
        return CLYOPS_ERROR;
    }
    return CLYOPS_OK;
}

const char* clyops_error(const clyops_t* cli) { return cli->error; }

void clyops_run(clyops_t* cli, int argc, char** argv) {
    if (!cli->name) {
        const char* base = argc > 0 ? strrchr(argv[0], '/') : NULL;
        cli->name = xstrdup(base ? base + 1 : argc > 0 ? argv[0] : "cli");
    }
    char* out = NULL;
    for (int i = 1; i < argc && !streq(argv[i], "--"); i++) {
        if (streq(argv[i], "--help-json-schema")) out = clyops_json_schema(cli);
        else if (streq(argv[i], "--bash-completion")) {
            int end = i;
            while (end < argc && !streq(argv[end], "--")) end++;
            out = end < argc ? clyops_completion_data_for(cli, argc - end - 1, argv + end + 1) : clyops_completion_data(cli);
        }
        else if (streq(argv[i], "--completion")) {
            const char* shell = i + 1 < argc ? argv[i + 1] : "";
            out = clyops_completion_script(cli, shell);
            if (!out) clyops_die(1, "Unknown shell '%s' (expected bash, zsh or fish)", shell);
        }
        if (out) {
            fputs(out, stdout);
            if (streq(argv[i], "--help-json-schema")) fputc('\n', stdout);
            free(out);
            exit(0);
        }
    }
    clyops_status_t st = clyops_parse(cli, argc - 1, argv + 1);
    if (st == CLYOPS_OK) return;
    if (st == CLYOPS_HELP) {
        out = clyops_usage(cli);
        fputs(out, stdout);
        free(out);
        exit(0);
    }
    emit("error", cli->error, 1);
    for (size_t i = 0; i < cli->detail.len; i++) fprintf(stderr, "%s\n", cli->detail.v[i]);
    if (cli->show_usage) {
        out = clyops_usage(cli);
        fputs(out, stderr);
        free(out);
    }
    exit(1);
}

/* ------------------------------------------------------------------------- */
/* Accessors                                                                 */
/* ------------------------------------------------------------------------- */

static const opt_t* opt_by_var(const clyops_t* cli, const char* var) {
    for (size_t i = 0; i < cli->nchain; i++) if (streq(cli->chain[i]->var, var)) return cli->chain[i];
    return NULL;
}

static const arg_t* arg_by_name(const clyops_t* cli, const char* name) {
    const clyops_t* node = cli->selected;
    for (size_t i = 0; i < node->nargs; i++) if (streq(node->args[i].name, name)) return &node->args[i];
    return NULL;
}

/* The selected command words, as the value "command" of a program with commands. */
static const svec* command_words(const clyops_t* cli, const char* name) {
    return cli->nkids && streq(name, "command") ? &cli->words : NULL;
}

const char* clyops_get(const clyops_t* cli, const char* name) {
    const opt_t* o = opt_by_var(cli, name);
    if (o) return o->kind == K_ARRAY ? (o->list.len ? o->list.v[0] : NULL) : o->has ? o->raw : NULL;
    const arg_t* a = arg_by_name(cli, name);
    if (a) return a->variadic ? (a->list.len ? a->list.v[0] : NULL) : a->raw;
    const svec* w = command_words(cli, name);
    return w && w->len ? w->v[0] : NULL;
}

long long clyops_get_int(const clyops_t* cli, const char* name) {
    const char* v = clyops_get(cli, name);
    return v ? strtoll(v, NULL, 10) : 0;
}

double clyops_get_double(const clyops_t* cli, const char* name) {
    const char* v = clyops_get(cli, name);
    return v ? strtod(v, NULL) : 0.0;
}

int clyops_get_bool(const clyops_t* cli, const char* name) { return streq(clyops_get(cli, name), "true"); }

size_t clyops_get_count(const clyops_t* cli, const char* name) {
    const opt_t* o = opt_by_var(cli, name);
    if (o) return o->kind == K_ARRAY ? o->list.len : (size_t)o->has;
    const arg_t* a = arg_by_name(cli, name);
    if (a) return a->variadic ? a->list.len : (size_t)a->has;
    const svec* w = command_words(cli, name);
    return w ? w->len : 0;
}

const char* clyops_get_at(const clyops_t* cli, const char* name, size_t index) {
    const opt_t* o = opt_by_var(cli, name);
    if (o && o->kind == K_ARRAY) return index < o->list.len ? o->list.v[index] : NULL;
    const arg_t* a = arg_by_name(cli, name);
    if (a && a->variadic) return index < a->list.len ? a->list.v[index] : NULL;
    const svec* w = command_words(cli, name);
    if (w) return index < w->len ? w->v[index] : NULL;
    return index == 0 ? clyops_get(cli, name) : NULL;
}

const char* clyops_source(const clyops_t* cli, const char* long_name) {
    const opt_t* o = chain_find(cli, starts(long_name, "--") ? long_name + 2 : long_name, 0);
    return o && o->src ? o->src : "unset";
}

int clyops_is_set(const clyops_t* cli, const char* long_name) { return streq(clyops_source(cli, long_name), "cli"); }

int clyops_is_explicitly_set(const clyops_t* cli, const char* long_name) {
    const char* s = clyops_source(cli, long_name);
    return streq(s, "cli") || streq(s, "config") || streq(s, "env");
}

/* ------------------------------------------------------------------------- */
/* Output                                                                    */
/* ------------------------------------------------------------------------- */

static void json_str(sbuf* b, const char* s) {
    sb_putc(b, '"');
    for (; s && *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"') sb_put(b, "\\\"");
        else if (c == '\\') sb_put(b, "\\\\");
        else if (c == '\n') sb_put(b, "\\n");
        else if (c == '\r') sb_put(b, "\\r");
        else if (c == '\t') sb_put(b, "\\t");
        else if (c < 0x20) sb_printf(b, "\\u%04x", c);
        else sb_putc(b, (char)c);
    }
    sb_putc(b, '"');
}

/* Typed JSON for one value (spec section 10). */
static void json_typed(sbuf* b, const char* v, int flag, const char* rule) {
    if (flag || streq(rule, "bool")) sb_put(b, streq(v, "true") ? "true" : "false");
    else if (*v && (streq(rule, "int") || starts(rule, "int:") || streq(rule, "port"))) sb_printf(b, "%lld", strtoll(v, NULL, 10));
    else if (*v && (streq(rule, "float") || starts(rule, "float:"))) sb_printf(b, "%.15g", strtod(v, NULL));
    else json_str(b, v);
}

char* clyops_values_json(const clyops_t* cli) {
    sbuf b = {0};
    const clyops_t* node = cli->selected;
    size_t total = cli->nchain + node->nargs + (cli->nkids ? 1 : 0), n = 0;
    sb_put(&b, "{\n");
    for (size_t i = 0; i < cli->nchain; i++) {
        const opt_t* o = cli->chain[i];
        sb_put(&b, "  ");
        json_str(&b, o->var);
        sb_put(&b, ": ");
        if (o->kind == K_ARRAY) {
            sb_putc(&b, '[');
            for (size_t k = 0; k < o->list.len; k++) {
                if (k) sb_put(&b, ", ");
                if (o->secret) sb_put(&b, "\"***\"");
                else json_typed(&b, o->list.v[k], 0, o->rule);
            }
            sb_putc(&b, ']');
        } else if (o->has) {
            if (o->secret) sb_put(&b, "\"***\"");
            else json_typed(&b, o->raw, o->kind == K_FLAG, o->rule);
        } else {
            sb_put(&b, "null");
        }
        sb_put(&b, ++n < total ? ",\n" : "\n");
    }
    for (size_t i = 0; i < node->nargs; i++) {
        const arg_t* a = &node->args[i];
        sb_put(&b, "  ");
        json_str(&b, a->name);
        sb_put(&b, ": ");
        if (a->variadic) {
            sb_putc(&b, '[');
            for (size_t k = 0; k < a->list.len; k++) {
                if (k) sb_put(&b, ", ");
                json_typed(&b, a->list.v[k], 0, a->rule);
            }
            sb_putc(&b, ']');
        } else if (a->has) {
            json_typed(&b, a->raw, 0, a->rule);
        } else {
            sb_put(&b, "null");
        }
        sb_put(&b, ++n < total ? ",\n" : "\n");
    }
    if (cli->nkids) {
        sb_put(&b, "  \"command\": [");
        for (size_t k = 0; k < cli->words.len; k++) {
            if (k) sb_put(&b, ", ");
            json_str(&b, cli->words.v[k]);
        }
        sb_put(&b, "]\n");
    }
    sb_put(&b, "}");
    return sb_take(&b);
}

/* Greedy wrap into lines (spec section 7). */
static void wrap_text(const char* text, size_t width, svec* out) {
    const char* p = text;
    while (1) {
        const char* nl = strchr(p, '\n');
        size_t plen = nl ? (size_t)(nl - p) : strlen(p);
        char* para = xstrndup(p, plen);
        sbuf line = {0};
        size_t line_chars = 0;
        int any = 0;
        char* save = NULL;
        for (char* w = strtok_r(para, " \t\r\f\v", &save); w; w = strtok_r(NULL, " \t\r\f\v", &save)) {
            size_t wl = utf8_len(w);
            any = 1;
            if (!line.len) {
                sb_put(&line, w);
                line_chars = wl;
            } else if (line_chars + 1 + wl <= width) {
                sb_putc(&line, ' ');
                sb_put(&line, w);
                line_chars += 1 + wl;
            } else {
                sv_push(out, sb_take(&line));
                line = (sbuf){0};
                sb_put(&line, w);
                line_chars = wl;
            }
        }
        sv_push(out, any ? sb_take(&line) : xstrdup(""));
        free(para);
        if (!nl) break;
        p = nl + 1;
    }
}

static char* opt_label(const opt_t* o) {
    char* head = o->short_name ? fmt("-%c, --%s", o->short_name, o->long_name) : fmt("    --%s", o->long_name);
    if (o->kind == K_FLAG) return head;
    char* out = fmt("%s=<value>", head);
    free(head);
    return out;
}

static void rtrim_line(sbuf* b, const char* line) {
    size_t n = strlen(line);
    while (n && isspace((unsigned char)line[n - 1])) n--;
    sb_putn(b, line, n);
    sb_putc(b, '\n');
}

static void row(sbuf* b, const char* label, const char* text, size_t indent, size_t width) {
    sbuf left = {0};
    sb_put(&left, "  ");
    sb_put(&left, label);
    size_t len = utf8_len(left.s);
    if (len < indent) while (len++ < indent) sb_putc(&left, ' ');
    else sb_putc(&left, ' ');
    svec lines = {0};
    wrap_text(text, width, &lines);
    for (size_t i = 0; i < lines.len; i++) {
        sbuf l = {0};
        if (i == 0) sb_put(&l, left.s);
        else for (size_t k = 0; k < indent; k++) sb_putc(&l, ' ');
        sb_put(&l, lines.v[i]);
        rtrim_line(b, l.s);
        free(l.s);
    }
    sv_free(&lines);
    free(left.s);
}

/* Append " (a, b)" when there are notes. */
static char* annotate(const char* text, svec* notes) {
    sbuf b = {0};
    sb_put(&b, text);
    for (size_t i = 0; i < notes->len; i++) {
        sb_put(&b, i ? ", " : " (");
        sb_put(&b, notes->v[i]);
    }
    if (notes->len) sb_putc(&b, ')');
    sv_clear(notes);
    return sb_take(&b);
}

/* Relationship annotations for option `o` (spec section 7). */
static void relation_notes(const clyops_t* cli, const opt_t* o, svec* notes) {
    const clyops_t* nodes[64];
    size_t n = nodes_down(cli, nodes);
    for (size_t k = 0; k < n; k++) {
        for (size_t c = 0; c < nodes[k]->con_type.len; c++) {
            const char* type = nodes[k]->con_type.v[c];
            char* copy = xstrdup(nodes[k]->con_opts.v[c]);
            char *save = NULL, *longs[64];
            size_t nl = 0;
            int has = 0;
            for (char* t = strtok_r(copy, " ", &save); t && nl < 64; t = strtok_r(NULL, " ", &save)) {
                has |= streq(t, o->long_name);
                longs[nl++] = t;
            }
            if (has && !(streq(type, "requires") && !streq(longs[0], o->long_name))) {
                sbuf b = {0};
                sb_put(&b, streq(type, "exclusive") ? "conflicts with: " : streq(type, "requires") ? "requires: " : "one of: ");
                size_t first = 1;
                for (size_t i = streq(type, "requires") ? 1 : 0; i < nl; i++) {
                    if (streq(type, "exclusive") && streq(longs[i], o->long_name)) continue;
                    sb_printf(&b, "%s--%s", first ? "" : ", ", longs[i]);
                    first = 0;
                }
                sv_push(notes, sb_take(&b));
            }
            free(copy);
        }
    }
}

char* clyops_usage(clyops_t* cli) {
    ensure_help(cli);
    if (!cli->nchain) rebuild_chain(cli);
    const clyops_t* node = cli->selected;
    const char* w = getenv("CLYOPS_MAX_WIDTH");
    long maxw = (w && re_match("^[0-9]+$", w)) ? atol(w) : 0;
    if (maxw <= 0) maxw = 100;
    size_t longest = 0;
    for (size_t i = 0; i < cli->nchain; i++) {
        char* l = opt_label(cli->chain[i]);
        if (utf8_len(l) > longest) longest = utf8_len(l);
        free(l);
    }
    for (size_t i = 0; i < node->nkids; i++)
        if (utf8_len(node->kids[i]->word) > longest) longest = utf8_len(node->kids[i]->word);
    size_t indent = longest + 4 < 32 ? 32 : longest + 4 > 50 ? 50 : longest + 4;
    size_t width = (size_t)maxw > indent + 20 ? (size_t)maxw - indent : 20;

    sbuf b = {0};
    svec notes = {0};
    sb_printf(&b, "Usage: %s", cli->name ? cli->name : "cli");
    for (size_t i = 0; i < cli->words.len; i++) sb_printf(&b, " %s", cli->words.v[i]);
    if (node->nkids) sb_put(&b, " <command>");
    for (size_t i = 0; i < node->nargs; i++) {
        const arg_t* a = &node->args[i];
        if (a->variadic) sb_printf(&b, " [<%s...>]", a->name);
        else if (*a->dflt) sb_printf(&b, " [<%s>]", a->name);
        else sb_printf(&b, " <%s>", a->name);
    }
    sb_put(&b, " [OPTIONS]\n");

    if (!empty(node->description)) {
        svec lines = {0};
        wrap_text(node->description, (size_t)maxw, &lines);
        sb_putc(&b, '\n');
        for (size_t i = 0; i < lines.len; i++) rtrim_line(&b, lines.v[i]);
        sv_free(&lines);
    }

    if (node->stdin_desc || node->stdout_desc) sb_putc(&b, '\n');
    for (int k = 0; k < 2; k++) {
        const char* d = k ? node->stdout_desc : node->stdin_desc;
        const char* t = k ? node->stdout_type : node->stdin_type;
        if (!d) continue;
        sb_put(&b, k ? "Output:" : "Input:");
        if (*d) sb_printf(&b, " %s", d);
        if (*t) sb_printf(&b, " (%s)", t);
        sb_putc(&b, '\n');
    }

    if (node->nkids) {
        sb_put(&b, "\nCommands:\n");
        for (size_t i = 0; i < node->nkids; i++) row(&b, node->kids[i]->word, node->kids[i]->description, indent, width);
    }

    if (node->nargs) {
        sb_put(&b, "\nPositional Arguments:\n");
        for (size_t i = 0; i < node->nargs; i++) {
            const arg_t* a = &node->args[i];
            if (a->variadic) sv_push(&notes, xstrdup("variadic"));
            if (*a->dflt) sv_push(&notes, fmt("default: %s", a->dflt));
            if (*a->rule) {
                char* d = describe_rule(a->rule);
                sv_push(&notes, fmt("accepts: %s", d));
                free(d);
            }
            char* text = annotate(a->desc, &notes);
            row(&b, a->name, text, indent, width);
            free(text);
        }
    }

    const clyops_t* nodes[64];
    size_t nn = nodes_down(cli, nodes), ncmds = 0;
    for (size_t k = 0; k < nn; k++) ncmds += nodes[k]->cmds.len;
    if (ncmds) {
        sb_put(&b, "\nRequired Commands:\n");
        for (size_t k = 0; k < nn; k++) {
            const clyops_t* c = nodes[k];
            for (size_t i = 0; i < c->cmds.len; i++) {
                char* label = fmt("%s [%s]", c->cmds.v[i], command_available(c->cmds.v[i]) ? "installed" : "not found");
                char* text = *c->cmd_hint.v[i] ? fmt("%s (%s)", c->cmd_desc.v[i], c->cmd_hint.v[i]) : xstrdup(c->cmd_desc.v[i]);
                row(&b, label, text, indent, width);
                free(label);
                free(text);
            }
        }
    }

    for (size_t g = 0; g < cli->nchain; g++) {
        const char* group = cli->chain[g]->group;
        int seen = 0;
        for (size_t k = 0; k < g && !seen; k++) seen = streq(cli->chain[k]->group, group);
        if (seen) continue;
        sb_printf(&b, "\n%s:\n", group);
        for (size_t i = g; i < cli->nchain; i++) {
            const opt_t* o = cli->chain[i];
            if (!streq(o->group, group)) continue;
            if (o->required) sv_push(&notes, xstrdup("required"));
            if (o->kind == K_ARRAY) sv_push(&notes, xstrdup("multiple"));
            if (o->secret) sv_push(&notes, xstrdup("secret"));
            cfg_t* c = find_cfg(cli, o->long_name);
            if (c) sv_push(&notes, fmt("config: %s", o->secret ? "***" : c->value));
            if (*o->dflt) sv_push(&notes, fmt("default: %s", o->dflt));
            if (*o->rule) {
                char* d = describe_rule(o->rule);
                sv_push(&notes, fmt("accepts: %s", d));
                free(d);
            }
            relation_notes(cli, o, &notes);
            char* text = annotate(o->desc, &notes);
            char* label = opt_label(o);
            row(&b, label, text, indent, width);
            free(label);
            free(text);
        }
    }

    if (!empty(node->epilog)) {
        char* e = xstrdup(node->epilog);
        size_t n = strlen(e);
        while (n && e[n - 1] == '\n') e[--n] = 0;
        sb_putc(&b, '\n');
        char* p = e;
        while (1) {
            char* nl = strchr(p, '\n');
            if (nl) *nl = 0;
            rtrim_line(&b, p);
            if (!nl) break;
            p = nl + 1;
        }
        free(e);
    }
    sv_free(&notes);
    return sb_take(&b);
}

static void json_list(sbuf* b, const char* const* items, size_t n) {
    sb_putc(b, '[');
    for (size_t i = 0; i < n; i++) {
        if (i) sb_put(b, ", ");
        json_str(b, items[i]);
    }
    sb_putc(b, ']');
}

static void json_stream(sbuf* b, const char* desc, const char* type) {
    if (!desc) { sb_put(b, "null"); return; }
    sb_put(b, "{\"description\": ");
    json_str(b, desc);
    sb_put(b, ", \"contentType\": ");
    json_str(b, type);
    sb_putc(b, '}');
}

/* The schema fields of `cli` from "description" on (spec section 8), without the braces. */
static void schema_node(sbuf* b, const clyops_t* cli) {
    sb_put(b, "  \"description\": ");
    json_str(b, cli->description ? cli->description : "");
    sb_put(b, ",\n  \"epilog\": ");
    json_str(b, cli->epilog ? cli->epilog : "");
    sb_put(b, ",\n  \"arguments\": [");
    for (size_t i = 0; i < cli->nargs; i++) {
        const arg_t* a = &cli->args[i];
        sb_put(b, i ? ",\n    {\n      \"name\": " : "\n    {\n      \"name\": ");
        json_str(b, a->name);
        sb_put(b, ",\n      \"description\": ");
        json_str(b, a->desc);
        sb_printf(b, ",\n      \"required\": %s,\n      \"isVariadic\": %s,\n      \"default\": ",
                  !a->variadic && !*a->dflt ? "true" : "false", a->variadic ? "true" : "false");
        json_str(b, a->dflt);
        sb_put(b, ",\n      \"validation\": ");
        json_str(b, a->rule);
        sb_put(b, "\n    }");
    }
    sb_put(b, cli->nargs ? "\n  ],\n  \"options\": [" : "],\n  \"options\": [");
    for (size_t i = 0; i < cli->nopts; i++) {
        const opt_t* o = &cli->opts[i];
        const char* r = o->rule;
        const char* type = (o->kind == K_FLAG || streq(r, "bool")) ? "boolean"
                         : (starts(r, "int") || streq(r, "port")) ? "integer"
                         : starts(r, "float") ? "number"
                         : starts(r, "choice:") ? "choice"
                         : is_path_rule(r) ? "path" : "string";
        char sh[2] = {o->short_name, 0};
        sb_put(b, i ? ",\n    {\n      \"name\": " : "\n    {\n      \"name\": ");
        json_str(b, o->long_name);
        sb_put(b, ",\n      \"shortName\": ");
        json_str(b, sh);
        sb_put(b, ",\n      \"variableName\": ");
        json_str(b, o->var);
        sb_put(b, ",\n      \"description\": ");
        json_str(b, o->desc);
        sb_put(b, ",\n      \"default\": ");
        json_str(b, o->kind == K_FLAG ? "false" : o->dflt);
        sb_put(b, ",\n      \"group\": ");
        json_str(b, o->group);
        sb_printf(b, ",\n      \"type\": \"%s\",\n      \"isFlag\": %s,\n      \"isArray\": %s,\n      \"required\": %s,\n      \"validation\": ",
                  type, o->kind == K_FLAG ? "true" : "false", o->kind == K_ARRAY ? "true" : "false", o->required ? "true" : "false");
        json_str(b, r);
        sb_put(b, ",\n      \"choices\": [");
        if (starts(r, "choice:")) {
            const char* p = r + 7;
            int first = 1;
            while (1) {
                const char* comma = strchr(p, ',');
                char* c = comma ? xstrndup(p, (size_t)(comma - p)) : xstrdup(p);
                sb_put(b, first ? "\n        " : ",\n        ");
                json_str(b, c);
                free(c);
                first = 0;
                if (!comma) break;
                p = comma + 1;
            }
            sb_put(b, "\n      ");
        }
        sb_printf(b, "],\n      \"secret\": %s\n    }", o->secret ? "true" : "false");
    }
    sb_put(b, "\n  ],\n  \"requiredCommands\": [");
    for (size_t i = 0; i < cli->cmds.len; i++) {
        sb_put(b, i ? ",\n    {\n      \"command\": " : "\n    {\n      \"command\": ");
        json_str(b, cli->cmds.v[i]);
        sb_put(b, ",\n      \"description\": ");
        json_str(b, cli->cmd_desc.v[i]);
        sb_put(b, ",\n      \"installHint\": ");
        json_str(b, cli->cmd_hint.v[i]);
        sb_put(b, "\n    }");
    }
    sb_put(b, cli->cmds.len ? "\n  ],\n  \"effects\": " : "],\n  \"effects\": ");
    json_list(b, (const char* const*)cli->effects.v, cli->effects.len);
    sb_put(b, ",\n  \"constraints\": [");
    for (size_t i = 0; i < cli->con_type.len; i++) {
        sb_put(b, i ? ", {\"type\": " : "{\"type\": ");
        json_str(b, cli->con_type.v[i]);
        sb_put(b, ", \"options\": [");
        const char* p = cli->con_opts.v[i];
        for (int first = 1; *p; first = 0) {
            const char* sp = strchr(p, ' ');
            char* name = sp ? xstrndup(p, (size_t)(sp - p)) : xstrdup(p);
            if (!first) sb_put(b, ", ");
            json_str(b, name);
            free(name);
            p = sp ? sp + 1 : p + strlen(p);
        }
        sb_put(b, "]}");
    }
    sb_put(b, "],\n  \"stdin\": ");
    json_stream(b, cli->stdin_desc, cli->stdin_type);
    sb_put(b, ",\n  \"stdout\": ");
    json_stream(b, cli->stdout_desc, cli->stdout_type);
    sb_put(b, ",\n  \"commands\": [");
    for (size_t i = 0; i < cli->nkids; i++) {
        sb_put(b, i ? ", {\n  \"name\": " : "{\n  \"name\": ");
        json_str(b, cli->kids[i]->word);
        sb_put(b, ",\n");
        schema_node(b, cli->kids[i]);
        sb_put(b, "\n}");
    }
    sb_putc(b, ']');
}

char* clyops_json_schema(clyops_t* cli) {
    ensure_help(cli);
    sbuf b = {0};
    sb_put(&b, "{\n  \"clyops\": 1,\n  \"script\": ");
    json_str(&b, cli->name ? cli->name : "cli");
    sb_put(&b, ",\n");
    schema_node(&b, cli);
    sb_put(&b, "\n}");
    return sb_take(&b);
}

static void completion_kind(sbuf* b, const char* rule, const svec* dirs) {
    const char* kind = "default";
    sbuf values = {0};
    if (streq(rule, "path") || starts(rule, "file:") || starts(rule, "dir:")) {
        kind = starts(rule, "dir:") ? "dir" : "file";
        for (size_t i = 0; dirs && i < dirs->len; i++) {
            if (i) sb_putc(&values, ':');
            sb_put(&values, dirs->v[i]);
        }
    } else if (starts(rule, "choice:")) {
        kind = "choice";
        sb_put(&values, rule + 7);
    } else if (streq(rule, "bool")) {
        kind = "choice";
        sb_put(&values, "true,false");
    } else if (streq(rule, "hostname") || streq(rule, "ip")) {
        kind = "host";
    } else if (*rule) {
        kind = "none";
    }
    sb_printf(b, "%s\t%s", kind, values.len ? values.s : "-");
    free(values.s);
}

static char* clean(const char* s) {
    char* d = xstrdup(s);
    for (char* p = d; *p; p++) if (*p == '\t' || *p == '\n') *p = ' ';
    return d;
}

char* clyops_completion_data(clyops_t* cli) { return clyops_completion_data_for(cli, 0, NULL); }

char* clyops_completion_data_for(clyops_t* cli, int nwords, char** words) {
    ensure_help(cli);
    if (!cli->root_abs) {
        /* Not parsed yet: compute search dirs the same way clyops_parse does. */
        char buf[PATH_MAX];
        cli->root_abs = join_norm(getcwd(buf, sizeof buf) ? buf : "/", cli->root);
        prepare_search(cli, cli->root_abs);
    }
    sbuf b = {0};
    sb_put(&b, "#clyops-completion 1\n");
    cli->selected = cli;
    if (cli->nkids) {
        int skip = 0;
        for (clyops_t* kid; skip < nwords && (kid = find_kid(cli->selected, words[skip])); skip++) cli->selected = kid;
        if (cli->selected->nkids && skip < nwords && words[skip][0] != '-') {
            cli->selected = cli;
            return sb_take(&b);
        }
        sb_printf(&b, "skip\t%d\n", skip);
        for (size_t i = 0; i < cli->selected->nkids; i++) {
            char* desc = clean(cli->selected->kids[i]->description);
            sb_printf(&b, "cmd\t%s\t%s\n", cli->selected->kids[i]->word, desc);
            free(desc);
        }
    }
    rebuild_chain(cli);
    const clyops_t* node = cli->selected;
    for (size_t i = 0; i < cli->nchain; i++) {
        const opt_t* o = cli->chain[i];
        char* desc = clean(o->desc);
        char sh[3] = {'-', o->short_name, 0};
        const char* shs = o->short_name ? sh : "-";
        if (o->kind == K_FLAG) {
            sb_printf(&b, "opt\t--%s\t%s\tflag\tnone\t-\t%s\n", o->long_name, shs, desc);
        } else {
            sb_printf(&b, "opt\t--%s\t%s\tvalue\t", o->long_name, shs);
            completion_kind(&b, o->rule, &o->search);
            sb_printf(&b, "\t%s\n", desc);
        }
        if (bool_like(o)) sb_printf(&b, "opt\t--no-%s\t-\tflag\tnone\t-\t%s\n", o->long_name, desc);
        free(desc);
    }
    for (size_t i = 0; i < node->nargs; i++) {
        const arg_t* a = &node->args[i];
        char* desc = clean(a->desc);
        sb_printf(&b, "arg\t%s\t%s\t", a->name, a->variadic ? "variadic" : "single");
        completion_kind(&b, a->rule, NULL);
        sb_printf(&b, "\t%s\n", desc);
        free(desc);
    }
    return sb_take(&b);
}

static char* replace_all(const char* text, const char* from, const char* to) {
    sbuf b = {0};
    size_t n = strlen(from);
    for (const char* hit; (hit = strstr(text, from)); text = hit + n) {
        sb_putn(&b, text, (size_t)(hit - text));
        sb_put(&b, to);
    }
    sb_put(&b, text);
    return sb_take(&b);
}

char* clyops_completion_script(const clyops_t* cli, const char* shell) {
    const char* const* lines = streq(shell, "bash") ? CLYOPS_COMPLETION_BASH
                             : streq(shell, "zsh")  ? CLYOPS_COMPLETION_ZSH
                             : streq(shell, "fish") ? CLYOPS_COMPLETION_FISH : NULL;
    if (!lines) return NULL;
    sbuf joined = {0};
    for (; *lines; lines++) sb_put(&joined, *lines);
    char* template = sb_take(&joined);
    const char* name = cli->name ? cli->name : "cli";
    char* func = xstrdup(name);
    for (char* p = func; *p; p++) if (!isalnum((unsigned char)*p) && *p != '_') *p = '_';
    char* step = replace_all(template, "__CLYOPS_FUNC__", func);
    char* out = replace_all(step, "__CLYOPS_PROG__", name);
    free(step);
    free(func);
    free(template);
    return out;
}
