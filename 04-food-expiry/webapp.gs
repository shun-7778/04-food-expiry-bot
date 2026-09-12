/**
 * ブラウザ用の画面（買い物リスト / 在庫）。
 *
 * LINE の webhook と同じデプロイの GET 側を使う。webhook は「全員がアクセス可能」で
 * ないと動かないため、URL の ?k= に秘密トークンを付けた人にだけ中身を見せる。
 * トークンの作り方と検証は security.gs（webToken_ / webTokenOk_）にある。
 *
 * ⚠ この画面は「URL を知っていること」だけが鍵になっている。
 * 画面からは在庫の消費・買い物リストの追加削除ができるので、URL は人に渡さないこと。
 * 漏れた疑いがあるときは GAS エディタで rotateWebToken() を実行すれば作り直せる。
 */

function doGet(e) {
  var token = (e && e.parameter && e.parameter.k) || '';

  if (!webTokenOk_(token)) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:24px">リンクが正しくありません。</p>');
  }

  var page = HtmlService.createTemplateFromFile('web');
  page.token = token;
  page.tab = webTab_(e && e.parameter && e.parameter.tab);
  return page.evaluate()
    .setTitle('食材管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    // 別のページから iframe で埋め込めるようにする（GAS の注意バーを避けたいとき用）。
    // HtmlService には埋め込み元を絞る指定がなく ALLOWALL しか選べないが、
    // 埋め込むには URL のトークンが要るので、トークンを渡していない相手には枠を作れない。
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * 公開URL（/exec）。
 *
 * ScriptApp.getService().getUrl() は、GASエディタから実行したときに
 * 「スクリプトIDの /dev」を返すことがある。これはデプロイIDの /exec とは別のURLで、
 * 外（LINEのリッチメニューや枠ページ）から開いても届かない。/dev を /exec に
 * 書き換えてもIDが違うので直らない。
 *
 * そこで webhook を受けたとき（＝本物の /exec で動いているとき）に見えたURLを
 * 控えておき、URLを組み立てるときはそれを優先して使う。
 * 古いデプロイの /exec を掴む事故も、これで避けられる。
 */
var PROP_EXEC_URL = 'WEB_EXEC_URL';
var EXEC_URL_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

function execUrl_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_EXEC_URL)
    || ScriptApp.getService().getUrl() || '';
}

/** doPost から呼ぶ。本物の /exec が見えたときだけ控える（変わったときだけ書く） */
function rememberExecUrl_() {
  try {
    var url = ScriptApp.getService().getUrl() || '';
    if (!EXEC_URL_PATTERN.test(url)) return;

    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(PROP_EXEC_URL) === url) return;
    props.setProperty(PROP_EXEC_URL, url);
    console.log('公開URLを控えました: ' + url);
  } catch (err) {
    console.warn('公開URLの記録に失敗: ' + err.message);
  }
}

/**
 * 外から開くURLを作る前に通す。まだ本物の /exec が分からないときは、
 * 黙って壊れたURLを配らずに、何をすればよいかを言って止める。
 */
function assertExecUrl_() {
  var url = execUrl_();
  if (!EXEC_URL_PATTERN.test(url)) {
    throw new Error('公開URL(/exec)がまだ分かりません（今は ' + (url || '空') + '）。\n'
      + 'LINE で Bot に何かメッセージを送ってから、もう一度実行してください。');
  }
  return url;
}

/**
 * 最初に開くタブ。リッチメニューの「買い物リスト表示」「在庫確認」から飛ぶときに使う。
 * 知らない値は既定（買い物）に倒す。画面側の switchTab に渡すので、
 * ここを通さずに生の値を埋め込まないこと。
 */
function webTab_(tab) {
  return String(tab || '') === 'stock' ? 'stock' : 'shop';
}

/**
 * 画面を包むページ（GitHub Pages）。
 * Apps Script の URL を直接開くと Google の注意バーが上に出るので、
 * 中身だけを枠に収めて見せるための1枚を挟んでいる。
 * 表示先の URL は公開リポジトリに置かず、ここからパラメータで渡す。
 */
