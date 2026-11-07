/**
 * ブラウザ用の画面（買い物リスト / 在庫）。
 *
 * LINE の webhook と同じデプロイの GET 側を使う。webhook は「全員がアクセス可能」で
 * ないと動かないため、URL の ?k= に秘密トークンを付けた人にだけ中身を見せる。
 * トークンは人ごと・期限つき。作り方と検証は security.gs（webToken_ / webTokenUser_）にある。
 *
 * ⚠ この画面は「URL を知っていること」が鍵になっている。
 * 画面からは在庫の消費・買い物リストの追加削除ができるので、URL は人に渡さないこと。
 * 漏れても最長 WEB_TOKEN_MAX_DAYS 日で使えなくなるが、すぐ止めたいときは
 * GAS エディタで rotateWebToken() を実行する。
 */

var WEB_TOKEN_NG_MESSAGE = 'リンクの期限が切れたか、正しくありません。'
  + 'LINE のメニューから開き直すか、Bot に「リンク」と送ってください。';

function doGet(e) {
  var token = (e && e.parameter && e.parameter.k) || '';
  var uid = webTokenUser_(token);

  if (!uid) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:sans-serif;padding:24px">' + WEB_TOKEN_NG_MESSAGE + '</p>');
  }

  var page = HtmlService.createTemplateFromFile('web');
  page.token = token;
  page.tab = webTab_(e && e.parameter && e.parameter.tab);
  // 開いた人の呼び名。トークンの持ち主で決まる（URL に書かれた名前は信じない）
  page.who = userNameMap_()[uid] || '';
  // 最初に描くデータも一緒に埋め込む。以前は画面を返した後、画面からもう一度 webData を
  // 呼んでいて、GAS の起動待ちを2回払っていた。失敗したら空にし、画面側が従来どおり取りに行く
  page.initial = '';
  try {
    page.initial = JSON.stringify(webData(token));
  } catch (err) {
    console.error('最初のデータの埋め込みに失敗（画面から取り直す）: ' + err.stack);
  }
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
  tab = String(tab || '');
  return tab === 'stock' || tab === 'recipe' ? tab : 'shop';
}

/**
 * 画面を包むページ（GitHub Pages）。
 * Apps Script の URL を直接開くと Google の注意バーが上に出るので、
 * 中身だけを枠に収めて見せるための1枚を挟んでいる。
 * 表示先の URL は公開リポジトリに置かず、ここからパラメータで渡す。
 */
// ⚠ GitHub のリポジトリ名を変えると、この URL も変わる（Pages は /<リポジトリ名>/ で配信される）。
// 変えたらここを直し、setupRichMenu() を実行し直すこと。メニューのリンクにこの URL が焼き込まれるため
var WEB_FRAME_URL = 'https://shun-7778.github.io/04-food-expiry-bot/';

/**
 * 画面のURL。LINE の「リンク」コマンドと、GASエディタからの確認で使う。
 * ⚠ この URL 自体が鍵なので、チャットやブックマークの共有で人に渡さないこと。
 */
function webUrl_(tab) {
  // 誰の URL かはトークンで決まるので、呼び名（以前の &p=）はもう載せない。
  // 枠ページへは # の後ろで渡す。? だと GitHub のサーバーにトークンごと届いて
  // アクセスログに残りうるが、# の後ろは端末の中だけで読まれて送られない
  return WEB_FRAME_URL
    + '#u=' + encodeURIComponent(execUrl_())
    + '&k=' + webToken_()
    + '&tab=' + webTab_(tab);
}

/** 枠を使わず Apps Script を直接開くURL（注意バーは出る） */
function webDirectUrl_(tab) {
  return execUrl_() + '?k=' + webToken_() + '&tab=' + webTab_(tab);
}

