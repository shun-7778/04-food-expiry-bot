/**
 * スタンプラリーの画面（web.html）と、画面から呼ぶ API。
 *
 * LINE の webhook と同じデプロイの GET 側を使う。URL の ?k= のトークンが合う人にだけ画面を出す。
 * ⚠ この URL 自体が鍵になる。人に転送しないこと。漏れたら rotateWebToken() → setupRichMenu()。
 */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!webTokenOk_(p.k || '')) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">リンクが正しくありません。LINE のメニューから開き直してください。</p>');
  }
  var page = HtmlService.createTemplateFromFile('web');
  page.token = p.k;
  page.tab = webTab_(p.tab);
  return page.evaluate()
    .setTitle("Let's Go Mt.Fuji！！")
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    // GitHub Pages の枠ページ（docs/gym/）から埋め込めるようにする。埋め込みにもトークンが要る
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** 最初に開くタブ。知らない値は「週1スタンプ」に倒す */
function webTab_(tab) { return String(tab || '') === 'coin' ? 'coin' : 'stamp'; }

// ---------------------------------------------------------------- 公開URL

/**
 * 公開URL（/exec）。
 * GASエディタから実行すると ScriptApp.getService().getUrl() が /dev を返すことがあり、
 * それをメニューに焼くと外から開けない。そこで次の順で決める。
 *   1. スクリプトプロパティ WEB_EXEC_URL（デプロイ時に表示された URL を貼る）
 *   2. webhook を受けたときに見えた本物の /exec（rememberExecUrl_ が控える）
 */
var PROP_EXEC_URL = 'WEB_EXEC_URL';
var EXEC_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

function execUrl_() {
  return prop_(PROP_EXEC_URL) || ScriptApp.getService().getUrl() || '';
}

function rememberExecUrl_() {
  try {
    var url = ScriptApp.getService().getUrl() || '';
    if (!EXEC_URL_PATTERN.test(url) || prop_(PROP_EXEC_URL) === url) return;
    PropertiesService.getScriptProperties().setProperty(PROP_EXEC_URL, url);
    PROP_CACHE_ = null;
    console.log('公開URLを控えました: ' + url);
  } catch (err) {
    console.warn('公開URLの記録に失敗: ' + err.message);
  }
}

function assertExecUrl_() {
  var url = execUrl_();
  if (!EXEC_URL_PATTERN.test(url)) {
    throw new Error('公開URL(/exec)が分かりません（今は ' + (url || '空') + '）。\n'
      + 'デプロイしたときに表示された「ウェブアプリの URL」を、スクリプトプロパティ WEB_EXEC_URL に貼ってください。');
  }
  return url;
}
/** Webhook URL を作るとき用。/exec が分かるまでは止める */
function assertExecUrlOrService_() { return assertExecUrl_(); }

/**
 * 画面を包む枠ページ（GitHub Pages）。Apps Script を直接開くと上に Google の注意バーが出るので、
 * それを避けるために挟む。スクリプトプロパティ WEB_FRAME_URL に枠ページの URL を入れたときだけ使う。
 * 例: https://shun-7778.github.io/04-food-expiry-bot/gym/
 */
function webUrl_(tab) {
  var frame = prop_('WEB_FRAME_URL');
  var exec = assertExecUrl_();
  if (frame) return frame + '?u=' + encodeURIComponent(exec) + '&k=' + webToken_() + '&tab=' + webTab_(tab);
  return exec + '?k=' + webToken_() + '&tab=' + webTab_(tab);
}

/** GASエディタから実行するとURLがログに出る */
function showWebUrl() {
  console.log('スタンプラリー: ' + webUrl_('stamp'));
  console.log('コイン  : ' + webUrl_('coin'));
  return webUrl_('stamp');
}

// ---------------------------------------------------------------- 画面が呼ぶ API
// どれも { state, event } を返す。決まりに合わない操作は例外になり、画面がその文言を出す。

function webAssert_(token) {
  if (!webTokenOk_(token)) throw new Error('リンクが正しくありません。LINE のメニューから開き直してください。');
}

function webState(token) {
  webAssert_(token);
  return { state: currentState_(), event: null };
}

function webStamp(token) {
  webAssert_(token);
  return webActAndNotify_(gymPlanStamp_);
}

function webUseCoin(token) {
  webAssert_(token);
  return webActAndNotify_(gymPlanUseCoin_);
}

function webEarnCoin(token) {
  webAssert_(token);
  return webActAndNotify_(gymPlanEarnCoin_);
}

function webExchange(token) {
  webAssert_(token);
  return webActAndNotify_(gymPlanExchange_);
}

/** ご褒美の箱を開ける前に×で閉じた（押し間違い）。通知はまだ送っていないので、取り消すだけ */
function webCancel(token, id) {
  webAssert_(token);
  return act_(function (st, today, rand, rows) { return gymPlanCancel_(rows, id); });
}

/** 一番下の「最後のスタンプ／コインを1つ消す」 */
function webErase(token, tab) {
  webAssert_(token);
  return act_(function (st) { return gymPlanErase_(st, tab === 'coin' ? 'coin' : 'stamp'); });
}

/**
 * 記録して、LINE に知らせる。
 * ご褒美のマスと交換は、本人が箱を開けたあと（webOpened）に知らせる。
 * 開ける前に×で取り消されたとき、夫に「止まりました」と送ってしまわないように。
 */
function webActAndNotify_(plan) {
  var res = act_(plan);
  if (res.event.type !== 'special' && res.event.type !== 'exchange') notifyAfter_(res.event, res.state, null);
  return res;
}

/** ご褒美の箱を開けた。ここで初めて LINE に知らせる */
function webOpened(token, id) {
  webAssert_(token);
  var st = currentState_();
  var sq = st.squares.filter(function (s) { return s.id === Number(id); })[0];
  if (sq && sq.special) {
    notifyAfter_({ type: 'special', n: sq.n, viaCoin: sq.paid }, st, null);
  } else if (st.exchanges.some(function (x) { return x.id === Number(id); })) {
    notifyAfter_({ type: 'exchange', name: GYM_COIN_REWARD }, st, null);
  }
  return { state: st, event: null };
}
