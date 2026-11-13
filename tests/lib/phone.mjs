/**
 * A headless Chrome page, driven over CDP, for tests.
 *
 * One instance = one phone: its own profile, so each has its own localStorage.
 * Dialogs are accepted automatically, because the app uses confirm() for the
 * destructive things and a test that cannot click OK tests nothing.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Phone {
  constructor(port, label = 'phone') {
    this.port = port;
    this.label = label;
    this.msgId = 0;
    this.pending = new Map();
    this.profile = mkdtempSync(join(tmpdir(), 'mm-' + label + '-'));
    this.dialogs = [];
  }

  async launch() {
    this.proc = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.profile}`, 'about:blank',
    ], { stdio: 'ignore' });

    for (let i = 0; i < 80; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
        const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) { await this.connect(page.webSocketDebuggerUrl); return this; }
      } catch { /* not up yet */ }
      await sleep(150);
    }
    throw new Error('chrome did not start on port ' + this.port);
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.addEventListener('error', reject);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); return; }
        if (m.method === 'Page.javascriptDialogOpening') {
          this.dialogs.push(m.params.message);
          this.send('Page.handleJavaScriptDialog', { accept: true });
        }
      });
      this.ws.addEventListener('open', async () => {
        await this.send('Page.enable');
        // Headless tabs report themselves hidden, which (correctly) pauses polling.
        await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        resolve();
      }, { once: true });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return undefined;
    return r.result?.result?.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 100; i++) {
      if (await this.js("document.readyState === 'complete' && !!document.querySelector('header, .view')")) return;
      await sleep(100);
    }
  }

  click(sel) {
    return this.js(`(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false; el.click(); return true; })()`);
  }

  text() { return this.js('document.body.innerText'); }

  async waitFor(fn, label, ms = 15000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
      const v = await fn();
      if (v) return v;
      await sleep(250);
    }
    throw new Error('timed out waiting for: ' + label);
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.proc?.kill('SIGKILL'); } catch { /* ignore */ }
    try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export { sleep };
