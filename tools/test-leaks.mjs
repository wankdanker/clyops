// Imported into the Node packages' test runs (`node --import`). A test file
// whose process outlives its last test by CLYOPS_TEST_LEAK_MS (default 10 s)
// prints what keeps it alive and exits 1, instead of hanging CI until the job
// times out (#47). Only test files act on it, never the runner that waits for them.
import { after } from 'node:test';

const LEAK_MS = Number(process.env.CLYOPS_TEST_LEAK_MS ?? 10_000);

function describe(handle) {
  if (handle?.spawnargs) return `child process ${handle.pid}: ${handle.spawnargs.join(' ')}`;
  const name = handle?.constructor?.name ?? typeof handle;
  if (typeof handle?.fd === 'number' && handle.fd >= 0) return `${name} (fd ${handle.fd})`;
  if (handle?.remoteAddress) return `${name} (${handle.remoteAddress}:${handle.remotePort})`;
  return name;
}

if (process.env.NODE_TEST_CONTEXT) {
  after(() => {
    setTimeout(() => {
      const handles = process._getActiveHandles().filter((h) => h !== process.stdout && h !== process.stderr && h !== process.stdin);
      const lines = handles.length ? handles.map((h) => `  ${describe(h)}`) : process.getActiveResourcesInfo().map((r) => `  ${r}`);
      process.stderr.write(`test process still running ${LEAK_MS} ms after its last test; open:\n${lines.join('\n')}\n`);
      for (const h of handles) if (h?.spawnargs) h.kill('SIGKILL');
      process.exit(1);
    }, LEAK_MS).unref();
  });
}
