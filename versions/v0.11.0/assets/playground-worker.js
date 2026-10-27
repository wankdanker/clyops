// Module worker: loading and execution never block the page. Runtime is pinned.
let runtime;
let handle;
self.onmessage = async ({ data }) => {
  try {
    if (data.action === 'init') {
      const base = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
      const [{ loadPyodide }, response] = await Promise.all([import(base + 'pyodide.mjs'), fetch(data.filesUrl)]);
      if (!response.ok) throw new Error('Could not load the example files.');
      const { files } = await response.json();
      runtime = await loadPyodide({ indexURL: base });
      for (const [path, source] of Object.entries(files)) {
        const target = '/workspace/' + path;
        runtime.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
        runtime.FS.writeFile(target, source);
      }
      runtime.FS.chdir('/workspace');
      await runtime.runPythonAsync(`import runpy\n_playground = runpy.run_path('/workspace/tools/playground.py')`);
      handle = runtime.runPython('_playground["request"]');
      self.postMessage({ id: data.id, ready: true });
    } else {
      if (!handle) throw new Error('Start the playground first.');
      self.postMessage({ id: data.id, ...JSON.parse(handle(JSON.stringify(data))) });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: error.message || String(error) });
  }
};
