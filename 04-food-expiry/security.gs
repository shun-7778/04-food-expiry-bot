/**
 * 認証まわりの共通処理。
 *
 * この Web アプリは LINE の webhook を受けるため「全員がアクセス可能」で公開する
 * しかない。つまり /exec の URL を知っている人は誰でも POST / GET できる。
 * そこで、
 *   - POST（webhook）は URL のクエリ ?s= に置いた秘密で本物かを判定する
 *   - GET（ブラウザ画面）は URL のクエリ ?k= に置いたトークンで判定する
 * という二本立てにしている。どちらの秘密もスクリプトプロパティに独立して持つので、
 * 片方だけを作り直せる（チャネルアクセストークンとは無関係になった）。
 *
 * なぜ LINE の署名（X-Line-Signature）を検証しないのか:
 * Apps Script の doPost(e) は HTTP ヘッダーを受け取れず、署名が読めないため。
 * リクエスト本文の source.userId は送信者が自由に書ける値なので、これ単独では
 * 認証にならない（ALLOWED_USER_ID による判定は多重防御として残してある）。
 */

var PROP_WEBHOOK_SECRET = 'WEBHOOK_SECRET';
// 画面のトークンは人ごとに WEB_TOKENS へ移した（下の「画面（GET）」）。
// 前の共通トークン WEB_ACCESS_TOKEN はもう読まない

/** URL に置く秘密の長さ（16進）。128bit 相当 */
var SECRET_HEX_LEN = 32;

// ---------------------------------------------------------------- 秘密の生成・取得

/**
 * 推測されない 16進文字列を作る。
 * Apps Script には乱数バイト列の API がないので、UUID（v4）を複数つないだものを
 * ハッシュして使う。
 */
function newSecret_() {
  var seed = Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + Utilities.getUuid()
    + '|' + new Date().getTime();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  var hex = bytes.map(function (b) {
    return ('0' + (b & 0xFF).toString(16)).slice(-2);
  }).join('');
  return hex.substring(0, SECRET_HEX_LEN);
}

/**
 * スクリプトプロパティの秘密を読む。無ければ作って保存する（create=true のときだけ）。
 * webhook 用は「勝手に作らない」ことが大事なので create=false で呼ぶ。
 * 先に秘密ができてしまうと、LINE 側の URL を貼り替えるまでの間、本物の webhook まで
 * 弾いてしまうため。
 */
function secret_(key, create) {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty(key);
  if (v) return v;
  if (!create) return '';

  v = newSecret_();
  props.setProperty(key, v);
  PROP_CACHE_ = null; // まとめ読みのキャッシュを捨てて、次回読み直させる
  return v;
}

/** 長さと中身が同じかを、一致した文字数に左右されない形で比べる */
function secretEquals_(a, b) {
  var x = String(a || '');
  var y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;

  var diff = 0;
  for (var i = 0; i < x.length; i++) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return diff === 0;
}

// ---------------------------------------------------------------- 管理用の関数を守る

/**
 * 名前が _ で終わらない関数は、公開中の画面（トークン違いの案内ページも含む）から
 * google.script.run で誰でも呼べてしまう。以前は showWebUrl() から画面のトークンが取れた。
 * そこで管理用の関数は GAS エディタから持ち主が実行したときだけ動かし、
 * 週1の通知は本物のトリガーから呼ばれたときだけ動かす。
 * 画面から呼ばれてよいのは web〜 の API（中で webAssert_ を通す）だけ。関数を足すときは注意。
 */
function isEditor_() {
  try {
    var me = Session.getActiveUser().getEmail();
    return !!me && me === Session.getEffectiveUser().getEmail();
  } catch (err) {
    return false;
  }
}
function requireEditor_() {
  if (!isEditor_()) throw new Error('この操作は GAS エディタからだけ実行できます。');
}

/** このプロジェクトに登録されているトリガーから呼ばれたか（triggerUid は外からは分からない） */
function isOwnTrigger_(e) {
  var uid = e && e.triggerUid;
  if (!uid) return false;
  return ScriptApp.getProjectTriggers().some(function (t) { return String(t.getUniqueId()) === String(uid); });
}

// ---------------------------------------------------------------- webhook（POST）

