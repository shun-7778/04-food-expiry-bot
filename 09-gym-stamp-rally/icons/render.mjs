// icons/*.html を Edge（ヘッドレス）で 640×640 の PNG にする。
//   node icons/render.mjs
// LINE のプロフィール画像（トプ画）用。同じ名前の .png ができる。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9371;
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + fs.mkdtempSync(path.join(os.tmpdir(), 'icons-')), '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ws;
  for (let i = 0; i < 50 && !ws; i++) {
    try { const p = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch (e) {}
    if (!ws) await sleep(200);
  }
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const waits = new Map();
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); } });
  const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 640, height: 640, deviceScaleFactor: 1, mobile: false });
  for (const f of fs.readdirSync(here).filter((x) => x.endsWith('.html'))) {
    await cmd('Page.navigate', { url: pathToFileURL(path.join(here, f)).href });
    await sleep(800);
    const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 640, height: 640, scale: 1 } });
    fs.writeFileSync(path.join(here, f.replace(/\.html$/, '.png')), Buffer.from(shot.result.data, 'base64'));
    console.log(f.replace(/\.html$/, '.png') + ' を作りました');
  }
  ws.close();
} finally {
  edge.kill();
}
