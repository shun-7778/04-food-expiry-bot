// web.html を、logic.gs で応答する模擬サーバー付きで Edge（スマホ幅 390px）に開いて操作する
//   node test/web.test.mjs
// 画面写真は test/shots/ に出る（git には入れない）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = process.argv[2] || path.resolve(dir, '..');
const shots = path.join(dir, 'shots'); fs.mkdirSync(shots, { recursive: true });

const mock = `<script>
${fs.readFileSync(path.join(SRC, 'logic.gs'), 'utf8')}
// ---- 模擬サーバー（webapp.gs の API と同じ形で返す） ----
var MOCK = { rows: [], today: '2026-10-24', opened: [], fail: false, delay: 60 };
function mockAct(plan) {
  var st = gymState_(MOCK.rows, MOCK.today);
  var p = plan(st, MOCK.today, Math.random, MOCK.rows);
  if (p.error) throw new Error(p.error);
  if (p.append) { var id = MOCK.rows.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1; MOCK.rows.push(Object.assign({ id: id, status: '有効' }, p.append)); p.event.id = id; }
  if (p.update) { var r = MOCK.rows.filter(function (x) { return x.id === p.update.id; })[0]; Object.assign(r, p.update.patch); }
  return { state: gymState_(MOCK.rows, MOCK.today), event: p.event };
}
var API = {
  webState: function () { return { state: gymState_(MOCK.rows, MOCK.today), event: null }; },
  webStamp: function () { if (MOCK.fail) throw new Error('通信に失敗しました（テスト）'); return mockAct(gymPlanStamp_); },
  webUseCoin: function () { return mockAct(gymPlanUseCoin_); },
  webEarnCoin: function () { return mockAct(gymPlanEarnCoin_); },
  webExchange: function () { return mockAct(gymPlanExchange_); },
  webCancel: function (t, id) { return mockAct(function (st, today, rand, rows) { return gymPlanCancel_(rows, id); }); },
  webErase: function (t, tab) { return mockAct(function (st) { return gymPlanErase_(st, tab); }); },
  webOpened: function (t, id) { MOCK.opened.push(id); return { state: gymState_(MOCK.rows, MOCK.today), event: null }; }
};
function runner() {
  var ok = function () {}, ng = function () {}, r = {};
  r.withSuccessHandler = function (f) { ok = f; return r; };
  r.withFailureHandler = function (f) { ng = f; return r; };
  Object.keys(API).forEach(function (k) {
    r[k] = function () { var a = arguments; setTimeout(function () { try { ok(JSON.parse(JSON.stringify(API[k].apply(null, a)))); } catch (e) { ng(e); } }, MOCK.delay); };
  });
  return r;
}
window.google = { script: { get run() { return runner(); } } };
</script>
`;
let html = fs.readFileSync(path.join(SRC, 'web.html'), 'utf8')
  .replace('<?= token ?>', 'TKN').replace('<?= tab ?>', 'stamp')
  // 本番では doGet の addMetaTag('viewport', …) が付けるもの
  .replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">');
