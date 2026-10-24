/**
 * ジムスタンプラリー（Let's Go Mt.Fuji！！）の LINE Bot 本体。
 *
 * - スタンプラリーの決まり（週1回まで・コインなど）は logic.gs
 * - 画面（スタンプラリー）と、画面から呼ぶ API は webapp.gs / web.html
 * - Webhook の合言葉と画面のトークンは security.gs
 *
 * 記録はスプレッドシート「ジムスタンプラリー」の「記録」シートに1行ずつ残す。行は消さない。
 *
 * スクリプトプロパティ:
 *   LINE_CHANNEL_ACCESS_TOKEN  … LINE のチャネルアクセストークン（長期）
 *   PLAYER_USER_ID             … スタンプラリーをする人（妻）の userId。声かけ・ほめる言葉の送り先
 *   WATCHER_USER_IDS           … お知らせを受け取る人（夫）の userId。カンマ区切りで複数可・空でもよい
 *   SPREADSHEET_ID             … setupSpreadsheet() が自動で入れる
 */

var PROP_CACHE_ = null;

function prop_(key, required) {
  if (!PROP_CACHE_) PROP_CACHE_ = PropertiesService.getScriptProperties().getProperties();
  var v = PROP_CACHE_[key];
  if (required && !v) throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  return v || '';
}

var TZ = 'Asia/Tokyo';
function todayYmd_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function mdw_(ymd) {
  var p = ymd.split('-');
  return Number(p[1]) + '/' + Number(p[2]) + '（' + '日月火水木金土'.charAt(gymWeekday_(ymd)) + '）';
}

// ---------------------------------------------------------------- 利用者

function playerId_() { return String(prop_('PLAYER_USER_ID') || '').trim(); }
function watcherIds_() {
  return String(prop_('WATCHER_USER_IDS') || '').split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s && s !== playerId_(); });
}
/** Bot を使ってよい人（スタンプラリーをする人＋お知らせを受け取る人） */
function allowedUserIds_() {
  return [playerId_()].concat(watcherIds_()).filter(Boolean);
}
function isAllowedSender_(event) {
  var id = event && event.source && event.source.userId;
  return !!id && allowedUserIds_().indexOf(id) >= 0;
}

// ---------------------------------------------------------------- 記録シート

var SHEET_NAME = '記録';
var COLS = ['ID', '登録日時', '種類', '日付', 'スタンプ', '角度', '見出し', 'ことば', '状態', '更新日時'];
var COL = { ID: 1, CREATED: 2, TYPE: 3, DATE: 4, KIND: 5, R: 6, TITLE: 7, TEXT: 8, STATUS: 9, UPDATED: 10 };

/**
 * 記録先のスプレッドシートを作る。GASエディタから1回だけ実行する。
 * すでに SPREADSHEET_ID があれば（ドライブで作って ID を入れた場合も）作り直さず、シートを整えるだけ。
 */
function setupSpreadsheet() {
  var id = prop_('SPREADSHEET_ID');
  if (id) {
    sheet_();
    console.log('設定済みです: ' + SpreadsheetApp.openById(id).getUrl());
    return;
  }
  var ss = SpreadsheetApp.create('ジムスタンプラリー');
  prepareSheet_(ss.getSheets()[0]);
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  PROP_CACHE_ = null;
  console.log('作成しました: ' + ss.getUrl());
}

/**
 * シートを「記録」として使えるように整える（名前・見出し・日付列の書式）。
 * ドライブで先にスプレッドシートを作り、SPREADSHEET_ID だけ入れた場合も、初回の読み書きでここを通る。
 */
function prepareSheet_(sh) {
  sh.setName(SHEET_NAME);
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // 日付を文字のまま持つ（シートが勝手に日付型に変えないように）
  sh.getRange('D:D').setNumberFormat('@');
  return sh;
}

function sheet_() {
  var ss = SpreadsheetApp.openById(prop_('SPREADSHEET_ID', true));
  var sh = ss.getSheetByName(SHEET_NAME);
  // 「記録」が無ければ、まだ何も書いていない先頭のシートを整えて使う
  if (!sh) {
    var first = ss.getSheets()[0];
    if (first.getLastRow() > 1) throw new Error('「' + SHEET_NAME + '」シートがありません。スプレッドシートを確認してください。');
    sh = prepareSheet_(first);
  }
  return sh;
}

