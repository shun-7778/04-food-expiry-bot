// 09-gym-stamp-rally の .gs を、Google / LINE の代わりの模擬環境で動かして確かめる
//   node test/gas.test.js
// シート・LINE API・トリガーは偽物に差し替え、LINE に何が送られるかまで見る
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const path = require('path');

const SRC = process.argv[2] || path.resolve(__dirname, '..');
const files = ['logic.gs', 'security.gs', 'webapp.gs', 'main.gs'];

const results = [];
function check(name, ok, detail) { results.push((ok ? 'OK  ' : 'NG  ') + name + (detail !== undefined && !ok ? '  … ' + detail : '')); }

function makeEnv() {
  const RealDate = Date;
  let NOW = RealDate.UTC(2026, 9, 24, 3, 0, 0); // 2026-10-24 12:00 JST（土）
  class FakeDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(NOW); else super(...a); }
    static now() { return NOW; }
  }
  const props = {};
  const calls = [];            // LINE API 呼び出し
  let sheetRows = null;        // シートの中身（2次元配列）
  const triggers = [];

  function rangeOf(r, c, nr, nc) {
    nr = nr || 1; nc = nc || 1;
    return {
      getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(((sheetRows[r - 1 + i] || [])[c - 1 + j]) ?? ''); out.push(row); } return out; },
      setValues(v) { v.forEach((row, i) => row.forEach((x, j) => { while (sheetRows.length < r + i) sheetRows.push([]); sheetRows[r - 1 + i][c - 1 + j] = x; })); return this; },
      setValue(x) { while (sheetRows.length < r) sheetRows.push([]); sheetRows[r - 1][c - 1] = x; return this; },
      setFontWeight() { return this; }, setNumberFormat() { return this; }
    };
  }
  let sheetName = 'シート1';
  const sheet = {
    setName(n) { sheetName = n; return sheet; },
    getName() { return sheetName; },
    getRange(a, b, c, d) { if (typeof a === 'string') return rangeOf(1, 4, 1, 1); return rangeOf(a, b, c, d); },
    getLastRow() { return sheetRows.length; },
    appendRow(row) { sheetRows.push(row.slice()); },
    setFrozenRows() {}
  };
  const ss = { getId: () => 'SSID', getUrl: () => 'https://docs.google.com/ss', getSheets: () => [sheet], getSheetByName: (n) => (n === sheetName ? sheet : null) };

  function pad(n) { return ('0' + n).slice(-2); }
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => ctx.__errors.push(a.join(' ')) },
    __errors: [],
    Date: FakeDate, Math, JSON, Object, Array, String, Number, RegExp, Error, encodeURIComponent,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; },
      deleteProperty: (k) => { delete props[k]; }, getProperties: () => Object.assign({}, props)
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      formatDate(d, tz, fmt) {
        const j = new RealDate(d.getTime() + 9 * 3600e3);
        const ymd = j.getUTCFullYear() + '-' + pad(j.getUTCMonth() + 1) + '-' + pad(j.getUTCDate());
        return fmt === 'yyyy-MM-dd' ? ymd : ymd + ' ' + pad(j.getUTCHours()) + ':' + pad(j.getUTCMinutes()) + ':' + pad(j.getUTCSeconds());
      },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s).digest()).map((b) => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
      newBlob: (bytes) => ({ getBytes: () => bytes })
    },
    UrlFetchApp: { fetch(url, opt) {
      opt = opt || {};
      calls.push({ url, method: opt.method || 'get', body: opt.payload && typeof opt.payload === 'string' ? JSON.parse(opt.payload) : null });
      let text = '{}';
      if (/richmenu\/list/.test(url)) text = '{"richmenus":[{"richMenuId":"old1"}]}';
      else if (/\/richmenu$/.test(url) && opt.method === 'post') text = '{"richMenuId":"rm-new"}';
      const code = /user\/all\/richmenu/.test(url) ? 404 : 200;
      return { getResponseCode: () => code, getContentText: () => text };
    } },
    SpreadsheetApp: {
      create() { sheetRows = []; return ss; },
      openById(id) { if (id !== 'SSID') throw new Error('bad id'); return ss; }
    },
    ScriptApp: {
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/AKfyTEST/exec' }),
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger(fn) { const t = { fn, getHandlerFunction: () => fn }; const chain = { timeBased: () => chain, onWeekDay: (d) => { t.day = d; return chain; }, atHour: (h) => { t.hour = h; return chain; }, create: () => { triggers.push(t); return t; } }; return chain; },
      WeekDay: { WEDNESDAY: 'WED', SUNDAY: 'SUN' }
    },
    ContentService: { createTextOutput: (s) => ({ setMimeType() { return s; } }), MimeType: { JSON: 'json' } },
    HtmlService: {
      createHtmlOutput: (s) => ({ html: s }),
      createTemplateFromFile: () => { const t = { evaluate: () => ({ page: true, token: t.token, tab: t.tab, setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }) }; return t; },
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' }
    },
    RICHMENU_IMAGE_BASE64: Buffer.from('png').toString('base64')
  };
  vm.createContext(ctx);
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));
  return {
    ctx, props, calls, triggers,
    setNow(ymd, hourJst = 12) { const [y, m, d] = ymd.split('-').map(Number); NOW = RealDate.UTC(y, m - 1, d, hourJst - 9, 0, 0); },
    rows: () => sheetRows,
    sheetName: () => sheetName,
    // ドライブで作ったスプレッドシート（見出し1行だけ・シート名は別）を用意する
    driveSheet() { sheetRows = [['ID', '登録日時', '種類', '日付', 'スタンプ', '角度', '見出し', 'ことば', '状態', '更新日時']]; sheetName = 'ジムスタンプラリー'; },
    pushes: () => calls.filter((c) => /message\/(push|multicast)/.test(c.url)),
    replies: () => calls.filter((c) => /message\/reply/.test(c.url)),
    clear() { calls.length = 0; }
  };
}