html = html.replace(/<script>\n\(function \(\) \{\n  var TOKEN/, mock + '<script>\n(function () {\n  var TOKEN');
if (!html.includes('var MOCK')) throw new Error('模擬サーバーを差し込めませんでした');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-web-test-'));
const page = path.join(work, 'web-test.html');
fs.writeFileSync(page, html);

const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9341;
const edge = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(work, 'profile'), '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0; const waits = new Map(); const errors = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try { const p = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch (e) {}
    await sleep(200);
  }
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waits.has(d.id)) { waits.get(d.id)(d); waits.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  });
}
const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; waits.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
async function ev(expr) {
  const r = await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result.exceptionDetails) throw new Error('評価エラー: ' + expr + '\n' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result.result.value;
}
async function shot(name, clip) {
  const r = await cmd('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : { format: 'png' });
  fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'));
}
const results = [];
const check = (name, ok, detail = '') => results.push((ok ? 'OK  ' : 'NG  ') + name + (detail && !ok ? '  … ' + detail : ''));
const click = (sel) => ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`);
// 本当に画面に見えているか（CSS で display:none になっていないか）で判定する
const visible = (sel) => ev(`(function(){var e=document.querySelector(${JSON.stringify(sel)}); return !!e && e.checkVisibility() && e.getBoundingClientRect().width>0;})()`);
const settle = () => sleep(250);
async function setToday(ymd) { await ev(`MOCK.today=${JSON.stringify(ymd)}; document.dispatchEvent(new Event('visibilitychange'))`); await settle(); }
const nRows = () => ev('MOCK.rows.filter(function(x){return x.status!=="取消"}).length');

try {
  await connect();
  await cmd('Runtime.enable'); await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await cmd('Page.navigate', { url: pathToFileURL(page).href });
  await sleep(2500);

  check('読み込むとスタンプラリーが出る', await visible('#app'));
  check('最初はほめる画面・ご褒美の箱・選択画面が出ていない', !(await visible('#cheer')) && !(await visible('#party')) && !(await visible('#choice')) && !(await visible('#busy')));
  check('音のスイッチは無い（音は鳴らさない）', !(await ev('!!document.getElementById("soundOn") || /AudioContext/.test(document.documentElement.innerHTML)')));
  check('マスが40個', (await ev('document.querySelectorAll(".node").length')) === 40);
  check('横スクロールが出ない', (await ev('document.documentElement.scrollWidth - innerWidth')) <= 0);
  const ov = await ev(`(function(){var d=[].slice.call(document.querySelectorAll('.deco > g')).map(function(g){return g.getBoundingClientRect();});
    var l=[].slice.call(document.querySelectorAll('.banner,.cap,.flag,.node .slot')).map(function(e){return e.getBoundingClientRect();});
    function hit(a,b){return a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1;}
    var n=0; d.forEach(function(a){l.forEach(function(b){if(hit(a,b))n++;});}); return n;})()`);
  check('季節の絵が文字やマスと重ならない', ov === 0, '重なり ' + ov);
  await shot('w01-top');

  // 並び：タブは上に固定、「消す」は大きなボタンのすぐ下、案内は一番下、区切り線とコインの記録は無い
  const order = (panel) => ev(`(function(){var p=document.querySelector(${JSON.stringify(panel)});
    return [].slice.call(p.children).map(function(e){return e.id||e.className;}); })()`);
  await ev('window.scrollTo(0, 1500)'); await sleep(200);
  check('下にスクロールしてもタブが上に見えている', await ev('(function(){var r=document.querySelector(".tabs").getBoundingClientRect();return r.top>=0&&r.top<40;})()'));
  await ev('window.scrollTo(0, 0)');
  const so = await order('#panelStamp');
  check('スタンプ：ボタン → 消す → 案内（一番下）の順', so.slice(-3).join() === 'sticky-act,erase,stampHint', so.join());
  check('「消す」の上に区切り線が無い', (await ev('getComputedStyle(document.getElementById("erase")).borderTopStyle')) === 'none');
  check('コインの記録は無い', !(await ev('!!document.getElementById("coinLog") || document.body.innerText.includes("コインの記録")')));
  await click('#tabCoin');
  const co = await order('#panelCoin');
  check('コイン：ボタンのすぐ下に「消す」', co.slice(-2).join() === 'sticky-act,erase', co.join());
  await click('#tabStamp');

  // サーバーの返事を待つあいだも、画面全体が崩れない（以前は body が黒く細くなっていた）
  const layout = () => ev(`(function(){var b=document.body.getBoundingClientRect(), s=getComputedStyle(document.body);
    return { w: Math.round(b.width), iw: innerWidth, bg: s.backgroundColor, pos: s.position }; })()`);
  const sameLayout = (a, b) => a.w === b.w && a.bg === b.bg && a.pos === b.pos;
  const before = await layout();
  await ev('MOCK.delay=1500');
  await ev(`document.dispatchEvent(new Event('visibilitychange'))`); await sleep(300);
  const reloading = await layout();
  check('読み直し中も画面の幅・背景が変わらない', sameLayout(before, reloading) && reloading.w === reloading.iw, JSON.stringify([before, reloading]));
  check('読み直し中は「記録中…」を出さない', !(await visible('#busy')));
  await sleep(1500);
  await click('#stampBtn'); await sleep(300);
  const recording = await layout();
  check('記録中も画面の幅・背景が変わらない', sameLayout(before, recording), JSON.stringify([before, recording]));
  check('記録中は上に「記録中…」の小さな表示が出る', (await visible('#busy')) && (await ev('document.getElementById("busy").getBoundingClientRect().width')) < 200);
  await shot('w00-recording');
  await sleep(1500); await ev('MOCK.delay=60');

  // スタンプ（上で押したぶん）
  await settle();
  check('押すと記録され、ほめる画面が出る', (await nRows()) === 1 && (await visible('#cheer')));
  await sleep(3500);
  check('ほめる画面は自動で閉じない', await visible('#cheer'));
  await click('#cheer'); await sleep(100);
  check('押した日がマスの下に出る', (await ev('document.querySelector(".node.done .cap").textContent')) === '10/24');
  check('同じ週はボタンが押せない', await ev('document.getElementById("stampBtn").disabled'));
  await click('[data-view="0"]'); await sleep(200);
  check('押したマスをタップすると同じ画面', (await visible('#cheer')) && (await ev('document.getElementById("cheerTitle").textContent')).length > 0);
  await click('#cheer');

  // コイン
  await setToday('2026-10-25');
  await click('#tabCoin'); await click('#coinBtn'); await settle();
  check('翌日にコインがもらえる', (await ev('document.getElementById("coinBadge").textContent')) === '1');
  await click('#cheer');
  check('コインタブも横スクロールが出ない', (await ev('document.documentElement.scrollWidth - innerWidth')) <= 0);

  // 翌週：コインを使う
  await setToday('2026-10-28');
  await click('#tabStamp');
  const pos = await ev('(function(){var a=document.getElementById("stampBtn").getBoundingClientRect(),b=document.querySelector("#useWrapStamp .btn");if(!b)return null;b=b.getBoundingClientRect();return [a.top,b.top,b.right,innerWidth];})()');
  check('「今週ジムに行った！」の右に「コインを使う」が並ぶ', pos && Math.abs(pos[0] - pos[1]) < 6 && pos[2] <= pos[3], JSON.stringify(pos));
  await shot('w02-buttons');
  await click('#useWrapStamp .btn'); await settle();
  check('コインで今週が埋まる', (await ev('document.querySelectorAll(".node.done").length')) === 2 && (await ev('document.getElementById("coinBadge").textContent')) === '0');
  await click('#cheer');
  // 結局行けた
  await setToday('2026-10-31');
  check('穴埋めした週はボタンが「スタンプに変える」になる', (await ev('document.getElementById("stampBtn").textContent')).includes('スタンプに変える'));
  await click('#stampBtn'); await settle(); await click('#cheer');
  check('スタンプに変わり、コインが戻る', (await ev('document.getElementById("coinBadge").textContent')) === '1');

  // 6マス目（プチご褒美）まで進める
  for (const d of ['2026-11-02', '2026-11-09', '2026-11-16']) { await setToday(d); await click('#stampBtn'); await settle(); await click('#cheer'); }
  await setToday('2026-11-23');
  await click('#stampBtn'); await settle();
  check('6マス目でプチご褒美の箱が出る', (await visible('#party')) && (await ev('document.getElementById("party").classList.contains("petit")')));
  check('開ける前は中身の名前を出さない', !(await ev('document.body.innerText.includes("マッサージ")')));
  await click('#partyClose'); await settle();
  check('開ける前に×で閉じると取り消される', (await ev('document.querySelectorAll(".node.done").length')) === 5);
  await click('#stampBtn'); await settle();
  await click('#partyBtn'); await sleep(900);
  check('「あける」の直後は揺れている', await ev('document.getElementById("party").classList.contains("shaking")'));
  await sleep(1400);
  check('揺れたあとに開き、マッサージと絵が出る', (await ev('document.getElementById("partyReward").textContent')) === '「マッサージ」' && (await ev('document.getElementById("partyArt").innerHTML.length')) > 0);
  check('開けたことをサーバーに伝える', (await ev('MOCK.opened.length')) === 1);
  await shot('w03-petit-open');
  await click('#partyBtn'); await sleep(100);
  await click('[data-view="5"]'); await sleep(200);
  check('押したご褒美のマスをタップすると、開いた画面（クラッカーなし）', await ev('document.getElementById("party").classList.contains("quiet")'));
  await click('#partyBtn');

  // 消す
  await click('#eraseAsk'); await sleep(100);
  check('消す前に確認が出る', await visible('#eraseYes'));
  await click('#eraseYes'); await settle();
  check('最後のスタンプが消える', (await ev('document.querySelectorAll(".node.done").length')) === 5);

  // エラーの表示
  await ev('MOCK.fail=true'); await setToday('2026-11-30');
  await click('#stampBtn'); await settle();
  check('失敗したらエラーを画面に出す', (await visible('#err')) && (await ev('document.getElementById("err").textContent')).includes('失敗'));
  await ev('MOCK.fail=false');

  // コイン5枚 → 選ぶ → ためる → 6枚目は2行目
  await ev('MOCK.rows=[]'); await setToday('2026-10-24');
  const mondays = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'];
  for (let i = 0; i < 6; i++) {
    await setToday(mondays[i]); await click('#tabStamp'); await click('#stampBtn'); await settle();
    if (await visible('#party')) { await click('#partyBtn'); await sleep(2300); await click('#partyBtn'); }
    await click('#cheer');
    const tue = mondays[i].replace(/-(\d\d)$/, (m, d) => '-' + String(Number(d) + 1).padStart(2, '0'));
    await setToday(tue); await click('#tabCoin'); await click('#coinBtn'); await settle();
    if (i === 4) {
      check('5枚目で「交換するか・ためるか」が出る', await visible('#choice'));
      await click('#keepBtn'); await sleep(100);
    }
    await click('#cheer');
  }
  check('ためておくと、6枚目は2行目に入る', (await ev('document.querySelectorAll(".tray-row").length')) === 2 && (await ev('document.querySelectorAll(".tray-row")[1].querySelectorAll(".tslot.filled").length')) === 1);
  const tray = await ev('(function(){var r=document.getElementById("tray").getBoundingClientRect();return [r.left,r.right,innerWidth];})()');
  check('コインの枠が画面に収まる', tray[0] >= 8 && tray[1] <= tray[2] - 8, JSON.stringify(tray));
  await shot('w04-coin');
  await click('[data-exchange]'); await sleep(100); await click('#exchangeBtn'); await settle();
  await click('#partyBtn'); await sleep(2300);
  check('交換すると手作りお菓子', (await ev('document.getElementById("partyReward").textContent')) === '「手作りお菓子」');
  await click('#partyBtn'); await sleep(100);
  check('交換で手持ちが5枚減る', (await ev('document.getElementById("coinBadge").textContent')) === '1');

  // 11マス目のご褒美
  await ev(`(function(){MOCK.rows=[];for(var i=0;i<10;i++)MOCK.rows.push({id:i+1,type:'スタンプ',date:'2026-11-0'+(i%9+1),kind:'star',r:0,title:'a',text:'b',status:'有効'});})()`);
  await setToday('2027-01-04'); await click('#tabStamp');
  await click('#stampBtn'); await settle(); await click('#partyBtn'); await sleep(2300);
  check('11マス目のご褒美は登山靴', (await ev('document.getElementById("partyReward").textContent')) === '「登山靴」');
  const pop = await ev('[].slice.call(document.querySelectorAll(".popper")).map(function(p){var r=p.getBoundingClientRect();return [r.left,r.right];})');
  check('クラッカーが画面からはみ出ない', pop.every((p) => p[0] >= 0 && p[1] <= 390), JSON.stringify(pop));
  await shot('w05-reward');
  await click('#partyBtn');

  const fullH = await ev('document.documentElement.scrollHeight');
  await ev('window.scrollTo(0,0)');
  await shot('w06-full', { x: 0, y: 0, width: 390, height: Math.min(fullH, 3000) });
  check('スクリプトのエラーがない', errors.length === 0, errors.join(' | '));
} catch (e) {
  results.push('NG  テストが途中で止まりました: ' + e.message);
} finally {
  console.log(results.join('\n'));
  console.log('\n' + results.filter((x) => x.startsWith('OK')).length + ' / ' + results.length + ' OK');
  try { ws && ws.close(); } catch (e) {}
  edge.kill();
}