function cellYmd_(v) {
  return v instanceof Date ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : String(v || '');
}

/** 全行を読む（取消の行も含む。状態の計算で除く） */
function readRows_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, COLS.length).getValues()
    .filter(function (r) { return r[COL.ID - 1] !== ''; })
    .map(function (r) {
      return {
        id: Number(r[COL.ID - 1]), type: String(r[COL.TYPE - 1]), date: cellYmd_(r[COL.DATE - 1]),
        kind: String(r[COL.KIND - 1] || ''), r: Number(r[COL.R - 1]) || 0,
        title: String(r[COL.TITLE - 1] || ''), text: String(r[COL.TEXT - 1] || ''),
        status: String(r[COL.STATUS - 1] || GYM_ACTIVE)
      };
    });
}

function nowStamp_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'); }

function appendRow_(rows, rec) {
  var id = rows.reduce(function (m, x) { return Math.max(m, x.id); }, 0) + 1;
  sheet_().appendRow([id, nowStamp_(), rec.type, rec.date, rec.kind || '', rec.r || 0, rec.title || '', rec.text || '', GYM_ACTIVE, '']);
  return id;
}

function updateRow_(id, patch) {
  var sh = sheet_();
  var ids = sh.getRange(2, COL.ID, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (Number(ids[i][0]) !== Number(id)) continue;
    var row = i + 2;
    if (patch.type) sh.getRange(row, COL.TYPE).setValue(patch.type);
    if (patch.date) sh.getRange(row, COL.DATE).setValue(patch.date);
    if (patch.title !== undefined) sh.getRange(row, COL.TITLE).setValue(patch.title);
    if (patch.text !== undefined) sh.getRange(row, COL.TEXT).setValue(patch.text);
    if (patch.status) sh.getRange(row, COL.STATUS).setValue(patch.status);
    sh.getRange(row, COL.UPDATED).setValue(nowStamp_());
    return;
  }
  throw new Error('記録が見つかりません（ID ' + id + '）');
}

/** いまの状態 */
function currentState_() { return gymState_(readRows_(), todayYmd_()); }

/**
 * 操作を1つ実行する。読む → 決まりで判定 → 書く を、錠をかけて一続きで行う。
 * 2台から同時に押されても、同じ週に2回押せたりしないように。
 * plan(state, today, rand, rows) は logic.gs の gymPlan*_（またはそれを呼ぶ関数）。
 */
function act_(plan) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('ほかの操作の途中です。少し待ってからもう一度試してください。');
  var result;
  try {
    var rows = readRows_(), today = todayYmd_();
    var p = plan(gymState_(rows, today), today, Math.random, rows);
    if (p.error) throw new Error(p.error);
    if (p.append) p.event.id = appendRow_(rows, p.append);
    if (p.update) updateRow_(p.update.id, p.update.patch);
    result = { state: gymState_(readRows_(), today), event: p.event };
  } finally {
    lock.releaseLock();
  }
  return result;
}

// ---------------------------------------------------------------- 操作のあとの LINE

/**
 * 操作のあとに送るメッセージ。
 * replyToken があれば（LINE から操作したとき）返信で返す。返信は無料枠を使わない。
 * 画面から操作したときは push になる（月200通の無料枠を使う）。
 */