function post(env, events, s) {
  return env.ctx.doPost({ parameter: { s: s ?? env.props.WEBHOOK_SECRET }, postData: { contents: JSON.stringify({ events }) } });
}
const WIFE = 'Uwife', HUSB = 'Uhusb', STRANGER = 'Ustranger';
const txt = (uid, text) => ({ type: 'message', replyToken: 'rt-' + text, source: { userId: uid }, message: { type: 'text', text } });

// ---------------------------------------------------------------- ドライブで作ったスプレッドシートを使う場合
{
  const e2 = makeEnv();
  Object.assign(e2.props, { LINE_CHANNEL_ACCESS_TOKEN: 'tok', PLAYER_USER_ID: WIFE, SPREADSHEET_ID: 'SSID', WEB_EXEC_URL: 'https://script.google.com/macros/s/AKfyTEST/exec' });
  e2.driveSheet();
  const r2 = e2.ctx.webStamp(e2.ctx.webToken_());
  check('ドライブで作ったスプレッドシートでも、ID を入れるだけで記録できる', r2.state.squares.length === 1 && e2.rows().length === 2);
  check('そのとき先頭のシートが「記録」に名前を変えられる', e2.sheetName() === '記録');
  e2.ctx.setupSpreadsheet();
  check('ID が入っていれば setupSpreadsheet は作り直さない', e2.rows().length === 2);
}

// ---------------------------------------------------------------- 準備
const env = makeEnv();
const g = env.ctx;
Object.assign(env.props, { LINE_CHANNEL_ACCESS_TOKEN: 'tok', PLAYER_USER_ID: WIFE, WATCHER_USER_IDS: HUSB });
g.setupSpreadsheet();
check('setupSpreadsheet でシートと SPREADSHEET_ID ができる', env.props.SPREADSHEET_ID === 'SSID' && env.rows()[0][0] === 'ID');
g.PROP_CACHE_ = null;
const hook = g.setupWebhookSecret();
check('setupWebhookSecret が ?s= 付きの /exec URL を返す', /\/exec\?s=[0-9a-f]{32}$/.test(hook), hook);
const token = g.webToken_();

// ---------------------------------------------------------------- 画面を開く
check('正しいトークンで画面が開く', !!g.doGet({ parameter: { k: token, tab: 'coin' } }).page);
check('タブの指定（coin）が渡る', g.doGet({ parameter: { k: token, tab: 'coin' } }).tab === 'coin');
check('トークンが違うと画面を出さない', !!g.doGet({ parameter: { k: 'x' } }).html);
let threw = false; try { g.webState('bad'); } catch (e) { threw = true; }
check('トークンが違うと API も使えない', threw);

// ---------------------------------------------------------------- Webhook
env.clear();
post(env, [txt(STRANGER, '状況')]);
check('許可していない人のメッセージには反応しない', env.calls.length === 0, JSON.stringify(env.calls));
post(env, [txt(STRANGER, 'id')]);
check('「id」だけは誰にでも userId を返す', env.replies().length === 1 && env.replies()[0].body.messages[0].text.includes(STRANGER));
env.clear();
post(env, [txt(WIFE, '状況')], 'wrong');
check('合言葉が違う POST は無視する', env.calls.length === 0);
post(env, [txt(WIFE, '状況')]);
const st0 = env.replies()[0] && env.replies()[0].body.messages[0];
check('「状況」に進み具合を返す', st0 && st0.text.includes('すすんだマス 0 / 40'), st0 && st0.text);
check('返信に「スタンプラリーを開く」ボタンが付く', st0 && st0.quickReply.items[0].action.uri.includes('k=' + token));