/** GASエディタから実行すると、全員分のURLがログに出る */
function showWebUrl() {
  requireEditor_();
  var first = '';
  allowedUserIds_().forEach(function (uid) {
    withUser_(uid, function () {
      var who = userName_() || uid;
      var url = webUrl_('shop');   // 先に作る（無ければここでトークンが発行される）
      var e = webTokens_()[uid] || {};
      console.log(who + ' 買い物: ' + url);
      console.log(who + ' 枠なし: ' + webDirectUrl_('shop'));
      console.log(who + ' 発行: ' + new Date(Number(e.curAt || 0)) + '（' + WEB_TOKEN_MAX_DAYS + '日で失効）');
      if (!first) first = url;
    });
  });
  return first;
}

// ---------------------------------------------------------------- 画面が呼ぶAPI

/**
 * 画面の描画に要るものを全部まとめて返す。開いたとき・更新ボタン・画面に戻ってきたときに使う。
 * 書き込みの後は webPart_ で、触った区分だけを返す。
 */
function webData(token) {
  webAssert_(token);
  // 買い物リストと在庫は家族で共有なので、トークンが合えば全行を見せる。
  // 誰の操作か（追加した人の名前）は webAssert_ がトークンから決める。
  // レシピシートは買い物リストの料理名と「レシピ」タブの両方で使うので、1回だけ読んで分け合う
  var recipeRows = webRecipeRows_();
  return {
    shop: webShopData_(recipeRows), stock: webStockData_(),
    recipes: webRecipeData_(recipeRows),    // 「レシピ」タブに出す、リンク付きで照合したレシピ
    users: userNames_(),     // 画面の「あなた」の選択肢
    order: CATEGORY_ORDER    // 買い物リストを並べる順（店を回る順）
  };
}

/**
 * 書き込みの後に返すもの。触った区分（shop / stock / recipes）だけを読み直して返す。
 * 以前は1操作ごとに webData で3シートを全部読み直していて、データが増えるほど
 * チェック1つの返事が遅くなっていた。画面は先に表示を変えてから投げているので、
 * 返事は「シートの正しい中身で、その区分を差し替える」ためだけに要る。
 * ほかの区分の、家族による変更は、画面に戻ってきたときの読み直し（webData）で拾う。
 * 呼ぶ前に webAssert_ を通しておくこと
 */
function webPart_(parts) {
  var out = {};
  if (parts.shop) out.shop = webShopData_();
  if (parts.stock) out.stock = webStockData_();
  if (parts.recipes) out.recipes = webRecipeData_();
  return out;
}

// 買い物リストの見せ方（個別／料理ごと）は覚えない。
// 開くたびに個別から始めるので、選択を持ち越す必要がない

/** 買い物リストのチェックを付け外しする。done=true で購入済、false で未購入に戻す */
function webSetShop(token, id, done) {
  webAssert_(token);

  // 行を探してから書くまでを囲う。LINE や家族の操作が割り込むと、
  // 探した行番号がずれて別の品目を書き換えてしまうため（書き込み系はすべて同じ）
  withLock_(function () {
    var sh = shopSheet_();
    var row = webFindRow_(sh, SHOP_COL_COUNT, SHOP_COL.ID, id);
    if (row) {
      sh.getRange(row, SHOP_COL.STATUS, 1, 2)
        .setValues([[done ? SHOP_STATUS.DONE : SHOP_STATUS.TODO, nowStamp_()]]);
    }
  });
  return webPart_({ shop: true });
}

/** 「レシピ」タブから消す・戻す。hidden=true で消す。レシピ行そのものは残す */
function webSetRecipeHidden(token, id, hidden) {
  webAssert_(token);
  withLock_(function () { recipeSetHidden_(id, hidden); });
  return webPart_({ recipes: true });
}

/**
 * 「レシピ」タブで開いたレシピの材料を、在庫と突き合わせる。
 * 戻り値は { id, have: [在庫にあった材料名] }。webData は返さない（開くたびに全部を読み直さないため）。
 *
 * 突き合わせは LINE の材料確認と同じ matchNamesToStock_（完全一致→Claude の意味照合）。
 * 同じレシピを開き直すたびに Claude を呼ばないよう、在庫の中身が変わらないあいだは結果を使い回す
 */
