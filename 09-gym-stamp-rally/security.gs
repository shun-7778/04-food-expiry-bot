/**
 * 認証まわり（04-food-expiry と同じ方式）。
 *
 * この Web アプリは LINE の webhook を受けるため「全員がアクセス可能」で公開するしかない。
 * そこで、
 *   - POST（webhook）は URL のクエリ ?s= に置いた合言葉で本物かを判定する
 *   - GET（スタンプラリーの画面）は URL のクエリ ?k= に置いたトークンで判定する
 * という二本立てにしている。どちらもスクリプトプロパティに独立して持つので、片方だけを作り直せる。
 *
 * GAS の doPost は HTTP ヘッダーを受け取れず、LINE の署名（X-Line-Signature）を検証できない。
 * 本文の source.userId は送信者が自由に書ける値なので、許可した人の判定は二枚目の壁として併用する。
 */

var PROP_WEBHOOK_SECRET = 'WEBHOOK_SECRET';
var PROP_WEB_TOKEN = 'WEB_ACCESS_TOKEN';
var SECRET_HEX_LEN = 32;   // 128bit 相当

function newSecret_() {
  var seed = Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + new Date().getTime();
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('').substring(0, SECRET_HEX_LEN);
}

/** 秘密を読む。無ければ作って保存する（create=true のときだけ） */
function secret_(key, create) {
  var props = PropertiesService.getScriptProperties();
  var v = props.getProperty(key);
  if (v) return v;
  if (!create) return '';
  v = newSecret_();
  props.setProperty(key, v);
  PROP_CACHE_ = null;
  return v;
}

/** 一致した文字数で時間が変わらない比較 */
function secretEquals_(a, b) {
  var x = String(a || ''), y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  var diff = 0;
  for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------- 管理用の関数を守る
// 名前が _ で終わらない関数は、公開中の画面（トークンが違うときの案内ページも含む）から
// google.script.run で誰でも呼べてしまう。そこで管理用の関数は GAS エディタから実行したときだけ動かし、
// 声かけは本物のトリガーから呼ばれたときだけ動かす。

/** GAS エディタからスクリプトの持ち主が実行しているか（匿名の画面から呼ばれると、ここは空になる） */
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

function webhookSecret_() { return secret_(PROP_WEBHOOK_SECRET, false); }

/** 本物の webhook か。合言葉が未設定のあいだは通す（LINE 側の URL を貼り替えるまでの移行期間） */
function webhookRequestOk_(e) {
  var expected = webhookSecret_();
  if (!expected) {
    console.warn('WEBHOOK_SECRET が未設定です。setupWebhookSecret() を実行し、LINE の Webhook URL を貼り替えてください');
    return true;
  }
  return secretEquals_((e && e.parameter && e.parameter.s) || '', expected);
}

/** 合言葉を作り、LINE に登録する Webhook URL をログに出す。GASエディタから実行する */
function setupWebhookSecret() {
  requireEditor_();
  var url = assertExecUrlOrService_() + '?s=' + secret_(PROP_WEBHOOK_SECRET, true);
  console.log('LINE Developers Console の Webhook URL にこれを設定してください:');
  console.log(url);
  return url;
}

/** 合言葉を作り直す。実行した瞬間に古い URL は無効になるので、すぐ LINE 側を貼り替えること */
function rotateWebhookSecret() {
  requireEditor_();
  PropertiesService.getScriptProperties().deleteProperty(PROP_WEBHOOK_SECRET);
  PROP_CACHE_ = null;
  return setupWebhookSecret();
}

// ---------------------------------------------------------------- 画面（GET）

function webToken_() { return secret_(PROP_WEB_TOKEN, true); }
function webTokenOk_(token) { return secretEquals_(token, webToken_()); }

/**
 * 画面のトークンを作り直す。URL が漏れた疑いがあるときに使う。
 * 実行後は setupRichMenu() も実行し直す（メニューに古いURLが焼き込まれているため）。
 */
function rotateWebToken() {
  requireEditor_();
  PropertiesService.getScriptProperties().deleteProperty(PROP_WEB_TOKEN);
  PROP_CACHE_ = null;
  return showWebUrl();
}