function notifyAfter_(event, state, replyToken) {
  var sq = event.n ? state.squares[event.n - 1] : null;
  var mine = [], theirs = '';
  var day = mdw_(state.today);

  switch (event.type) {
    case 'stamp':
      mine.push(event.title + event.text + '\n（' + event.n + 'マス目・あと' + (state.total - event.n) + 'マスで富士山）');
      theirs = day + 'にジムに行きました（' + event.n + 'マス目）。帰ってきたら「おつかれさま」のひとことを。';
      break;
    case 'special':
      // 中身は本人が画面で箱を開けて知る。通知のプレビューで先に見えないよう、本人には書かない
      mine.push((event.viaCoin ? 'コインで今週クリア！' : 'がんばったね！') + '\n' + event.n + 'マス目は'
        + gymKindLabel_(sq.special) + 'のマス。スタンプラリーの画面で箱を開けてね。');
      theirs = day + '、' + event.n + 'マス目の' + gymKindLabel_(sq.special) + 'に止まりました。中身は「' + sq.name + '」です。'
        + (sq.special === 'goal' ? '' : '準備をお願いします。');
      break;
    case 'convert':
      mine.push('やっぱり行けたね！スタンプに変えて、コインは1枚戻したよ。');
      theirs = day + '、コインで埋めていた週に結局ジムに行けました（' + event.n + 'マス目）。';
      break;
    case 'use':
      mine.push('コインで今週クリア！来週また行こう。（残り' + state.held + '枚）');
      theirs = day + '、今週はコインを使って' + event.n + 'マス目を埋めました（残り' + state.held + '枚）。';
      break;
    case 'coin':
      mine.push('コインゲット！' + event.text + '（手持ち' + state.held + '枚）'
        + (event.choice ? '\n5枚たまったので、ご褒美と交換できます。スタンプラリーの「コイン」から選んでね。' : ''));
      theirs = day + '、今週2回目以上のジムに行きました。コインは手持ち' + state.held + '枚です。';
      break;
    case 'exchange':
      theirs = day + '、コイン5枚を「' + event.name + '」と交換しました。作ってあげてください。';
      break;
  }

  var player = playerId_();
  var msgs = mine.map(function (t) { return { type: 'text', text: t }; });
  try {
    if (msgs.length) {
      if (replyToken) replyMessages_(replyToken, msgs);
      else if (player) sendPush_([player], msgs);
    }
    if (theirs && watcherIds_().length) sendPush_(watcherIds_(), [{ type: 'text', text: theirs }]);
  } catch (err) {
    // 記録はもう済んでいる。送れなかったことだけ残し、画面の操作は成功として返す
    console.error('LINE の送信に失敗: ' + err.message);
  }
}

// ---------------------------------------------------------------- 声かけ（時間トリガー）

var MIDWEEK_LINES = [
  '今週のジム、行けそう？',
  '今週まだみたい。週末に行けそう？',
  '水曜日。今週のスタンプ、まだ空いてるよ。'
];
var WEEKEND_LINES = [
  '今週ラストチャンス！今日行けそう？',
  '今週あと少し。30分だけでも行けたらスタンプ1つ。'
];

/** 水曜の夜：今週まだ行っていなければ声をかける */
function remindMidweek() {
  var st = currentState_();
  if (st.weekDone || !st.inPeriod || !playerId_()) { console.log('声かけ不要'); return; }
  var text = gymPick_(MIDWEEK_LINES, Math.random);
  if (st.next) text += '\n' + st.next.label + 'まであと' + (st.next.n - st.squares.length) + 'マス。';
  sendPush_([playerId_()], [{ type: 'text', text: text }]);
}

/** 日曜の夕方：まだ行っていなければ、コインがあれば使うかどうかも聞く */
function remindWeekend() {
  var st = currentState_();
  if (st.weekDone || !st.inPeriod || !playerId_()) { console.log('声かけ不要'); return; }
  var msg;
  if (st.held > 0) {
    msg = { type: 'text', text: '今週まだ行けてないね。今日行けそう？\n行けなかったら、コインを使って今週の分にする？（残り' + st.held + '枚）' };
    // その場でコインを使えるボタンだけ付ける（画面はメニューから開く）
    msg.quickReply = { items: [{
      type: 'action', action: { type: 'postback', label: 'コインを使う', data: 'use_coin', displayText: 'コインを使う' }
    }] };
  } else {
    msg = { type: 'text', text: gymPick_(WEEKEND_LINES, Math.random) };
  }
  sendPush_([playerId_()], [msg]);
}