function webRecipeStock(token, id) {
  webAssert_(token);

  var recipe = recipeRow_(id);
  if (!recipe || !recipe.ingredients.length) return { id: String(id), have: [] };

  var stock = currentStockRows_();
  var cache = CacheService.getScriptCache();
  var key = 'rstock:' + id + ':' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    stock.map(function (s) { return s.id + '|' + s.name; }).join('\n')
      + '#' + recipe.ingredients.map(function (g) { return g.name; }).join('\n'),
    Utilities.Charset.UTF_8));
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var r = matchNamesToStock_(recipe.ingredients.map(function (g) { return { item_name: g.name }; }));
  var out = { id: String(id), have: r.have.map(function (h) { return h.item_name; }) };
  cache.put(key, JSON.stringify(out), RECIPE_STOCK_CACHE_SEC);
  return out;
}

var RECIPE_STOCK_CACHE_SEC = 6 * 60 * 60;   // 在庫が変われば鍵ごと変わるので、長めでよい

/**
 * 「レシピ」タブから材料を買い物リストに足す。names は足す材料名（そのレシピの材料にあるものだけ通す）。
 * 分量はレシピから写し、レシピIDを付けるので、買い物タブの「料理ごと」でそのレシピにまとまる。
 * 区分（店を回る順）は材料に残していないので、ここでまとめて1回で判定する
 */
function webAddRecipeItems(token, id, names, by) {   // by は互換のため受けるだけ（名前はトークンで決まる）
  webAssert_(token);

  var recipe = recipeRow_(id);
  if (!recipe) return webPart_({ shop: true });

  var want = {};
  (names || []).slice(0, 100).forEach(function (n) { want[String(n)] = true; });
  var items = recipe.ingredients.filter(function (g) { return want[g.name]; });
  if (!items.length) return webPart_({ shop: true });

  // 区分の判定は Claude を呼ぶので時間がかかる。錠を握ったまま待たせないよう、先に済ませる
  var cats = categorizeNames_(items.map(function (g) { return g.name; }));
  // 重複の確認から書き込みまでを囲う。間に別の追加が入ると、同じ品目が2行入るため
  var plan = withLock_(function () {
    var p = shopAddPlan_(items.map(function (g, i) {
      return { name: g.name, amount: g.amount, category: cats[i] || '' };
    }), String(id), userName_());
    if (p.add.length) shopAddCommit_(p);
    return p;
  });

  var data = webPart_({ shop: true });
  if (plan.dup.length) data.notice = plan.dup.join('、') + ' はすでにリストにあります。';
  return data;
}

/** レシピ行を ID で1件読む。無ければ null */
function recipeRow_(id) {
  var sh = recipeSheet_();
  var row = webFindRow_(sh, RECIPE_COL_COUNT, RECIPE_COL.ID, id);
  if (!row) return null;
  var r = sh.getRange(row, 1, 1, RECIPE_COL_COUNT).getValues()[0];
  return {
    id: String(r[RECIPE_COL.ID - 1]),
    ingredients: recipeLines_(r[RECIPE_COL.INGREDIENTS - 1]).map(splitIngredient_)
  };
}

/**
 * 買い物リストの品目を取り消す（「レシピ」タブの材料の「－」から）。
 * 買ったわけではないので購入済にはせず、取消にする。未購入のものだけを対象にする
 * （相手が先に買った・消した分を巻き戻さないため）
 */
function webCancelShop(token, id) {
  webAssert_(token);

  withLock_(function () {
    var sh = shopSheet_();
    var row = webFindRow_(sh, SHOP_COL_COUNT, SHOP_COL.ID, id);
    if (row && sh.getRange(row, SHOP_COL.STATUS).getValue() === SHOP_STATUS.TODO) {
      sh.getRange(row, SHOP_COL.STATUS, 1, 2).setValues([[SHOP_STATUS.CANCELED, nowStamp_()]]);
    }
  });
  return webPart_({ shop: true });
}

