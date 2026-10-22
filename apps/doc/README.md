# clyops-doc

Documentation from any [clyops](https://github.com/wankdanker/clyops) tool's `--help-json-schema`: a
man page, Markdown or a standalone HTML page. It only reads the schema, so it works for a tool in
any of the nine languages, compiled ones included, and needs nothing from the tool itself.

```sh
npm install -g clyops-doc

mytool --help-json-schema | clyops-doc > mytool.1                 # man page (the default)
mytool --help-json-schema | clyops-doc --format markdown > mytool.md
mytool --help-json-schema | clyops-doc --format html > mytool.html
man -l mytool.1
```

`clyops-doc` is a clyops tool too, so it documents itself:
`clyops-doc --help-json-schema | clyops-doc | man -l -`.

| Option | |
| --- | --- |
| `-f, --format` | `man` (default), `markdown` or `html` |
| `-n, --name` | How the tool is run, default the schema's name; for a dispatcher path, `--name "mytool media to-pcm"` |
| `-s, --section` | Manual section for the man page header (default `1`) |
| `-V, --version` | Version shown in the header |
| `-d, --date` | Date shown in the header, YYYY-MM-DD (default today, or `SOURCE_DATE_EPOCH` for reproducible builds) |
| `--schema FILE` | Read the schema from a file instead of stdin |
| `-r, --root DIR` | Document every tool in a directory (or dispatcher definition), with an index page (needs `--out-dir` or `--prefix`) |
| `-o, --out-dir DIR` | Write page files into `DIR` (created if missing) instead of to stdout |
| `-p, --prefix PREFIX` | Install man pages into `PREFIX/share/man/manN`, and warn if `man` won't find them |
| `--split` | A page per command, git-style (needs `--out-dir` or `--prefix`) |
| `-x, --execute` | Write the files; without it, `--out-dir` and `--prefix` only list them |

Each option can also be set as `CLYOPS_DOC_<OPTION>`. Input that isn't a clyops schema (`"clyops": 1`)
is rejected with exit status 1.

## A page per command

```sh
mytool --help-json-schema | clyops-doc --split --out-dir man1            # lists the files
mytool --help-json-schema | clyops-doc --split --out-dir man1 --execute  # writes them
```

`mytool.1` gets the program's own options and a list of the commands, and each runnable command gets
its own page, `mytool-db-migrate.1`, with the options it inherits and the nearest declared effects,
stdin, stdout and roles. They refer to each other under SEE ALSO, as links in Markdown and HTML
(`.md`, `.html`). A program without commands is one page. Files that already say the same are left
alone, so a rerun is a no-op. Because it can write files, clyops-doc declares the `idempotent` and
`destructive` effects, although nothing is written without `--execute`.

## A whole directory of tools

```sh
clyops-doc --root ~/mytool/scripts --name mytool --prefix ~/.local            # lists the pages
clyops-doc --root ~/mytool/scripts --name mytool --prefix ~/.local --execute  # installs them
man mytool-media-to-pcm
```

`--root` finds tools the way `clyops-dispatch`, `clyops-api` and `clyops-mcp` do (subdirectories
become command words, `.clyops` files give descriptions and ignores, nested dispatchers are
followed), asks each for `--help-json-schema`, and writes a page per tool, or with `--split` per
command, plus an index page named after the dispatcher (`--name`, default the directory's name)
that lists them all. Executables that aren't clyops tools, or that fail to give a schema, are
skipped with a warning.

`--prefix` writes into `PREFIX/share/man/man1` (`man8` with `--section 8`) and checks `manpath`
(or `MANPATH`), saying how to add the directory when `man` won't look there.

## What goes where

| Section | From the schema |
| --- | --- |
| NAME, SYNOPSIS | the name, the first sentence of `description`, and a usage line per command, as help prints it |
| DESCRIPTION | `description` |
| ARGUMENTS, OPTIONS | each argument and option with its default, accepted values ([spec §5](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md#5-validation-rules)), whether it repeats or is a secret, and its environment variable |
| COMMANDS | for a program with commands, a subsection per command with the options it inherits and the nearest declared effects, stdin, stdout and roles |
| STREAMS | `stdin`, `stdout` and [roles](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md#14-roles-on-file-descriptors) with their types |
| NOTES | effects, option relationships and required commands |
| ENVIRONMENT | each option's variable, the precedence rule, `CLYOPS_FDS` when there are roles, `CLYOPS_SILENT`, `CLYOPS_MAX_WIDTH` and `NO_COLOR` |
| FILES | the config file: the option and variable naming it, its default, the line format and prefixes |
| EXIT STATUS | 0, 1, and the tool's own |
| EXAMPLES | `epilog` |
| SEE ALSO | with `--split`, the other pages |

Man pages use the plain `man(7)` macros, which groff and mandoc both render; text is escaped so a
line can't start a request and option dashes are `\-`, so they copy and paste. The HTML page is
self-contained, with every value escaped.

## As a library

```js
import { buildDoc, document, pages, renderMarkdown } from 'clyops-doc';

const page = document(schema, 'man', { name: 'mytool', version: '1.2.0' });
const md = renderMarkdown(buildDoc(schema)); // or build the document once and render it several ways
for (const { file, content } of pages(schema, 'man')) { /* mytool.1, mytool-db-migrate.1, ... */ }
```

ESM only, Node 20+.