var WEB_FRAME_URL = 'https://shun-7778.github.io/food-expiry-bot/';

/**
 * 画面のURL。LINE の「リンク」コマンドと、GASエディタからの確認で使う。
 * ⚠ この URL 自体が鍵なので、チャットやブックマークの共有で人に渡さないこと。
 */
function webUrl_(tab) {
  return WEB_FRAME_URL
    + '?u=' + encodeURIComponent(execUrl_())
    + '&k=' + webToken_()
    + '&tab=' + webTab_(tab);
}

/** 枠を使わず Apps Script を直接開くURL（注意バーは出る） */
function webDirectUrl_(tab) {
  return execUrl_() + '?k=' + webToken_() + '&tab=' + webTab_(tab);
}

/** GASエディタから実行するとURLがログに出る */
function showWebUrl() {
  console.log('買い物: ' + webUrl_('shop'));
  console.log('在庫  : ' + webUrl_('stock'));
  console.log('枠なし: ' + webDirectUrl_('shop'));
  return webUrl_('shop');
}

// ---------------------------------------------------------------- 画面が呼ぶAPI

/**
 * 画面の描画に要るものを全部まとめて返す。
 * 1操作ごとに読み直すので、シートの読みは1回にまとめてある。
 */
function webData(token) {
  webAssert_(token);
  // 今は1人で使う前提なので、トークンが合えば全行を見せている。
  // LINE と画面を紐付けて複数人で使うようにするときは、ここでトークンから利用者を引き、
  // その人の行だけを返すように絞ること（webSetShop などの書き込み側も同じ）。
  return { shop: webShopData_(), stock: webStockData_() };
}

/** 買い物リストのチェックを付け外しする。done=true で購入済、false で未購入に戻す */
function webSetShop(token, id, done) {
  webAssert_(token);

  var sh = shopSheet_();
  var row = webFindRow_(sh, SHOP_COL_COUNT, SHOP_COL.ID, id);
  if (row) {
    sh.getRange(row, SHOP_COL.STATUS, 1, 2)
      .setValues([[done ? SHOP_STATUS.DONE : SHOP_STATUS.TODO, nowStamp_()]]);
  }
  return webData(token);
}

/** 品名を買い物リストに足す。区分は空欄のまま（LINE と違い Claude は呼ばない） */
function webAddShop(token, name) {
  webAssert_(token);

  // 画面から来た文字はそのままシートへ入るので、ここで長さを切る。
  // 品名に100文字も要らず、長大な文字列でシートを膨らませる意味もない
  var clean = String(name || '').trim().substring(0, 100);
  if (!clean) return webData(token);

  var plan = shopAddPlan_([{ name: clean, category: '' }]);
  if (plan.add.length) shopAddCommit_(plan);

  var data = webData(token);
  if (!plan.add.length) data.notice = clean + ' はすでにリストにあります。';
  return data;
}

/** 在庫のチェックを付け外しする。used=true で消費済、false で在庫に戻す */
function webSetStock(token, id, used) {
  webAssert_(token);

  var sh = sheet_();
  var row = webFindRow_(sh, COL_COUNT, COL.ID, id);
  if (row) {
    sh.getRange(row, COL.STATUS, 1, 2)
      .setValues([[used ? STATUS.USED : STATUS.STOCK, nowStamp_()]]);
  }
  return webData(token);
}

/**
 * 在庫を使用済みにして、同じ品名を買い物リストにも入れる（画面で左になぞったとき）。
 * 使い切ってそのまま買い足したい、という流れをひと続きにするためのもの。
 *
 * 足した買い物リストの ID を addedShopId として返す。取り消すときに
 * 「この操作で足した1件」だけを狙って消すために使う（もともと入っていたものは触らない）。
 */
