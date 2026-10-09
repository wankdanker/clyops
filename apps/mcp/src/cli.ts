#!/usr/bin/env node
// clyops-mcp --root DIR: a stdio MCP server for a directory of clyops tools.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Cli, warn } from 'clyops';
import { loadTools, watchTools } from 'clyops-tools';
import { readFileSync } from 'node:fs';
import { createMcpServer } from './server.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const cli = new Cli({ name: 'clyops-mcp' });
cli.setDescription('Serve a directory of clyops tools to an AI agent over MCP (stdio): one MCP tool per clyops tool, with its input schema from the tool\'s --help-json-schema.');
cli.setEpilog('Every option can also be set in the environment as CLYOPS_MCP_<OPTION>.\n\nExamples:\n  claude mcp add mytool -- clyops-mcp --root ~/mytool/scripts\n  { "mcpServers": { "mytool": { "command": "clyops-mcp", "args": ["--root", "/home/me/mytool/scripts"] } } }');
cli.opt('CLYOPS_MCP_ROOT',    'root',    'r', '',         'Tools directory or dispatcher definition file', 'Tools', 'path');
cli.opt('CLYOPS_MCP_NAME',    'name',    'n', 'optional', 'Server name (default: the directory name)',     'Tools');
cli.opt('CLYOPS_MCP_CWD',     'cwd',     '',  'optional', 'Working directory for the tools (default: the current one)', 'Tools', 'dir:exists');
cli.opt('CLYOPS_MCP_TIMEOUT', 'timeout', 't', '0',        'Kill a tool after this many seconds (0: never)', 'Tools', 'int:0-');
cli.opt('CLYOPS_MCP_WATCH',   'watch',   'w', 'true',     'Pick up added, changed and removed tools without a restart', 'Tools', 'bool');
const args = cli.run();

// stdout is the MCP channel; clyops logs to stderr.
const onError = (cmd: { words: string[] } | null, err: Error) => warn('%s%s', cmd ? `skipping ${cmd.words.join(' ')}: ` : '', err.message);
const opts = { name: (args.CLYOPS_MCP_NAME as string | null) ?? undefined, onError };
const watcher = args.CLYOPS_MCP_WATCH
  ? await watchTools(args.CLYOPS_MCP_ROOT as string, {
      ...opts,
      // The server reads mcp.tools on each request; tell the agent the list changed.
      onChange: ({ tools }) => {
        mcp.tools = tools;
        void server.sendToolListChanged();
      },
    })
  : undefined;
const { tree, tools } = watcher ? watcher.current() : await loadTools(args.CLYOPS_MCP_ROOT as string, opts);
const mcp = {
  name: tree.name,
  version,
  instructions: tree.description || undefined,
  tools,
  cwd: (args.CLYOPS_MCP_CWD as string | null) ?? undefined,
  timeoutMs: (args.CLYOPS_MCP_TIMEOUT as number) * 1000,
};
const server = createMcpServer(mcp);
// The watcher would keep the process alive after the agent disconnects, and
// the stdio transport doesn't close by itself when stdin ends.
server.onclose = () => watcher?.close();
process.stdin.on('end', () => void server.close());
await server.connect(new StdioServerTransport());