/** 「レシピ」タブのピン留めを付け外しする。pinned=true で上に固定する */
function webSetRecipePinned(token, id, pinned) {
  webAssert_(token);
  withLock_(function () { recipeSetPinned_(id, pinned); });
  return webPart_({ recipes: true });
}

/** 品名を買い物リストに足す。by は互換のため受けるだけ（名前はトークンで決まる） */
function webAddShop(token, name, by) {
  webAssert_(token);

  // 画面から来た文字はそのままシートへ入るので、ここで長さを切る。
  // 品名に100文字も要らず、長大な文字列でシートを膨らませる意味もない
  var clean = String(name || '').trim().substring(0, 100);
  if (!clean) return webPart_({ shop: true });

  // 並べ替えは区分で決まるので、手で足した分もここで区分を決めておく。
  // 画面にはもう出ている（先に描いてから投げている）ので、待たせるのは書き込みだけ。
  // 区分の判定（Claude）は錠の外で済ませ、重複の確認から書き込みまでだけを囲う
  var category = categorizeName_(clean);
  var plan = withLock_(function () {
    var p = shopAddPlan_([{ name: clean, category: category }], '', userName_());
    if (p.add.length) shopAddCommit_(p);
    return p;
  });

  var data = webPart_({ shop: true });
  if (!plan.add.length) data.notice = clean + ' はすでにリストにあります。';
  return data;
}

/** 在庫のチェックを付け外しする。used=true で消費済、false で在庫に戻す */
function webSetStock(token, id, used) {
  webAssert_(token);

  withLock_(function () {
    var sh = sheet_();
    var row = webFindRow_(sh, COL_COUNT, COL.ID, id);
    if (row) {
      sh.getRange(row, COL.STATUS, 1, 2)
        .setValues([[used ? STATUS.USED : STATUS.STOCK, nowStamp_()]]);
    }
  });
  return webPart_({ stock: true });
}

/**
 * 在庫を使用済みにして、同じ品名を買い物リストにも入れる（画面で左になぞったとき）。
 * 使い切ってそのまま買い足したい、という流れをひと続きにするためのもの。
 *
 * 足した買い物リストの ID を addedShopId として返す。取り消すときに
 * 「この操作で足した1件」だけを狙って消すために使う（もともと入っていたものは触らない）。
 */
function webUseAndAdd(token, id, by) {   // by は互換のため受けるだけ（名前はトークンで決まる）
  webAssert_(token);

  var done = withLock_(function () {
    var sh = sheet_();
    var row = webFindRow_(sh, COL_COUNT, COL.ID, id);
    if (!row) return null;

    var n = String(sh.getRange(row, COL.NAME).getValue() || '').trim();
    var category = String(sh.getRange(row, COL.CATEGORY).getValue() || '');
    sh.getRange(row, COL.STATUS, 1, 2).setValues([[STATUS.USED, nowStamp_()]]);

    var p = n
      ? shopAddPlan_([{ name: n, category: category }], '', userName_())
      : { add: [] };
    if (p.add.length) shopAddCommit_(p);
    return { name: n, plan: p };
  });
  if (!done) return webPart_({ shop: true, stock: true });

  var name = done.name;
  var plan = done.plan;
  var addedShopId = plan.add.length ? String(plan.ids[0]) : '';

  var data = webPart_({ shop: true, stock: true });
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

  withLock_(function () {
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
  });

  return webPart_({ shop: true, stock: true });
}

// ---------------------------------------------------------------- 読み出し

/**
 * 画面からの呼び出しの入口。トークンの持ち主を、この実行の「相手」（CURRENT_USER_）にする。
 * これで userName_()（追加した人の名前）が、画面から名乗った名前ではなくトークンで決まる
 */
