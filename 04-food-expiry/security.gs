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
var PROP_WEB_TOKEN = 'WEB_ACCESS_TOKEN';

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
 * 空のあいだは検証が素通りになる（LINE の URL を貼り替えるまでの移行期間）。
 */
function webhookSecret_() {
  return secret_(PROP_WEBHOOK_SECRET, false);
}

/**
 * この POST が本物の webhook かを判定する。
 * 秘密が未設定のあいだは true（従来どおり動く）。ログに警告だけ出す。
 */
function webhookRequestOk_(e) {
  var expected = webhookSecret_();
  if (!expected) {
    console.warn('WEBHOOK_SECRET が未設定です。setupWebhookSecret() を実行し、'
      + 'LINE の Webhook URL を貼り替えてください（現在は誰でも POST できます）');
    return true;
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
 * ブラウザ画面の URL に付けるトークン。初回に作って保存する。
 * 以前はチャネルアクセストークンから毎回ハッシュで作っていたが、
 * チャネル側を再発行すると画面が無音で開かなくなり、逆に画面 URL が漏れても
 * 単独では作り直せなかったため、独立したプロパティに分けた。
 */
function webToken_() {
  return secret_(PROP_WEB_TOKEN, true);
}

function webTokenOk_(token) {
  return secretEquals_(token, webToken_());
}

/**
 * 画面トークンを作り直す。URL が漏れた疑いがあるときに使う。
 * 実行後は LINE に「リンク」と送れば新しい URL が返る。
 */
function rotateWebToken() {
  requireEditor_();
  PropertiesService.getScriptProperties().deleteProperty(PROP_WEB_TOKEN);
  PROP_CACHE_ = null;
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
