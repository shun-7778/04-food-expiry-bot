// richmenu.html を Edge（ヘッドレス）で 2500×1200 に撮り、richmenu.png と RichMenuImage.gs を作る。
//   node richmenu.mjs
// Windows の Edge を使う。場所が違うときは環境変数 EDGE_PATH で指定する。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9351;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'richmenu-'));
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: 2500, height: 1200, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: pathToFileURL(path.join(here, 'richmenu.html')).href });
  await sleep(3000); // フォントの読み込みを待つ
  const shot = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 2500, height: 1200, scale: 1 } });
  const png = Buffer.from(shot.result.data, 'base64');
  fs.writeFileSync(path.join(here, 'richmenu.png'), png);

  const b64 = png.toString('base64');
  const lines = b64.match(/.{1,100}/g).map((s) => "  '" + s + "'").join(' +\n');
  fs.writeFileSync(path.join(here, 'RichMenuImage.gs'),
    '/**\n * リッチメニューの画像（2500×1200 PNG）を base64 で持たせたもの。\n * richmenu.mjs が richmenu.html から作る。手で編集しないこと。\n */\n' +
    'var RICHMENU_IMAGE_BASE64 =\n' + lines + ';\n');
  console.log('richmenu.png を作りました: ' + Math.round(png.length / 1024) + 'KB');
  ws.close();
} finally {
  edge.kill();
}