function webUseAndAdd(token, id) {
  webAssert_(token);

  var sh = sheet_();
  var row = webFindRow_(sh, COL_COUNT, COL.ID, id);
  if (!row) return webData(token);

  var name = String(sh.getRange(row, COL.NAME).getValue() || '').trim();
  var category = String(sh.getRange(row, COL.CATEGORY).getValue() || '');
  sh.getRange(row, COL.STATUS, 1, 2).setValues([[STATUS.USED, nowStamp_()]]);

  var plan = name ? shopAddPlan_([{ name: name, category: category }]) : { add: [] };
  var addedShopId = '';
  if (plan.add.length) {
    shopAddCommit_(plan);
    addedShopId = String(plan.ids[0]);
  }

  var data = webData(token);
  data.addedShopId = addedShopId;
  if (name && !plan.add.length) data.notice = name + ' はすでに買い物リストにあります。';
  return data;
}

/**
 * 「使用済み＋買い物リストへ」を取り消す。在庫を戻し、その操作で足した買い物リストの
 * 1件も取り消す。shopId が空なら在庫を戻すだけ（重複でリストに足さなかったとき）。
 *
 * 品名ではなく ID で狙うので、もともとリストに入っていた同名の品は消えない。
 */
function webUndoUseAndAdd(token, id, shopId) {
  webAssert_(token);

  var sh = sheet_();
  var row = webFindRow_(sh, COL_COUNT, COL.ID, id);
  if (row) {
    sh.getRange(row, COL.STATUS, 1, 2).setValues([[STATUS.STOCK, nowStamp_()]]);
  }

  if (shopId) {
    var shop = shopSheet_();
    var srow = webFindRow_(shop, SHOP_COL_COUNT, SHOP_COL.ID, shopId);
    // すでに購入済みにされていたら触らない（相手が先に片付けた分を戻さないため）
    if (srow && shop.getRange(srow, SHOP_COL.STATUS).getValue() === SHOP_STATUS.TODO) {
      shop.getRange(srow, SHOP_COL.STATUS, 1, 2).setValues([[SHOP_STATUS.CANCELED, nowStamp_()]]);
    }
  }

  return webData(token);
}

// ---------------------------------------------------------------- 読み出し

function webAssert_(token) {
  if (!webTokenOk_(token)) throw new Error('リンクが正しくありません。');
}

/** ID から行番号を探す。行の並びは編集でズレるので、必ず ID で引く */
function webFindRow_(sh, colCount, idCol, id) {
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return 0;
}

/**
 * 未購入だけを返す。購入済は画面に出さない（その場でチェックした分だけ、
 * 画面側が控えて「購入済み」に並べ、チェックを外せば戻せる）。
 */
function webShopData_() {
  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { todo: [] };

  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var todo = [];

  data.forEach(function (r) {
    if (r[SHOP_COL.STATUS - 1] !== SHOP_STATUS.TODO) return;
    todo.push({
      id: String(r[SHOP_COL.ID - 1]),
      name: String(r[SHOP_COL.NAME - 1]),
      added: normalizeYmd_(r[SHOP_COL.ADDED - 1])
    });
  });

  return { todo: todo };
}

/** 在庫だけを返す。消費済を出さない考え方は買い物リストと同じ */
function webStockData_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return { items: [] };

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var items = [];

  data.forEach(function (r) {
    if (r[COL.STATUS - 1] !== STATUS.STOCK) return;

    var date = normalizeYmd_(r[COL.DATE - 1]);
    items.push({
      id: String(r[COL.ID - 1]),
      name: String(r[COL.NAME - 1]),
      category: String(r[COL.CATEGORY - 1] || ''),
      date: date,
      approx: r[COL.PRECISION - 1] === 'month',
      label: r[COL.LABEL - 1] === '消費期限' ? '消費期限' : '賞味期限',
      days: date ? daysLeft_(date) : null,
      regDate: normalizeYmd_(r[COL.REG_DATE - 1])
    });
  });

  // 期限が近い順。期限が分からないものは末尾に回す
  items.sort(function (a, b) {
    if (!a.date) return b.date ? 1 : 0;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  return { items: items };
}