function webAssert_(token) {
  var uid = webTokenUser_(token);
  if (!uid) throw new Error(WEB_TOKEN_NG_MESSAGE);
  CURRENT_USER_ = uid;
  THEME_CACHE_ = null;
  return uid;
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
function webShopData_(recipeRows) {   // recipeRows は webData が先に読んだレシピ行（無ければここで読む）
  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { todo: [] };

  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var todo = [];
  var recipes = null;   // レシピシートは、出どころのある品目が1つでもあるときだけ読む

  data.forEach(function (r) {
    if (r[SHOP_COL.STATUS - 1] !== SHOP_STATUS.TODO) return;

    var item = {
      id: String(r[SHOP_COL.ID - 1]),
      name: String(r[SHOP_COL.NAME - 1]),
      added: normalizeYmd_(r[SHOP_COL.ADDED - 1]),
      // レシピに分量が書かれていたもの。手で足した品目では空
      amount: String(r[SHOP_COL.AMOUNT - 1] || ''),
      // 足した人の呼び名。USER_NAMES に載っていない人や、名乗る前に足した分は空
      by: String(r[SHOP_COL.ADDED_BY - 1] || ''),
      // 画面の並べ替えに使う。付いていないものは一覧の最後に回る
      category: String(r[SHOP_COL.CATEGORY - 1] || '')
    };

    // 写真から足した品目には、出どころのレシピ（料理名とリンク）を添える
    var recipeId = String(r[SHOP_COL.RECIPE - 1] || '');
    if (recipeId) {
      // 料理ごとの並べ替えと色分けに使う。リンクや料理名が無くても、
      // 同じ写真から入った品目であることは ID だけで分かる
      item.recipeId = recipeId;
      if (!recipes) recipes = recipeRows !== undefined ? recipeMapFromRows_(recipeRows) : recipeMap_();
      var recipe = recipes[recipeId];
      if (recipe && (recipe.url || recipe.title)) {
        item.recipe = { title: recipe.title, url: recipe.url };
      }
    }

    todo.push(item);
  });

  return { todo: todo };
}

/**
 * 「レシピ」タブに出すもの。リンク付きで照合したレシピを、日数・件数の区切りなしに全部返す。
 * 並べ替え（ピン留めを上、あとは新しい順）は画面側でやる。
 *
 * 同じリンクを何度か送っていたら、いちばん新しい行だけで判断する。
 * その行が消されていれば、古い同じリンクが代わりに出てくることもない。
 * リンクの無い行（写真だけで照合したもの）は出さない。
 * 家族の分もまとめて出す（買い物リストと同じく共有のもの）
 */
function webRecipeData_(pre) {   // pre は webData が先に読んだレシピ行（無ければここで読む）
  // 前の書き方（「〜します」）で残した作り方があれば、少しずつ言い切りに書き直す。
  // 全部済めば印を立てて、以後は何もしない。失敗しても画面は出す。
  // 書き直すとシートが変わるので、先に読んだ行は使わずに読み直す
  if (!PropertiesService.getScriptProperties().getProperty(RECIPE_STEPS_FINISHED_KEY)) {
    try { rewriteOldRecipeSteps_(); } catch (err) { console.error('作り方の書き直しで失敗: ' + err.message); }
    pre = undefined;
  }

  var data = webRecipeRead_(pre);
  // 分類の無いもの（この機能より前の分など）があれば、ここでまとめて付けてから読み直す。
  // 一度付ければ次からは通らないので、Claude を呼ぶのは足りないときだけ
  if (data.missingGroup) {
    fillRecipeGroups_();
    data = webRecipeRead_();
  }
  return { items: data.items, groups: RECIPE_GROUPS };
}

/**
 * レシピシートの全行を1回で読む。{ rows, cols }。シートが無い・空なら null。
 * 列を足す前の古いシートでは、ある列までだけ読む（足りない列は空として扱う）
 */
function webRecipeRows_() {
  var id = prop_('SPREADSHEET_ID', false);
  if (!id) return null;

  var sh = ss_().getSheetByName(RECIPE_SHEET_NAME);
  if (!sh) return null;   // まだ1件も登録していない

  var last = sh.getLastRow();
  if (last < 2) return null;

  var cols = Math.min(sh.getMaxColumns(), RECIPE_COL_COUNT);
  return { rows: sh.getRange(2, 1, last - 1, cols).getValues(), cols: cols };
}

/** webRecipeRows_ の結果から、レシピID → { title, url } を作る（recipeMap_ と同じ中身） */
function recipeMapFromRows_(pre) {
  var map = {};
  if (!pre) return map;
  pre.rows.forEach(function (r) {
    var key = String(r[RECIPE_COL.ID - 1] || '');
    if (!key) return;
    map[key] = {
      title: String(r[RECIPE_COL.TITLE - 1] || ''),
      url: RECIPE_COL.URL <= pre.cols ? String(r[RECIPE_COL.URL - 1] || '') : ''
    };
  });
  return map;
}

function webRecipeRead_(pre) {
  if (pre === undefined) pre = webRecipeRows_();
  if (!pre) return { items: [] };

  var cols = pre.cols;
  var rows = pre.rows;
  var names = userNameMap_();
  var seen = {};
  var items = [];

  function cell(r, col) { return col <= cols ? r[col - 1] : ''; }

  // 下ほど新しい（ID は行の順に振っている）ので、下から見る
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i];
    var url = String(cell(r, RECIPE_COL.URL) || '');
    if (!url || seen[url]) continue;
    seen[url] = true;

    if (cell(r, RECIPE_COL.HIDDEN)) continue;
    var at = recipeTime_(cell(r, RECIPE_COL.ADDED));

    items.push({
      id: String(cell(r, RECIPE_COL.ID)),
      title: String(cell(r, RECIPE_COL.TITLE) || ''),
      url: url,
      added: at ? Utilities.formatDate(new Date(at), 'Asia/Tokyo', 'yyyy-MM-dd') : '',
      by: names[String(cell(r, RECIPE_COL.USER) || '')] || '',
      ingredients: recipeLines_(cell(r, RECIPE_COL.INGREDIENTS)).map(splitIngredient_),
      steps: recipeLines_(cell(r, RECIPE_COL.STEPS)),
      pinned: !!cell(r, RECIPE_COL.PINNED),
      group: normalizeRecipeGroup_(cell(r, RECIPE_COL.GROUP))
    });
  }

  var missingGroup = items.some(function (it) { return !it.group; });
  return { items: items, missingGroup: missingGroup };
}