/**
 * 声かけのトリガーを設定する。GASエディタから1回だけ実行する。
 * 同じ関数の古いトリガーがあれば張り替える。時刻は GAS の仕様で「その時台のどこか」になる。
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['remindMidweek', 'remindWeekend'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('remindMidweek').timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(20).create();
  ScriptApp.newTrigger('remindWeekend').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(17).create();
  console.log('水曜20時台と日曜17時台の声かけを設定しました');
}

// ---------------------------------------------------------------- Webhook

function doPost(e) {
  try {
    if (!webhookRequestOk_(e)) {
      console.warn('合言葉の合わない POST を無視しました');
      return webhookResponse_();
    }
    rememberExecUrl_();
    var events = (JSON.parse(e.postData.contents).events) || [];
    events.forEach(handleEvent_);
  } catch (err) {
    console.error('doPost failed: ' + err.stack);
  }
  return webhookResponse_();
}

/** webhook への返事は常に同じにする（受け付けたか弾いたかを区別させない） */
function webhookResponse_() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

function handleEvent_(event) {
  if (event.type !== 'message' && event.type !== 'postback') return;
  var text = event.type === 'message' && event.message && event.message.type === 'text' ? String(event.message.text || '').trim() : '';

  // 「id」だけは許可前でも答える。新しく使う人が自分の userId を知るため
  if (text.toLowerCase() === 'id') {
    replyMessages_(event.replyToken, [{ type: 'text', text: 'あなたの userId:\n' + (event.source && event.source.userId) }]);
    return;
  }
  if (!isAllowedSender_(event)) return;

  try {
    if (event.type === 'postback' && event.postback && event.postback.data === 'use_coin') {
      var res = act_(gymPlanUseCoin_);
      notifyAfter_(res.event, res.state, event.replyToken);
      return;
    }
    if (/^(リンク|スタンプラリー|スタンプ|開く)$/.test(text)) {
      replyMessages_(event.replyToken, [{ type: 'text', text: webUrl_('stamp') }]);
      return;
    }
    // メニューからは外したが、打って送れば進み具合を返す
    if (/^(状況|いま|今)$/.test(text)) {
      replyMessages_(event.replyToken, [{ type: 'text', text: statusText_(currentState_()) }]);
      return;
    }
    replyMessages_(event.replyToken, [{ type: 'text', text: 'ジムに行ったら、メニューの「スタンプラリー」からスタンプを押してね。' }]);
  } catch (err) {
    replyMessages_(event.replyToken, [{ type: 'text', text: err.message }]);
  }
}

function statusText_(st) {
  var lines = ['すすんだマス ' + st.squares.length + ' / ' + st.total];
  lines.push(st.weekDone ? '今週の分は押しました' : '今週はまだです');
  if (st.next) lines.push(st.next.label + 'まで あと' + (st.next.n - st.squares.length) + 'マス');
  lines.push('コイン 手持ち' + st.held + '枚' + (st.canExchange ? '（ご褒美と交換できます）' : ''));
  return lines.join('\n');
}

// ---------------------------------------------------------------- LINE API

function lineHeaders_() { return { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) }; }

function replyMessages_(replyToken, messages) {
  if (!replyToken || !messages.length) return;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json', headers: lineHeaders_(), muteHttpExceptions: true,
    payload: JSON.stringify({ replyToken: replyToken, messages: messages })
  });
  if (res.getResponseCode() !== 200) console.error('LINE reply 失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
}

/** push の実体。宛先が1人なら push、複数なら multicast */
function sendPush_(to, messages) {
  if (!to.length) return;
  var single = to.length === 1;
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/' + (single ? 'push' : 'multicast'), {
    method: 'post', contentType: 'application/json', headers: lineHeaders_(), muteHttpExceptions: true,
    payload: JSON.stringify(single ? { to: to[0], messages: messages } : { to: to, messages: messages })
  });
  if (res.getResponseCode() !== 200) throw new Error('LINE push 失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
}

/** LINE API の共通呼び出し。options.allow404 が true なら 404 を失敗と見なさない（既定メニューの解除など） */
function lineApi_(method, url, options) {
  var opt = Object.assign({}, options || {});
  var allow404 = !!opt.allow404;
  delete opt.allow404;
  var res = UrlFetchApp.fetch(url, Object.assign({ method: method, headers: lineHeaders_(), muteHttpExceptions: true }, opt));
  var code = res.getResponseCode();
  if (code !== 200 && !(allow404 && code === 404)) {
    throw new Error('LINE API 失敗 (HTTP ' + code + ') ' + url + '\n' + res.getContentText().substring(0, 300));
  }
  return res;
}

