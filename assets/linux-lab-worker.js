import { V86 } from './libv86.mjs';

let vm, booted = false, loaded = false, tail = '', output = [], flushTimer;
let columns = 80, rows = 24;
let pendingDownload = false;
function flush() {
  flushTimer = undefined;
  if (!output.length) return;
  const bytes = new Uint8Array(output); output = [];
  self.postMessage({ type: 'output', bytes }, [bytes.buffer]);
}
function fail(error, fatal = false) { self.postMessage({ type: 'error', message: error.message || String(error), fatal }); }
async function geometry() {
  if (loaded) await vm.create_file('root/.lab-size', new TextEncoder().encode(`${columns} ${rows}\n`));
}
self.addEventListener('unhandledrejection', event => { event.preventDefault(); fail(event.reason, true); });
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'start') {
      const asset = name => new URL(name, data.base).href;
      const response = await fetch(asset('runtime.json'));
      if (!response.ok) throw new Error('Could not load the runtime manifest.');
      const assets = await response.json();
      const runtime = name => new URL(assets[name], data.runtime).href;
      columns = data.columns; rows = data.rows;
      vm = new V86({
        wasm_fn: async imports => {
          async function bytes(name) {
            const response = await fetch(runtime(name));
            if (!response.ok) throw new Error(`Could not load ${name}`);
            return response.arrayBuffer();
          }
          const source = await bytes('v86.wasm');
          try { return (await WebAssembly.instantiate(source, imports)).instance.exports; }
          catch { return (await WebAssembly.instantiate(await bytes('v86-fallback.wasm'), imports)).instance.exports; }
        }, memory_size: 256 * 1024 * 1024,
        bios: {url:runtime('seabios.bin')}, vga_bios: {url:runtime('vgabios.bin')},
        bzimage_initrd_from_filesystem:true,
        filesystem: {basefs:asset('filesystem.json'),baseurl:data.runtime},
        cmdline: 'rw root=host9p rootfstype=9p rootflags=trans=virtio,cache=loose modules=virtio_pci console=ttyS0,115200 tsc=reliable mitigations=off random.trust_cpu=on quiet',
        autostart:false, disable_keyboard:true, disable_mouse:true, disable_speaker:true,
        // No external network backend. Linux loopback still works inside the VM.
      });
      vm.add_listener('emulator-loaded', async () => {
        try { loaded = true; await geometry(); vm.run(); } catch (error) { fail(error, true); }
      });
      vm.add_listener('download-error', () => fail(new Error('A Linux asset could not load.'), true));
      vm.add_listener('download-progress', progress => self.postMessage({type:'progress',loaded:progress.loaded,total:progress.total}));
      vm.add_listener('serial0-output-byte', byte => {
        output.push(byte);
        if (!flushTimer) flushTimer = setTimeout(flush, 20);
        tail = (tail + String.fromCharCode(byte)).slice(-4096);
        if (pendingDownload && tail.endsWith('\x1b]777;lab-download-ready\x07')) {
          pendingDownload = false;
          vm.read_file('tmp/tone.m4a').then(bytes => self.postMessage({type:'download',bytes},[bytes.buffer]), fail);
        }
        if (!booted && tail.includes('Clyops Linux lab ready.')) {
          booted = true; self.postMessage({type:'ready'});
        }
      });
    } else if (data.type === 'input' && booted) vm.serial0_send(data.text);
    else if (data.type === 'resize') { columns = data.columns; rows = data.rows; await geometry(); }
    else if (data.type === 'upload') {
      if (!booted) throw new Error('Start Linux before adding files.');
      if (!/^[a-zA-Z0-9._ -]+$/.test(data.name) || data.name === '.' || data.name === '..') throw new Error('Invalid guest filename.');
      await vm.create_file('workspace/inbox/' + data.name, new Uint8Array(data.bytes));
      self.postMessage({type:'uploaded',name:data.name});
    } else if (data.type === 'download') {
      if (!booted) throw new Error('Start Linux before downloading files.');
      pendingDownload = true;
      vm.serial0_send('\x15lab-download\r');
    }
  } catch (error) { fail(error, data.type === 'start'); }
};