/** 改行区切りのセルを、空行を除いた配列にする */
function recipeLines_(v) {
  return String(v || '').split(/\r?\n/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

/**
 * 「[まとめ名] 材料名：分量」を { name, amount, label } に分ける。
 * まとめ名・分量の無い行（この形式より前に残した分も含む）は、そこを空にする
 */
function splitIngredient_(line) {
  var label = '';
  var m = /^\[([^\]]+)\]\s*/.exec(line);
  if (m) {
    label = m[1].trim();
    line = line.substring(m[0].length);
  }
  var i = line.lastIndexOf('：');
  if (i <= 0) return { name: line.trim(), amount: '', label: label };
  return { name: line.substring(0, i).trim(), amount: line.substring(i + 1).trim(), label: label };
}

/**
 * レシピ行の登録日時をミリ秒にする。シートが日時として読み替えていれば Date、
 * 書いたままなら「2026-11-03 20:15」の文字列で来る。読めなければ 0
 */
function recipeTime_(v) {
  if (v instanceof Date) return v.getTime();
  var m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(String(v || '').trim());
  if (!m) return 0;
  return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00+09:00').getTime();
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
      // 期限を持たない常備品（水・米など）。画面では「常備」と出す
      always: r[COL.PRECISION - 1] === PRECISION_ALWAYS,
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
