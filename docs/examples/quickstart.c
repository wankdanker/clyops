#include "clyops.h"
#include <stdio.h>

int main(int argc, char** argv) {
    clyops_t* cli = clyops_new("docs-demo");
    clyops_opt(cli, "NAME", "name", "World", .short_name = 'n', .description = "Who to greet");
    clyops_opt(cli, "COUNT", "count", "1", .short_name = 'c', .description = "Repeat count", .rule = "int:1-3");
    clyops_opt(cli, "VERBOSE", "verbose", "flag", .short_name = 'v', .description = "Verbose output");
    clyops_run(cli, argc, argv);
    printf("%s %lld %s\n", clyops_get(cli, "NAME"), clyops_get_int(cli, "COUNT"), clyops_get(cli, "VERBOSE"));
    clyops_free(cli);
    return 0;
}