// ---------------------------------------------------------------- スタンプ（画面から）
env.clear();
let r = g.webStamp(token);
check('スタンプを押すと1マス目になる', r.state.squares.length === 1 && r.event.type === 'stamp');
check('シートに1行書かれる', env.rows().length === 2 && env.rows()[1][2] === 'スタンプ' && env.rows()[1][3] === '2026-10-24', JSON.stringify(env.rows()[1]));
const p1 = env.pushes();
check('本人に「がんばったね」系のメッセージを push', p1.some((c) => c.body.to === WIFE && /マス目/.test(c.body.messages[0].text)), JSON.stringify(p1.map((c) => c.body)));
check('夫にお知らせを push', p1.some((c) => c.body.to === HUSB && /ジムに行きました/.test(c.body.messages[0].text)));
threw = ''; try { g.webStamp(token); } catch (e) { threw = e.message; }
check('同じ週に2回は押せない', /もう押してあります/.test(threw), threw);

// ---------------------------------------------------------------- コイン
threw = ''; try { g.webEarnCoin(token); } catch (e) { threw = e.message; }
check('スタンプと同じ日にはコインをもらえない', /今日の分/.test(threw), threw);
env.setNow('2026-10-25');
env.clear();
r = g.webEarnCoin(token);
check('翌日（同じ週）にもう1回行くとコイン1枚', r.state.held === 1 && r.event.type === 'coin');
check('コインでも本人と夫に知らせる', env.pushes().length === 2);
env.setNow('2026-10-26');  // 月曜＝新しい週
threw = ''; try { g.webEarnCoin(token); } catch (e) { threw = e.message; }
check('新しい週はスタンプ前にコインをもらえない', /先に今週のスタンプ/.test(threw), threw);

// ---------------------------------------------------------------- 声かけ
env.clear();
env.setNow('2026-10-28', 20);
g.remindMidweek();
check('水曜：まだ行っていなければ本人に声かけ', env.pushes().length === 1 && env.pushes()[0].body.to === WIFE, JSON.stringify(env.pushes().map((c) => c.body)));
env.clear();
env.setNow('2026-11-01', 17);
g.remindWeekend();
const wk = env.pushes()[0];
check('日曜：コインがあれば「コインを使う」ボタン付きで聞く', wk && wk.body.messages[0].quickReply.items.some((i) => i.action.data === 'use_coin'), wk && JSON.stringify(wk.body));

// ---------------------------------------------------------------- LINE から「コインを使う」
env.clear();
post(env, [{ type: 'postback', replyToken: 'rt-pb', source: { userId: WIFE }, postback: { data: 'use_coin' } }]);
let st = g.currentState_();
check('「コインを使う」で今週が埋まり、コインが減る', st.squares.length === 2 && st.squares[1].paid && st.held === 0, JSON.stringify({ n: st.squares.length, held: st.held }));
check('LINE からの操作は返信で返す（無料枠を使わない）', env.replies().length === 1 && env.pushes().filter((c) => c.body.to === WIFE).length === 0);
check('夫には穴埋めしたことを知らせる', env.pushes().some((c) => c.body.to === HUSB && /コインを使って/.test(c.body.messages[0].text)));
env.clear();
g.remindWeekend();
check('今週が埋まっていれば日曜の声かけはしない', env.pushes().length === 0);

// ---------------------------------------------------------------- コインで埋めた週に結局行けた
r = g.webStamp(token);
check('穴埋めした週に行けたらスタンプに変わり、コインが戻る', r.event.type === 'convert' && !r.state.squares[1].paid && r.state.held === 1, JSON.stringify(r.event));

// ---------------------------------------------------------------- ご褒美マス（6マス目はプチ）
for (let w = 0; w < 3; w++) {
  env.setNow(['2026-11-02', '2026-11-09', '2026-11-16'][w]);
  g.webStamp(token);
}
env.setNow('2026-11-23');
env.clear();
r = g.webStamp(token);
check('6マス目はプチご褒美（マッサージ）', r.event.type === 'special' && r.state.squares[5].name === 'マッサージ', JSON.stringify(r.event));
check('箱を開けるまでは LINE に知らせない', env.pushes().length === 0, JSON.stringify(env.pushes().map((c) => c.body)));
const sid = r.event.id;
r = g.webCancel(token, sid);
check('開ける前に×で取り消すと、6マス目が消える', r.state.squares.length === 5);
r = g.webStamp(token);
env.clear();
g.webOpened(token, r.event.id);
const op = env.pushes();
check('開けたら本人に（中身は書かずに）知らせる', op.some((c) => c.body.to === WIFE && /プチご褒美/.test(c.body.messages[0].text) && !/マッサージ/.test(c.body.messages[0].text)), JSON.stringify(op.map((c) => c.body)));
check('夫には中身も知らせる', op.some((c) => c.body.to === HUSB && /マッサージ/.test(c.body.messages[0].text)));

