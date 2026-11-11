(() => {
  const panel = document.querySelector('#playground');
  if (!panel) return;
  const start = panel.querySelector('#playground-start');
  const reset = panel.querySelector('#playground-reset');
  const form = panel.querySelector('form');
  const input = panel.querySelector('#playground-command');
  const log = panel.querySelector('#playground-output');
  const status = panel.querySelector('#playground-status');
  const controls = [...form.elements, ...panel.querySelectorAll('[data-command]')];
  let worker, serial = 0, pending, timer;
  const history = [];
  let historyIndex = 0;
  function enabled(value) { controls.forEach(control => { control.disabled = !value; }); }
  function write(text, kind = '') {
    const entry = document.createElement('span'); entry.className = kind; entry.textContent = text;
    log.append(entry);
    while (log.textContent.length > 150000 && log.childNodes.length > 1) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  function stop(message = 'Runtime unloaded. Start again to restore the examples.') {
    worker?.terminate(); worker = undefined; clearTimeout(timer); pending = undefined;
    enabled(false); start.disabled = false; start.textContent = 'Start Python playground'; reset.disabled = true;
    status.textContent = message;
  }
  function send(action, fields = {}) {
    const id = ++serial; pending = { id, action }; enabled(false);
    timer = setTimeout(() => stop('Execution stopped after the time limit. Start again to retry.'), action === 'init' ? 90000 : 15000);
    worker.postMessage({ id, action, ...fields });
  }
  enabled(false); reset.disabled = true;
  if (!window.Worker || !window.WebAssembly) { start.disabled = true; status.textContent = 'This browser needs WebAssembly and Web Workers. The examples also run locally.'; return; }
  start.addEventListener('click', () => {
    start.disabled = true; reset.disabled = false; status.textContent = 'Loading Python into your browser…';
    try {
      worker = new Worker(panel.dataset.workerUrl, { type: 'module' });
      worker.onerror = () => stop('Python could not load. Check your connection and try again, or run the local examples.');
      worker.onmessage = ({ data }) => {
        if (!pending || data.id !== pending.id) return;
        clearTimeout(timer); const { action } = pending; pending = undefined;
        if (data.error) { write(data.error + '\n', 'playground-error'); if (action === 'init') { stop('Could not load Python. Start again to retry.'); return; } }
        if (data.ready) {
          write('Python is ready. Type help, or try one of the commands below.\n'); start.textContent = 'Python loaded';
        } else if (action === 'complete') {
          const candidates = data.candidates || [];
          if (candidates.length === 1) input.value = input.value.replace(/\S*$/, candidates[0] + ' ');
          else if (candidates.length) write(candidates.join('  ') + '\n');
        } else {
          if (data.clear) log.replaceChildren();
          if (data.stdout) write(data.stdout);
          if (data.stderr) write(data.stderr, 'playground-error');
          if (data.code) write(`exit ${data.code}\n`, 'playground-error');
        }
        enabled(true); status.textContent = 'Ready · Python runs locally in this tab'; input.focus();
      };
      send('init', { filesUrl: new URL(panel.dataset.filesUrl, location.href).href });
    } catch { stop('This browser could not start the playground. Try the local examples.'); }
  });
  reset.addEventListener('click', () => { stop(); log.textContent = 'Examples reset. Nothing was written to your computer.\n'; });
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!worker || pending || !input.value.trim()) return;
    const command = input.value; history.push(command); historyIndex = history.length;
    write('❯ ' + command + '\n', 'playground-prompt'); status.textContent = 'Running…';
    input.value = ''; send('run', { command, stdin: panel.querySelector('#playground-stdin').value });
  });
  input.addEventListener('keydown', event => {
    if (pending) return;
    if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); send('complete', { command: input.value }); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault(); historyIndex = Math.max(0, Math.min(history.length, historyIndex + (event.key === 'ArrowUp' ? -1 : 1)));
      input.value = history[historyIndex] || '';
    }
  });
  panel.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.command; form.requestSubmit(); }));
  window.addEventListener('pagehide', () => worker?.terminate());
})();