/**
 * webhook の URL に付ける秘密。まだ作っていなければ空文字を返す。
 * 勝手には作らない（作ると、LINE 側の URL を貼り替えるまで本物の webhook まで弾くため）。
 */
function webhookSecret_() {
  return secret_(PROP_WEBHOOK_SECRET, false);
}

/**
 * この POST が本物の webhook かを判定する。
 * 秘密が未設定なら誰の POST も通さない。以前は移行のために素通りさせていたが、
 * プロパティが消えたり新しい環境に移したりしたときに、気づかないまま
 * 「誰でも POST できる」状態になるのを避けるため、閉じる側に倒した。
 * 未設定のときは Bot が反応しなくなるので、setupWebhookSecret() を実行して LINE 側を貼り替える。
 */
function webhookRequestOk_(e) {
  var expected = webhookSecret_();
  if (!expected) {
    console.error('WEBHOOK_SECRET が未設定のため、webhook をすべて無視しています。'
      + 'GAS エディタで setupWebhookSecret() を実行し、LINE の Webhook URL を貼り替えてください。');
    return false;
  }
  return secretEquals_((e && e.parameter && e.parameter.s) || '', expected);
}

/**
 * GAS エディタから実行する初期設定。
 * 秘密を作り（既にあればそのまま）、LINE に登録すべき Webhook URL をログに出す。
 * 出た URL を LINE Developers Console の Webhook URL に貼り替えること。
 */
function setupWebhookSecret() {
  requireEditor_();
  var url = ScriptApp.getService().getUrl() + '?s=' + secret_(PROP_WEBHOOK_SECRET, true);
  console.log('LINE Developers Console の Webhook URL にこれを設定してください:');
  console.log(url);
  return url;
}

/**
 * 秘密を作り直す。漏れた疑いがあるときに使う。
 * 実行した瞬間から古い URL は無効になるので、すぐ LINE 側を貼り替えること。
 */
function rotateWebhookSecret() {
  requireEditor_();
  PropertiesService.getScriptProperties().deleteProperty(PROP_WEBHOOK_SECRET);
  PROP_CACHE_ = null;
  return setupWebhookSecret();
}

// ---------------------------------------------------------------- 画面（GET）

/**
 * ブラウザ画面の URL に付けるトークン。人（LINE userId）ごとに1つずつ持ち、期限で入れ替える。
 *
 * 以前は全員共通・無期限の1本（WEB_ACCESS_TOKEN）だった。URL がトーク履歴やスクショから
 * 漏れると、気づくまでずっと在庫と買い物リストを書き換えられてしまうため、
 *   - 人ごとに分ける（誰の操作かがトークンで決まり、「あなた」を偽れない）
 *   - 発行から WEB_TOKEN_ROTATE_DAYS 日で入れ替え、WEB_TOKEN_MAX_DAYS 日で必ず失効させる
 *   - 入れ替え後も WEB_TOKEN_GRACE_DAYS 日は古いほうも通す（開きっぱなしの画面が急に止まらないように）
 * という形にした。入れ替えると、URL を焼き込んだリッチメニューもその人の分だけ作り直す
 * （refreshWebAccess_）。入れ替えは毎日の定時処理と、LINE で話しかけたときの両方で行う。
 *
 * 置き場はスクリプトプロパティ WEB_TOKENS に JSON で
 *   { userId: { cur, curAt, prev, prevUntil, menu } }
 * menu はリッチメニューに焼き込んだトークン。cur と違えばメニューが古いので作り直す。
 */
var PROP_WEB_TOKENS = 'WEB_TOKENS';
var WEB_TOKEN_ROTATE_DAYS = 23;   // これを過ぎたら入れ替える（毎日見るので、ほぼこの日に替わる）
var WEB_TOKEN_MAX_DAYS = 30;      // 入れ替えが止まっていても、これを過ぎたら使えない
var WEB_TOKEN_GRACE_DAYS = 7;     // 入れ替えた後も、古いトークンを通す日数（ROTATE + GRACE ≦ MAX にしておく）
var DAY_MS = 24 * 60 * 60 * 1000;

function webTokens_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP_WEB_TOKENS) || '{}') || {};
  } catch (err) {
    console.warn('WEB_TOKENS を読めません: ' + err.message);
    return {};
  }
}

function saveWebTokens_(all) {
  PropertiesService.getScriptProperties().setProperty(PROP_WEB_TOKENS, JSON.stringify(all));
  PROP_CACHE_ = null;
}