// ---------------------------------------------------------------- リッチメニュー

// 画像は 2500×1200（richmenu.html と揃える）。左に「スタンプラリー」、右に「コイン」
var RICHMENU_SIZE = { width: 2500, height: 1200 };

function buildRichMenu_() {
  var w = RICHMENU_SIZE.width / 2;
  return {
    size: RICHMENU_SIZE, selected: true, name: 'ジムスタンプラリーメニュー', chatBarText: 'メニュー',
    areas: [
      { bounds: { x: 0, y: 0, width: w, height: RICHMENU_SIZE.height }, action: { type: 'uri', label: 'スタンプラリー', uri: webUrl_('stamp') } },
      { bounds: { x: w, y: 0, width: w, height: RICHMENU_SIZE.height }, action: { type: 'uri', label: 'コイン', uri: webUrl_('coin') } }
    ]
  };
}

/**
 * リッチメニューを作り直して、使う人に割り当てる。GASエディタから実行する。
 * メニューには画面のトークン入りURLが入るので、全員の既定にはせず、許可した人にだけ貼る。
 */
function setupRichMenu() {
  console.log('公開URL: ' + assertExecUrl_());
  var users = allowedUserIds_();
  if (!users.length) throw new Error('PLAYER_USER_ID が未設定です。メニューには画面のURLが入るため、配る相手を決めてから作ります。');

  var old = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  (old.richmenus || []).forEach(function (m) {
    lineApi_('delete', 'https://api.line.me/v2/bot/richmenu/' + m.richMenuId);
    console.log('古いメニューを削除: ' + m.richMenuId);
  });

  var created = JSON.parse(lineApi_('post', 'https://api.line.me/v2/bot/richmenu', {
    contentType: 'application/json', payload: JSON.stringify(buildRichMenu_())
  }).getContentText());
  var png = Utilities.newBlob(Utilities.base64Decode(RICHMENU_IMAGE_BASE64), 'image/png', 'richmenu.png');
  lineApi_('post', 'https://api-data.line.me/v2/bot/richmenu/' + created.richMenuId + '/content', { contentType: 'image/png', payload: png.getBytes() });

  lineApi_('delete', 'https://api.line.me/v2/bot/user/all/richmenu', { allow404: true });
  users.forEach(function (uid) {
    lineApi_('post', 'https://api.line.me/v2/bot/user/' + encodeURIComponent(uid) + '/richmenu/' + created.richMenuId);
    console.log('割り当て: ' + uid);
  });
  console.log(users.length + '人に設定しました。トークを開き直すと出ます。');
}

function deleteRichMenus() {
  var list = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  (list.richmenus || []).forEach(function (m) {
    lineApi_('delete', 'https://api.line.me/v2/bot/richmenu/' + m.richMenuId);
    console.log('削除: ' + m.richMenuId);
  });
}

// ---------------------------------------------------------------- 確認用

/** 設定の確認。GASエディタから実行する。何も書き換えない */
function testConfig() {
  ['LINE_CHANNEL_ACCESS_TOKEN', 'PLAYER_USER_ID', 'WATCHER_USER_IDS', 'SPREADSHEET_ID'].forEach(function (k) {
    console.log(k + ': ' + (prop_(k) ? 'OK' : (k === 'WATCHER_USER_IDS' ? '未設定（お知らせを送らない）' : '*** 未設定 ***')));
  });
  if (prop_('SPREADSHEET_ID')) console.log(statusText_(currentState_()));
  console.log('Webhook の合言葉: ' + (webhookSecret_() ? '設定済み' : '*** 未設定（setupWebhookSecret を実行） ***'));
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', { headers: lineHeaders_(), muteHttpExceptions: true });
  console.log('LINE API: HTTP ' + res.getResponseCode() + (res.getResponseCode() === 200 ? ' OK ' + res.getContentText() : ''));
}