// ---------------------------------------------------------------- 消す
r = g.webErase(token, 'stamp');
check('「最後のスタンプを1つ消す」で6マス目が消える', r.state.squares.length === 5);
check('行は消さず「取消」にする', env.rows().some((row) => row[8] === '取消'));
r = g.webErase(token, 'coin');
check('「最後のコインを1つ消す」で手持ちが減る', r.state.held === 0, JSON.stringify({ held: r.state.held }));

// ---------------------------------------------------------------- 交換
for (let i = 0; i < 5; i++) {
  const mon = new Date(Date.UTC(2026, 10, 30 + i * 7));
  const ymd = (d) => d.toISOString().slice(0, 10);
  env.setNow(ymd(mon)); g.webStamp(token);
  env.setNow(ymd(new Date(mon.getTime() + 864e5)));
  r = g.webEarnCoin(token);
}
check('手持ちが5枚になったら「交換するか」を聞く合図が出る', r.event.choice === true && r.state.canExchange, JSON.stringify({ ev: r.event, held: r.state.held }));
env.clear();
r = g.webExchange(token);
check('交換でコインが5枚減り、手作りお菓子', r.state.held === 0 && r.event.name === '手作りお菓子');
check('交換も、箱を開けるまでは知らせない', env.pushes().length === 0);
g.webOpened(token, r.event.id);
check('開けたら夫に「作ってあげて」と知らせる', env.pushes().some((c) => c.body.to === HUSB && /手作りお菓子/.test(c.body.messages[0].text)));

// ---------------------------------------------------------------- 11マス目のご褒美
st = g.currentState_();
check('ここまでで10マス', st.squares.length === 10, st.squares.length);
env.setNow('2027-01-04');
r = g.webStamp(token);
check('11マス目のご褒美は登山靴', r.event.type === 'special' && r.state.squares[10].name === '登山靴');

// ---------------------------------------------------------------- トリガーとメニュー
g.setupTriggers(); g.setupTriggers();
check('声かけのトリガーは2つ（何度実行しても増えない）', env.triggers.length === 2 && env.triggers.some((t) => t.fn === 'remindMidweek' && t.day === 'WED' && t.hour === 20) && env.triggers.some((t) => t.fn === 'remindWeekend' && t.day === 'SUN' && t.hour === 17));
env.clear();
g.setupRichMenu();
const created = env.calls.find((c) => /\/richmenu$/.test(c.url) && c.method === 'post');
check('リッチメニューは3つのボタン', created && created.body.areas.length === 3);
check('メニューのリンクにトークンが入る', created && created.body.areas[0].action.uri.includes('k=' + token) && created.body.areas[1].action.uri.includes('tab=coin'));
check('古いメニューを消してから作る', env.calls.some((c) => c.method === 'delete' && /richmenu\/old1/.test(c.url)));
check('許可した2人にだけ割り当てる', env.calls.filter((c) => /\/user\/U\w+\/richmenu\/rm-new/.test(c.url)).length === 2);

// ---------------------------------------------------------------- 枠ページ経由のURL
check('既定では、注意バーを出さない枠ページ経由の URL になる', g.webUrl_('stamp').startsWith('https://shun-7778.github.io/04-food-expiry-bot/gym/?u=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2FAKfyTEST%2Fexec&k=' + token + '&tab=stamp'), g.webUrl_('stamp'));
check('メニューのリンクも枠ページ経由', created && created.body.areas[0].action.uri.startsWith('https://shun-7778.github.io/04-food-expiry-bot/gym/?u='));
env.props.WEB_FRAME_URL = 'none'; g.PROP_CACHE_ = null;
check('WEB_FRAME_URL を none にすると、枠を使わず直接開く', g.webUrl_('coin') === 'https://script.google.com/macros/s/AKfyTEST/exec?k=' + token + '&tab=coin', g.webUrl_('coin'));

check('処理中のエラーログがない', g.__errors.length === 0, g.__errors.join(' | '));
console.log(results.join('\n'));
console.log('\n' + results.filter((x) => x.startsWith('OK')).length + ' / ' + results.length + ' OK');