/** トークンの持ち主の userId。期限切れ・許可から外した人・該当なしは空文字 */
function webTokenUser_(token) {
  var t = String(token || '');
  if (!t) return '';

  var now = Date.now();
  var allowed = allowedUserIds_();
  var all = webTokens_();
  var hit = '';
  // 一致した時点で抜けず、全員分を同じだけ比べる（どこで当たったかを時間で悟らせない）
  Object.keys(all).forEach(function (uid) {
    var e = all[uid] || {};
    if (allowed.indexOf(uid) < 0) return;   // ALLOWED_USER_IDS から外した人のトークンは効かない
    if (e.cur && now - Number(e.curAt || 0) < WEB_TOKEN_MAX_DAYS * DAY_MS && secretEquals_(t, e.cur)) hit = uid;
    if (e.prev && now < Number(e.prevUntil || 0) && secretEquals_(t, e.prev)) hit = uid;
  });
  return hit;
}

function webTokenOk_(token) {
  return !!webTokenUser_(token);
}

/**
 * 今相手をしている人（CURRENT_USER_）の、使えるトークン。無いか期限切れなら作る。
 * URL を組み立てるときに呼ぶので、誰の URL か分からない呼び方は止める
 * （共通のトークンに戻ってしまわないように）。
 */
function webToken_() {
  if (!CURRENT_USER_) {
    throw new Error('誰の画面URLかが分かりません。LINE からの操作か、withUser_ の中で呼んでください。');
  }
  var e = webTokens_()[CURRENT_USER_];
  if (e && e.cur && Date.now() - Number(e.curAt || 0) < WEB_TOKEN_MAX_DAYS * DAY_MS) return e.cur;
  return rotateUserWebToken_(CURRENT_USER_, false);
}

/**
 * その人のトークンを新しくする。keepOld=true なら古いほうを猶予つきで残す（定期の入れ替え）。
 * false なら古いほうは即座に使えなくする（漏れた疑いがあるとき・期限切れのとき）。
 */
function rotateUserWebToken_(uid, keepOld) {
  return withLock_(function () {
    var all = webTokens_();
    var e = all[uid] || {};
    var now = Date.now();
    var alive = e.cur && now - Number(e.curAt || 0) < WEB_TOKEN_MAX_DAYS * DAY_MS;

    all[uid] = {
      cur: newSecret_(),
      curAt: now,
      prev: keepOld && alive ? e.cur : '',
      prevUntil: keepOld && alive
        ? Math.min(now + WEB_TOKEN_GRACE_DAYS * DAY_MS, Number(e.curAt) + WEB_TOKEN_MAX_DAYS * DAY_MS)
        : 0,
      menu: e.menu || ''
    };
    saveWebTokens_(all);
    return all[uid].cur;
  });
}

/** リッチメニューに焼き込んだトークンを控える（createUserRichMenus_ から呼ぶ） */
function markMenuWebToken_(uid, token) {
  withLock_(function () {
    var all = webTokens_();
    if (!all[uid]) return;
    all[uid].menu = token;
    saveWebTokens_(all);
  });
}

/**
 * 期限が来ていればトークンを入れ替え、メニューが古ければその人の分を作り直す。
 * force=true は漏れた疑いがあるとき用で、古いトークンを猶予なしで止める。
 * 作り直したら true。毎日の定時処理と、doPost の最後（返信の後）から呼ぶ。
 */
function refreshWebAccess_(uid, force) {
  if (!uid) return false;
  return withLock_(function () {
    return withUser_(uid, function () {
      var e = webTokens_()[uid] || {};
      var age = e.cur ? Date.now() - Number(e.curAt || 0) : Infinity;
      if (force || age >= WEB_TOKEN_ROTATE_DAYS * DAY_MS) rotateUserWebToken_(uid, !force);

      e = webTokens_()[uid] || {};
      if (e.cur && e.menu === e.cur) return false;   // メニューは今のトークンのまま
      replaceUserRichMenus_(uid);                   // 中で webToken_() を使い、焼き込んだ分を控える
      return true;
    });
  });
}

