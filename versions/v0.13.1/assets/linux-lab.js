import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const lab = document.querySelector('#linux-lab');
const start = document.querySelector('#lab-start');
const reset = document.querySelector('#lab-reset');
const status = document.querySelector('#lab-status');
const transferStatus = document.querySelector('#lab-transfer-status');
const upload = document.querySelector('#lab-upload');
const download = document.querySelector('#lab-download');
const runButtons = [...document.querySelectorAll('[data-lab-command]')];
const assets = new URL(lab.dataset.assets, location.href).href;
const runtime = new URL(lab.dataset.runtime, location.href).href;
let worker, terminal, fit, ready = false, timeout;
function controls(enabled) {
  upload.disabled = download.disabled = !enabled;
  runButtons.forEach(button => { button.disabled = !enabled; });
}
function unload(message = 'Linux stopped. Start again for a fresh workspace.') {
  worker?.terminate(); worker = undefined; ready = false; clearTimeout(timeout);
  terminal?.dispose(); terminal = undefined; fit = undefined;
  start.disabled = false; start.textContent = 'Start Linux'; reset.disabled = true;
  controls(false); status.textContent = message;
}
function resize() {
  if (!fit || !terminal) return;
  fit.fit();
  worker?.postMessage({type:'resize',columns:terminal.cols,rows:terminal.rows});
}
start.addEventListener('click', () => {
  if (!window.WebAssembly || !window.Worker) { status.textContent = 'This browser needs WebAssembly and Web Workers. You can also run the examples locally.'; return; }
  start.disabled = true; reset.disabled = false; controls(false);
  status.textContent = 'Starting Linux… loading the kernel and filesystem';
  try {
    terminal = new Terminal({fontFamily:'ui-monospace, SFMono-Regular, Consolas, monospace',fontSize:13,
      cursorBlink:true,scrollback:3000,screenReaderMode:true,theme:{background:'#0b1012',foreground:'#d5e3d9',cursor:'#b4f5c7'}});
    fit = new FitAddon(); terminal.loadAddon(fit);
    document.querySelector('#lab-terminal').replaceChildren();
    terminal.open(document.querySelector('#lab-terminal')); fit.fit();
    terminal.onData(text => { if (ready) worker.postMessage({type:'input',text}); });
    worker = new Worker(new URL('worker.js', assets), {type:'module'});
    worker.onerror = () => unload('Linux could not load. Check your connection, then start again.');
    worker.onmessage = ({data}) => {
      if (!worker || !terminal) return;
      if (data.type === 'output') terminal.write(data.bytes);
      if (data.type === 'progress' && !ready && data.total) status.textContent = `Starting Linux… ${Math.round(data.loaded / data.total * 100)}% of the current asset`;
      if (data.type === 'ready') {
        clearTimeout(timeout); ready = true; controls(true); start.textContent = 'Linux running';
        status.textContent = 'Ready · Bash, Python, FFmpeg and curl run inside this tab'; terminal.focus();
      }
      if (data.type === 'error') {
        if (!ready || data.fatal) unload('Linux could not start. Try again or run the local examples.');
        else { upload.disabled = download.disabled = false; transferStatus.textContent = data.message; }
      }
      if (data.type === 'uploaded') { upload.disabled = false; transferStatus.textContent = `Added /workspace/inbox/${data.name}`; }
      if (data.type === 'download') {
        download.disabled = false;
        const url = URL.createObjectURL(new Blob([data.bytes],{type:'audio/mp4'}));
        const link = document.createElement('a'); link.href = url; link.download = 'tone.m4a'; link.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000); transferStatus.textContent = 'Downloaded /tmp/tone.m4a';
      }
    };
    timeout = setTimeout(()=>unload('Linux took too long to start. Start again to retry.'),120000);
    worker.postMessage({type:'start',base:assets,runtime,columns:terminal.cols,rows:terminal.rows});
  } catch { unload('This browser could not start Linux. Try the local examples.'); }
});
reset.addEventListener('click', () => { unload(); transferStatus.textContent = 'The guest workspace was discarded.'; });
runButtons.forEach(button => button.addEventListener('click', () => {
  if (!ready) return;
  worker.postMessage({type:'input',text:'\x15' + button.dataset.labCommand + '\r'}); terminal.focus();
}));
upload.addEventListener('change', async () => {
  const file = upload.files?.[0]; if (!file || !ready) return;
  if (file.size > 8 * 1024 * 1024) { transferStatus.textContent = 'Choose a file up to 8 MiB for this lab.'; upload.value = ''; return; }
  upload.disabled = true;
  let name = file.name.replace(/[^a-zA-Z0-9._ -]/g,'_') || 'input.bin';
  if (name === '.' || name === '..') name = 'input.bin';
  const target = worker;
  try {
    const bytes = await file.arrayBuffer();
    if (worker === target && ready) target.postMessage({type:'upload',name,bytes},[bytes]);
  } catch {
    if (worker === target && ready) {
      upload.disabled = false; transferStatus.textContent = 'Could not read this file. Try again.';
    }
  } finally { upload.value = ''; }
});
download.addEventListener('click', () => {
  if (!ready) return;
  download.disabled = true;
  transferStatus.textContent = 'Waiting for the shell to finish and flush the audio file…';
  worker.postMessage({type:'download'});
});
new ResizeObserver(resize).observe(document.querySelector('#lab-terminal'));
window.addEventListener('pagehide',()=>worker?.terminate());
controls(false); reset.disabled = true;