/** LINE から話しかけた人の分を、返信を済ませた後で整える。失敗しても webhook は止めない */
function refreshWebAccessAfterReply_(events) {
  var seen = {};
  (events || []).forEach(function (ev) {
    var uid = ev && ev.source && ev.source.userId;
    if (!uid || seen[uid] || !isAllowedSender_(ev)) return;
    seen[uid] = true;
    try {
      if (refreshWebAccess_(uid, false)) console.log('画面のトークンとメニューを更新しました: ' + uid);
    } catch (err) {
      console.error('画面のトークン更新に失敗: ' + err.stack);
    }
  });
}

/**
 * 毎日の定時処理。全員分のトークンの期限を見て、来ていれば入れ替える。
 * トリガーは setupWebTokens()（または setupWebTokenTrigger()）で張る。
 */
function refreshWebTokensDaily(e) {
  if (!isOwnTrigger_(e) && !isEditor_()) throw new Error('この処理はトリガーか GAS エディタからだけ実行できます。');
  allowedUserIds_().forEach(function (uid) {
    try {
      if (refreshWebAccess_(uid, false)) console.log('更新しました: ' + uid);
    } catch (err) {
      console.error('更新に失敗(' + uid + '): ' + err.stack);
    }
  });
}

/** 毎日4時台に refreshWebTokensDaily を動かすトリガーを張る。同じ関数の古いトリガーは張り替える */
function setupWebTokenTrigger() {
  requireEditor_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'refreshWebTokensDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshWebTokensDaily').timeBased().everyDays(1).atHour(4).create();
  console.log('毎日4時台に refreshWebTokensDaily を実行するトリガーを設定しました');
}

/**
 * 人ごとのトークンへの切り替え。GAS エディタから1回だけ実行する。
 * トリガーを張り、全員分のトークンを作ってリッチメニューを作り直す。
 * 実行した時点で、前の共通トークン（WEB_ACCESS_TOKEN）入りの URL は開けなくなる。
 */
function setupWebTokens() {
  requireEditor_();
  setupWebTokenTrigger();
  setupRichMenu();
  showWebUrl();
}

/**
 * 全員のトークンを猶予なしで作り直し、メニューも作り直す。URL が漏れた疑いがあるときに使う。
 * 実行後は、メニューから開くか LINE に「リンク」と送れば新しい URL で開ける。
 */
function rotateWebToken() {
  requireEditor_();
  allowedUserIds_().forEach(function (uid) { refreshWebAccess_(uid, true); });
  return showWebUrl();
}

// ---------------------------------------------------------------- 呼び出し回数の上限

/**
 * Claude を呼ぶ回数の上限。秘密が万一漏れたときに、課金が青天井にならないようにする。
 * ふだんの使い方（写真を数枚、テキストを何度か）では当たらない値にしてある。
 */
// 上限はスクリプト全体で1つ（人ごとではない）。使う人が増えるぶん余裕を持たせてある
var CLAUDE_LIMIT_PER_MIN = 20;
var CLAUDE_LIMIT_PER_HOUR = 120;

var RATE_LIMIT_MESSAGE = '短い時間に使いすぎたため、少し待ってから試してください。';

/**
 * 期間ごとの呼び出し回数を数え、上限を超えていたら false を返す。
 * CacheService は期限付きで消えるので、カウンタを自分で消す必要がない。
 * 厳密な原子性はない（同時実行で数個ぶん多く通ることがある）が、
 * 目的は暴走を止めることなのでこれで足りる。
 */
function rateLimitOk_(name, limit, windowSeconds) {
  var cache = CacheService.getScriptCache();
  var slot = Math.floor(new Date().getTime() / (windowSeconds * 1000));
  var key = 'rl:' + name + ':' + windowSeconds + ':' + slot;

  var count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), windowSeconds + 10);

  if (count > limit) {
    console.warn('呼び出し上限を超えました: ' + key + ' = ' + count + ' (上限 ' + limit + ')');
    return false;
  }
  return true;
}

/** Claude を呼ぶ直前に通す。超えていたら例外を投げ、呼び出し元が利用者に伝える */
function assertClaudeRate_() {
  if (!rateLimitOk_('claude', CLAUDE_LIMIT_PER_MIN, 60)
    || !rateLimitOk_('claude', CLAUDE_LIMIT_PER_HOUR, 3600)) {
    throw new Error(RATE_LIMIT_MESSAGE);
  }
}
