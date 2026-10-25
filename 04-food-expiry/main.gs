/**
 * 食材在庫・買い物リスト管理 Bot
 * LINE にテキストで期限や消費を送る → Claude で解析 → 在庫を更新して返信する
 * レシピの写真を送る → Claude Vision で材料を読み取り、在庫と突き合わせて返信する
 *
 * 前提: スクリプトプロパティに以下を設定しておくこと
 *   LINE_CHANNEL_ACCESS_TOKEN : LINE Developers の長期チャネルアクセストークン
 *   ANTHROPIC_API_KEY         : Anthropic コンソールで発行した API キー
 *   ALLOWED_USER_IDS          : (任意) 使ってよい人の LINE userId をカンマ区切りで。
 *                               設定すると、それ以外からの投稿を無視する。週次通知の宛先も兼ねる
 *   ALLOWED_USER_ID           : (任意) 上の1人版。両方あれば両方を許す
 */

/**
 * タスクごとにモデルを分ける。
 *   レシピ写真の読み取り … 手書き・雑誌など読み取り対象が多様なぶん難度は高いが、Sonnet で足りる想定
 *   テキストの解析・在庫の突き合わせ … 易しいので最安の Haiku
 *
 * 単価（入力/出力 per MTok）と画像1枚あたりの目安:
 *   'claude-opus-5'    $5 / $25   約2.7円/枚  精度最優先
 *   'claude-sonnet-5'  $2 / $10   約1.1円/枚  バランス型
 *   'claude-haiku-4-5' $1 / $5    約0.6円/枚  最安（effort 非対応。自動で除外される）
 *
 * 読み取りを外すようなら MODEL_VISION を 'claude-opus-5' に戻す。
 */
var MODEL_VISION = 'claude-sonnet-5';
var MODEL_TEXT = 'claude-haiku-4-5';
var ANTHROPIC_VERSION = '2023-06-01';
var MAX_IMAGE_BYTES = 4 * 1024 * 1024; // Claude の画像サイズ上限に対する安全マージン

// ---------------------------------------------------------------- スプレッドシート定義

var SHEET_NAME = '在庫';

// 列番号（1始まり）。順番を変えるときはヘッダーと合わせて直すこと。
// STATUS と UPDATED は隣り合わせのままにすること（1回の setValues でまとめて書いている）
var COL = {
  ID: 1,          // 連番ID。バブルの「使った」ボタンはこれで品目を指す
  REG_DATE: 2,    // 登録日 (YYYY-MM-DD)
  REG_TIME: 3,    // 登録時刻 (HH:mm)
  NAME: 4,        // 食材名
  CATEGORY: 5,    // 区分（CATEGORIES のいずれか）
  DATE: 6,        // 期限 (YYYY-MM-DD)
  PRECISION: 7,   // day / month / always（always は期限を持たない常備品）
  LABEL: 8,       // 賞味期限 / 消費期限
  CONFIDENCE: 9,  // high / medium / low
  SOURCE: 10,     // 写真 / テキスト
  RAW: 11,        // 原文（写真の印字、または発話の該当部分）
  STATUS: 12,     // 在庫 / 消費済 / 破棄 / 取消
  UPDATED: 13,    // 状態を最後に変えた日時
  // 14・15列目は、以前「残り1か月／1週間を1回だけ通知する」ために使っていた印。
  // 今は毎週再掲するので読み書きしない。既存シートの列を保つために定義だけ残す
  NOTIFIED_1M: 14,
  NOTIFIED_1W: 15
};
var COL_COUNT = 15;

var HEADERS = ['ID', '登録日', '登録時刻', '食材名', '区分', '期限', '精度', 'ラベル', '確度',
  '入力元', '原文', '状態', '更新日時', '通知1M', '通知1W'];

// DISCARDED は使わなくなったが、過去に記録した行が持っているので残す
var STATUS = { STOCK: '在庫', USED: '消費済', DISCARDED: '破棄', CANCELED: '取消' };

// 食材の大区分。多いとClaudeの分類がブレるので7つに絞ってある
var CATEGORIES = ['野菜・フルーツ', '肉・魚介', '卵・乳製品', '調味料', '主食・加工食品', '飲料・菓子', '日用品'];

/**
 * 買い物リストを並べる順。店を回る順に合わせてある。
 * 「肉・魚介」は魚と肉を分けて持っていないので、魚も肉と同じ場所に出る。
 * 粉類・乾物・主食は調味料の隣（「主食・加工食品」）にまとめている。
 * 画面が並べ替えに使うので、CATEGORIES に区分を足したらここにも足すこと
 */
var CATEGORY_ORDER = ['野菜・フルーツ', '肉・魚介', '調味料', '主食・加工食品',
  '卵・乳製品', '飲料・菓子', '日用品'];

var CATEGORY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', description: '次のいずれか1つ: ' + CATEGORIES.join(' / ') }
  },
  required: ['category'],
  additionalProperties: false
};

/**
 * 品名から区分だけを決める。画面から手で足した品目に使う。
 * 並べ替えは区分で決まるので、ここが空だと一覧の最後に回ってしまう。
 * 判定できなくても追加そのものは通す（区分が空になるだけ）
 */
function categorizeName_(name) {
  var clean = String(name || '').trim();
  if (!clean) return '';

  try {
    var r = callClaude_([{
      type: 'text',
      text: '買い物リストに足す品物の区分を1つ選んでください。\n'
        + '品名: ' + clean + '\n'
        + '区分: ' + CATEGORIES.join(' / ') + '\n'
        + '迷ったときの目安: 豆腐・納豆・こんにゃくなどの日配品は「卵・乳製品」、'
        + '乾物・缶詰・冷凍食品・粉類は「主食・加工食品」。食べ物でなければ「日用品」。'
    }], CATEGORY_SCHEMA, MODEL_TEXT);

    var c = r && r.category;
    return CATEGORIES.indexOf(c) >= 0 ? c : '';
  } catch (err) {
    console.warn('区分を判定できませんでした（' + clean + '）: ' + err.message);
    return '';
  }
}

// ---------------------------------------------------------------- 買い物リスト定義

var SHOP_SHEET_NAME = '買い物リスト';

// STATUS と UPDATED は隣り合わせのままにすること。
// shopBoughtCommit_ / shopClearCommit_ が「押してから返信までを速くする」ために、この2列を
// 1回の setValues でまとめて書いている（離すと書き込みが2往復に戻る）
var SHOP_COL = {
  ID: 1,       // 連番ID。postback の data はこれで品目を指す（行番号は編集でズレるため使わない）
  ADDED: 2,    // 追加日 (YYYY-MM-DD)
  NAME: 3,     // 品名
  CATEGORY: 4, // 区分（CATEGORIES のいずれか）
  STATUS: 5,   // 未購入 / 購入済 / 取消
  UPDATED: 6,  // 状態を最後に変えた日時
  RECIPE: 7,   // 出どころのレシピID（レシピシートの行を指す）。手で足した品目では空
  AMOUNT: 8,   // 分量（レシピに書かれていたもの。「大さじ2」など）。無ければ空
  ADDED_BY: 9  // 足した人の呼び名。USER_NAMES に無い人や、名乗っていない画面からは空
};
var SHOP_COL_COUNT = 9;

var SHOP_HEADERS = ['ID', '追加日', '品名', '区分', '状態', '更新日時', 'レシピID', '分量', '登録者'];

var SHOP_STATUS = { TODO: '未購入', DONE: '購入済', CANCELED: '取消' };

// ---- レシピ。写真から材料を登録したとき、その出どころを1行だけ残す。
// 買い物リストの各行には ID だけを持たせる（URL を行ごとに複製しない）。
// 同じレシピから7品目足しても URL は1か所にあり、料理名の置き場もここになる
var RECIPE_SHEET_NAME = 'レシピ';

var RECIPE_COL = {
  ID: 1,       // 連番ID。買い物リストの レシピID 列がこれを指す
  ADDED: 2,    // 登録日時
  TITLE: 3,    // 料理名（写真から読み取ったもの。読めなければ空）
  URL: 4,      // リールなどのリンク。本人が送ってきたもの
  USER: 5      // 登録した人の userId
};
var RECIPE_COL_COUNT = 5;

var RECIPE_HEADERS = ['レシピID', '登録日時', '料理名', 'URL', '登録者'];

// 通知のしきい値（日数）
var NOTIFY_1M_DAYS = 30;
var NOTIFY_1W_DAYS = 7;

// 水や米のように、期限で追いかけず切らさず置いておくもの。
// 期限の列は空のまま、精度の列にこの印を入れて見分ける（列を増やさずに済む）
var PRECISION_ALWAYS = 'always';

/** 期限を持たない「常にあるもの」か */
function isAlways_(it) {
  return !!it && it.date_precision === PRECISION_ALWAYS;
}

// ---------------------------------------------------------------- 設定読み出し

/**
 * 設定値は1回の webhook で3〜4回読むが、1件ずつ取ると読んだ回数だけ往復する。
 * 実行中に書き換わらないものだけ最初の1回でまとめて読み、あとは使い回す。
 * LAST_OP / PENDING / SHOP_NEXT_ID / RECIPE_SETS は実行中に書き換えるので
 * ここには入れないこと（毎回そのまま読む）。
 */
var PROP_FIXED_KEYS_ = ['SPREADSHEET_ID', 'LINE_CHANNEL_ACCESS_TOKEN', 'ANTHROPIC_API_KEY',
  'ALLOWED_USER_ID', 'ALLOWED_USER_IDS'];
var PROP_CACHE_ = null;

function prop_(key, required) {
  var v;
  if (PROP_FIXED_KEYS_.indexOf(key) >= 0) {
    if (!PROP_CACHE_) PROP_CACHE_ = PropertiesService.getScriptProperties().getProperties();
    v = PROP_CACHE_[key];
  } else {
    v = PropertiesService.getScriptProperties().getProperty(key);
  }

  if (required && !v) {
    throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  }
  return v;
}

// ---------------------------------------------------------------- Webhook 入口

/**
 * LINE Messaging API の Webhook 受け口。
 *
 * このデプロイは webhook を受けるために「全員がアクセス可能」で公開されているので、
 * URL を知っている人は誰でもここに POST できてしまう。GAS の doPost は HTTP ヘッダーを
 * 取れず X-Line-Signature を検証できないため、代わりに URL のクエリ ?s= に置いた秘密で
 * 本物かを判定する（security.gs の webhookRequestOk_）。
 *
 * 本文の source.userId は送信者が自由に書ける値なので、それ単独では認証にならない。
 * ALLOWED_USER_ID の判定は、秘密が漏れたときに備えた二枚目の壁として残してある。
 */
function doPost(e) {
  try {
    if (!webhookRequestOk_(e)) {
      console.warn('秘密の合わない POST を無視しました');
      return webhookResponse_();
    }

    // ここは本物の /exec で動いている。外から開くURLを組み立てるのに要るので控えておく
    rememberExecUrl_();

    var body = JSON.parse(e.postData.contents);
    var events = body.events || [];

    // シートも Claude も触る前に、何より先に出す
    startLoading_(events);

    // 写真は複数枚まとめて送られることがある。同じ webhook 呼び出しに
    // 含まれる image イベントはまとめて1回のレシピ照合として扱う。
    // 間を置いて送られた場合（別の webhook 呼び出しになる）はそれぞれ別の照合になる。
    var imageEvents = events.filter(function (ev) {
      return ev.type === 'message' && ev.message && ev.message.type === 'image' && isAllowedSender_(ev);
    });
    if (imageEvents.length) {
      handleRecipeImages_(imageEvents);
    }

    events.forEach(function (ev) {
      if (imageEvents.indexOf(ev) >= 0) return; // 上でまとめて処理済み
      handleEvent_(ev);
    });
  } catch (err) {
    console.error('doPost failed: ' + err.stack);
  }
  return webhookResponse_();
}

/**
 * webhook への返事。中身は常に同じにしておく。
 * 受け付けたか弾いたかを返り値で区別できると、秘密を総当たりする手掛かりになるため。
 * LINE には常に 200 を返す（エラーを返すと再送され続ける）。
 */
function webhookResponse_() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * webhook の最初の1件を見てローディング表示を出す。
 * 写真を複数枚送っても返信は1回なので、ここも 1回だけ呼ぶ。
 * 入力欄に差し込むだけのリッチメニュー（'fill'）は、まだ送信されていないので除く。
 */
function startLoading_(events) {
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.type !== 'message' && ev.type !== 'postback') continue;
    if (ev.type === 'postback' && ((ev.postback && ev.postback.data) || '') === 'fill') continue;
    if (!isAllowedSender_(ev)) continue;

    showLoading_(ev.source && ev.source.userId);
    return;
  }
}

// ---------------------------------------------------------------- 利用者

/**
 * 使ってよい人の LINE userId。買い物リストと在庫は全員で1つを共有する。
 *
 * ALLOWED_USER_IDS にカンマ区切りで並べる。1人だけなら従来どおり
 * ALLOWED_USER_ID でもよく、両方あれば両方を許す（設定を書き換えずに人を増やせる）。
 * どちらも空なら誰も使えない（isAllowedSender_ が全員を弾く）。必ず設定すること。
 */
function allowedUserIds_() {
  var raw = (prop_('ALLOWED_USER_IDS', false) || '') + ',' + (prop_('ALLOWED_USER_ID', false) || '');
  var seen = {};
  var ids = [];

  raw.split(',').forEach(function (part) {
    var id = part.trim();
    if (!id || seen[id]) return;
    seen[id] = true;
    ids.push(id);
  });
  return ids;
}

/**
 * この実行で相手をしている人。doPost の入口で決まる。
 *
 * Apps Script は webhook 1回ごとに実行が独立していて、変数が次の実行へ持ち越されない。
 * そのため、ここに1人分だけ持たせておけば取り違えは起きない。
 * 「番号で選ぶ」「取消」を人ごとに分けるのに使う。
 */
var CURRENT_USER_ = '';

function setCurrentUser_(event) {
  CURRENT_USER_ = (event && event.source && event.source.userId) || '';
  THEME_CACHE_ = null;   // 相手が変われば配色も変わる
}

/**
 * 買い物リストに残す呼び名の対応表。
 * スクリプトプロパティ USER_NAMES に「Uxxxx:しゅん,Uyyyy:あや」の形で書く。
 * LINE の表示名は本名のことが多く行が長くなるので、自動では取らずここだけを見る。
 * 書かれていない人は空（今までどおり「9/13 追加」とだけ出る）。
 */
function userNameMap_() {
  var map = {};
  String(prop_('USER_NAMES', false) || '').split(',').forEach(function (pair) {
    var i = pair.indexOf(':');
    if (i <= 0) return;
    var id = pair.slice(0, i).trim();
    var name = pair.slice(i + 1).trim();
    if (id && name) map[id] = name;
  });
  return map;
}

/** 画面の「あなた」の選択肢に出す呼び名の一覧 */
function userNames_() {
  var map = userNameMap_();
  return Object.keys(map).map(function (id) { return map[id]; });
}

/** 今この操作をしている人の呼び名。LINE 経由でないときや未登録なら空 */
function userName_() {
  return (CURRENT_USER_ && userNameMap_()[CURRENT_USER_]) || '';
}

/**
 * 人ごとに分けて持つスクリプトプロパティのキー。
 * 誰か分からないときは名前だけのキーに落とす（1人で使っていた頃と同じ形）。
 */
function userKey_(name) {
  return CURRENT_USER_ ? name + ':' + CURRENT_USER_ : name;
}

/**
 * その人の配色。'dark'（既定）か 'light'。
 *
 * LINE は端末のダークモード設定を Bot に渡してくれないので、自動では切り替えられない。
 * 本人に選んでもらい、その選択をここに覚えておく。
 * バブルの色とリッチメニューの画像の、両方がこの値で決まる。
 */
function userTheme_() {
  var v = PropertiesService.getScriptProperties().getProperty(userKey_('THEME'));
  return v === 'light' ? 'light' : 'dark';
}

function setUserTheme_(theme) {
  PropertiesService.getScriptProperties().setProperty(userKey_('THEME'),
    theme === 'light' ? 'light' : 'dark');
  THEME_CACHE_ = null;
}

/**
 * 別の人になりきって処理する。週次通知のように、
 * 1回の実行で複数人ぶんを人それぞれの配色で組み立てるときに使う。
 */
function withUser_(userId, fn) {
  var prevUser = CURRENT_USER_;
  var prevTheme = THEME_CACHE_;
  CURRENT_USER_ = userId;
  THEME_CACHE_ = null;
  try {
    return fn();
  } finally {
    CURRENT_USER_ = prevUser;
    THEME_CACHE_ = prevTheme;
  }
}

/** 「id」と送られたかどうか。許可の判定より先に見るので、ここだけは誰の分も通る */
function isIdCommand_(event) {
  return event.type === 'message'
    && event.message && event.message.type === 'text'
    && String(event.message.text || '').trim().toLowerCase() === 'id';
}

/**
 * シートへの追記を順番待ちにする。
 *
 * 追記はどれも「今の最終行を読む → その下に書く」の2段階で、IDの採番も
 * 「今の番号を読む → 次の番号を書く」になっている。2人が同時に操作すると
 * この隙間で割り込まれ、同じ行を上書きしたり同じIDが2件できたりする。
 * IDはバブルのボタンが行を指すのに使うので、重複すると別の品目を消しかねない。
 *
 * 待つのは最大20秒。それ以上は返信が間に合わないので、諦めて利用者に伝える。
 */
var LOCK_HELD_ = false;

function withLock_(fn) {
  // すでに囲いの中（appendRows_ から stockReserveIds_ を呼ぶ形）なら、そのまま実行する。
  // 同じ実行の中で取り直そうとすると、自分が持っている錠を自分で待つことになるため
  if (LOCK_HELD_) return fn();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error('ほかの操作の途中です。少し待ってからもう一度試してください。');
  }

  LOCK_HELD_ = true;
  try {
    return fn();
  } finally {
    LOCK_HELD_ = false;
    lock.releaseLock();
  }
}

/**
 * 許可した人以外からの投稿を弾く。
 * 未設定なら誰も通さない。設定漏れのまま公開されて、webhook の秘密だけが頼りになるのを避ける
 * （自分の userId を知る「id」コマンドは、この判定より前で答えるので設定前でも使える）
 */
function isAllowedSender_(event) {
  var allowed = allowedUserIds_();
  if (!allowed.length) {
    console.warn('ALLOWED_USER_IDS が未設定のため、すべての投稿を無視しています');
    return false;
  }

  var id = event && event.source && event.source.userId;
  return !!id && allowed.indexOf(id) >= 0;
}

function handleEvent_(event) {
  if (event.type !== 'message' && event.type !== 'postback') return;

  // 「id」だけは許可前でも答える。新しく使う人には自分の userId を知る手段がなく、
  // それが分からないと ALLOWED_USER_IDS に追記できず、設定を始められないため。
  // 返すのは本人の userId だけで、在庫も買い物リストも見せない（Claude も呼ばない）
  if (isIdCommand_(event)) {
    replyText_(event.replyToken,
      'あなたの userId:\n' + ((event.source && event.source.userId) || '(取得不可)'));
    return;
  }

  if (!isAllowedSender_(event)) {
    console.warn('許可外のユーザーからの投稿を無視: ' + (event.source && event.source.userId));
    return;
  }

  // 以降の「番号で選ぶ」「取消」はこの人のぶんだけを見る
  setCurrentUser_(event);

  if (event.type === 'postback') {
    handlePostback_(event);
    return;
  }

  var msg = event.message;

  if (msg.type === 'text') {
    handleText_(event, msg.text.trim());
    return;
  }

  if (msg.type === 'audio') {
    replyText_(event.replyToken,
      'ボイスメッセージには未対応です。\n'
      + 'キーボードのマイク（🌐 の隣）で音声入力して、文字にしてから送ってください。');
    return;
  }

  if (msg.type !== 'image') {
    replyText_(event.replyToken, 'レシピの写真か、テキストで送ってください。');
    return;
  }

  // 通常ここには来ない（image は doPost 側でまとめて処理済み）。
  // 万一単独で回ってきた場合のフォールバック。
  handleRecipeImages_([event]);
}

/**
 * レシピ写真（1枚以上）から材料を読み取り、在庫と突き合わせて返信する。
 * 複数枚渡された場合は全部の材料をまとめてから重複を除き、1回だけ照合する。
 * 返信は一番最後のイベントの replyToken で行い、他のイベントには返信しない
 * （1件ずつ返信すると同じ内容が写真の枚数分届いてしまうため）。
 */
function handleRecipeImages_(events) {
  // doPost から handleEvent_ を通さずに呼ばれるので、ここでも利用者を決める
  setCurrentUser_(events[0]);

  clearPending_(); // 写真が来たら選択待ちは打ち切る
  var replyToken = events[events.length - 1].replyToken;

  try {
    var seen = {};
    var items = [];
    var dish = '';
    events.forEach(function (ev) {
      var image = fetchLineImage_(ev.message.id);
      var result = extractRecipeItems_(image.base64, image.mimeType);
      // 料理名は最初に読み取れたものを採る（複数枚でも料理は1つという前提）
      if (!dish && result && result.dish_name) dish = String(result.dish_name).trim();
      ((result && result.items) || []).forEach(function (it) {
        if (!it.item_name) return;
        var key = normalizeName_(it.item_name);
        if (!key || seen[key]) return; // 複数枚にまたがる重複を除く
        seen[key] = true;
        items.push(it);
      });
    });

    if (!items.length) {
      replyText_(replyToken, RECIPE_EMPTY_MESSAGE);
      return;
    }

    replyRecipeMatch_(replyToken, items, dish);
  } catch (err) {
    console.error('レシピ照合に失敗: ' + err.stack);
    replyText_(replyToken, '読み取りに失敗しました。\n' + err.message);
  }
}

var HELP_MESSAGE = [
  '使い方',
  '',
  '■ 下のメニュー',
  '押すと入力欄に「期限登録」などが改行付きで入ります。',
  '続けて中身を打って送ってください。',
  '　期限登録 牛乳 9月10日',
  '　使用済 牛乳',
  '　買い物リスト追加 牛乳と卵',
  '　買い物リスト削除 牛乳',
  '　在庫確認 醤油、みりん',
  '種別が確定するので、取り違えが起きません。',
  'これまでどおり接頭辞なしでも送れます。',
  '',
  '「買い物リスト表示」「取消」は押すとすぐ実行されます。',
  '「材料確認」は押すと写真の選択画面が開きます。',
  '',
  '買い物リストの全件削除はメニューから外しました。',
  '「買い物リスト表示」のバブル最下段にある「全て削除」',
  'を使ってください。行は消さないので「取消」で戻せます。',
  '',
  '■ 登録',
  '・「豆乳は2027年2月21日 ヨーグルトは9月17日」と送る',
  '　「納豆は明日まで」のような言い方も可',
  '同じものが在庫にあると確認します。まとめ買いは',
  '「牛乳を2個 9月11日」と個数を言えば確認しません。',
  '',
  '■ 在庫確認',
  '「在庫確認 醤油、みりん」のように送ると、それぞれ',
  '在庫にあるかどうかを返します。あるものは期限を',
  '色付き（超過=赤／残り1週間=黄）で示し、「使用済」で',
  'その場で消費できます。ないものは「追加」で買い物',
  'リストに入れられます。',
  '',
  '■ 材料確認（レシピ照合）',
  'インスタの共有ボタンでリールを送ってから、続けて',
  'レシピの写真を送ると、そこから足した品目にリンクが',
  '付きます。付くのは次に送った写真1回だけです。',
  '画面の買い物リストで料理名を押すと開けます。',
  '違うレシピに付いたときは、一覧の「外す」を押して',
  'ください。すでに足した品目からも外れます。',
  'レシピの写真を送ると、材料を在庫と突き合わせて',
  '「買うべきもの」「家にあるもの」に分けて返します。',
  '各行の「追加」を押すとその場で買い物リストに入り、',
  '「全部追加」で買うべきものをまとめて入れられます。',
  '期限を見たいときは在庫確認を使ってください。',
  '複数枚まとめて送ると1回の照合にまとめます。',
  '',
  '■ 使ったとき',
  '「牛乳使った」「ヨーグルト食べた」「豆腐捨てた」',
  'いずれも消費済として記録します。',
  '「片栗粉2つ捨てた」「牛乳全部使った」もまとめて可',
  '期限違いが複数あるときは、どれを使ったか',
  'ボタンで選べるバブルを返します。',
  '',
  '■ 通知',
  '毎週土曜の朝、期限が近いものをお知らせします。',
  '1品につき残り1か月と残り1週間の2回だけです。',
  '',
  '■ 配色（人ごとに選べます）',
  '「白」… 白基調（明るい壁紙の人向け）',
  '「黒」… 黒基調（既定）',
  'バブルと下のメニューが、選んだほうに変わります。',
  '設定は自分だけに効き、ほかの人の見え方は変わりません。',
  '',
  '■ 買い物リスト',
  '「買い物リストに牛乳と卵を追加」',
  '　追加した分を「取消」ボタン付きで返すので、品名を',
  '　取り違えたときはその場で取り消せます。',
  '「牛乳買った」… リストから外す',
  '「買い物リスト」… 一覧をボタン付きで表示',
  '　各行の「削除」、または「全て削除」を押すと',
  '　その場でリストから外れます（発言は残りません）',
  '「買い物リストを全部削除」… 空にする',
  '',
  '■ コマンド',
  '取消 … 直前の登録・消費を取り消す',
  'id … あなたの userId を表示'
].join('\n');

var RECIPE_EMPTY_MESSAGE = '材料を検出できませんでした。\n材料欄がはっきり写るように撮り直してみてください。';
var TEXT_EMPTY_MESSAGE = '食材と期限を読み取れませんでした。\n「豆乳は2027年2月21日」のように、食材名と日付を続けて送ってください。';

// ---------------------------------------------------------------- 接頭辞コマンド

/**
 * 「期限登録 牛乳 9月10日」のように、先頭で操作を宣言してもらう形。
 * リッチメニューを押すと接頭辞が入力欄に差し込まれる（postback の fillInText）。
 * 種別が確定するので intent の推定が要らなくなり、「牛乳買った（買い物リスト）」と
 * 「牛乳使った（在庫の消費）」の取り違えが起きない。
 *
 * 押しただけで送信されるわけではなく、続きを打って自分で送信する。
 * 接頭辞を消して送ることもできるので、従来どおりの自由入力も残る。
 *
 * ボタンの見出しと差し込む語は同じにしてある。トークに残る自分の発言と
 * 押したボタンが一致するので、後から履歴を見て何をしたのか分かる。
 *
 * 接頭辞として認める語。リッチメニューが差し込む語のほかに、手打ちしそうな
 * 言い方も拾う。RICHMENU_CELLS の語は必ずここに含めること（testConfig で検査）
 */
var COMMAND_WORDS = {
  '期限登録': 'register',
  '登録': 'register',
  '使用済': 'consume',
  '使った': 'consume',
  '消費': 'consume',
  '破棄済': 'consume',
  '捨てた': 'consume',
  '破棄': 'consume',
  '在庫確認': 'stock_check',
  '買い物リスト追加': 'shop_add',
  '買い物追加': 'shop_add',
  '買い物リスト削除': 'shop_bought',
  '買った': 'shop_bought',
  '購入': 'shop_bought'
};

// ボタンだけ押して中身を書かずに送られたときの案内
var COMMAND_HINTS = {
  register: '「期限登録 牛乳 9月10日」のように、食材名と期限を続けて送ってください。',
  consume: '「使用済 牛乳」のように、使った食材名を続けて送ってください。',
  stock_check: '「在庫確認 醤油、みりん」のように、確認したい食材名を続けて送ってください。',
  shop_add: '「買い物リスト追加 牛乳と卵」のように、買うものを続けて送ってください。',
  shop_bought: '「買い物リスト削除 牛乳」のように、買ってきたものを続けて送ってください。'
};

/**
 * 接頭辞つきの入力を {action, rest} に分解する。接頭辞がなければ null。
 * 区切りの空白を必須にしているので、「買ったよ牛乳」のような地の文は拾わない。
 */
function parseCommand_(text) {
  var m = String(text).trim().match(/^([^\s　:：]+)(?:[\s　:：]+([\s\S]+))?$/);
  if (!m) return null;

  var action = COMMAND_WORDS[m[1]];
  if (!action) return null;

  // ボタンを押しただけで送ると接頭辞だけが届く。案内を返せるよう rest は空で通す
  return { action: action, rest: (m[2] || '').trim() };
}

/** 在庫から消す食材を Claude に特定させ、消費として記録する */
function runConsumeCommand_(text) {
  var items = parseItemNames_(text);
  if (!items.length) return '対象の食材を読み取れませんでした。';

  return consumeItems_(items.map(function (it) {
    return { item_name: it.name, quantity: it.quantity };
  }));
}

/**
 * 接頭辞で種別が確定した入力を処理する。
 * 種別は押されたボタンで決まっているので、品名の特定だけを Claude に任せる。
 */
function runCommand_(cmd) {
  if (!cmd.rest) return COMMAND_HINTS[cmd.action];

  if (cmd.action === 'consume') {
    return runConsumeCommand_(cmd.rest);
  }

  var result = parseTextExpiry_(cmd.rest);
  var items = (result && result.items) || [];
  if (!items.length) return TEXT_EMPTY_MESSAGE;

  return registerItems_(items, 'テキスト');
}

// ---------------------------------------------------------------- レシピのリンク

// リンクだけが送られてきたとき、どこまで遡って写真と結びつけるか。
// 「リールを共有 → すぐスクショ」を続けてやる想定なので短く取る。
// 預かっていることは返信と材料バブルの両方に出るので、過ぎたかどうかは見て分かる
var RECIPE_LINK_WINDOW_MS = 5 * 60 * 1000;

var LINK_OFF_PREFIX = 'link_off:';   // 材料バブルから、その照合の紐づけを外す

var WAITING_LINK_KEY = 'WAITING_LINK';

/**
 * Instagram のリンクだけが書かれたメッセージか。そうならURLを返す。
 *
 * リンクらしきものを何でも拾うと、別の用途で貼ったURLまで材料に結びついてしまう。
 * 宛先を Instagram に絞り、前後に言葉が付いていないものだけを見る
 * （「これ作りたい https://... 」のような文は、材料の話ではないことがあるため）
 */
function parseRecipeLink_(text) {
  var t = String(text || '').trim();
  if (/\s/.test(t)) return '';   // URL 単体のみ

  var m = /^https?:\/\/(www\.)?instagram\.com\/(reel|reels|p|tv|share)\/[\w\-./?=&%]+$/i.exec(t);
  return m ? t : '';
}

/** 写真より先に届いたリンクの置き場。人ごとに1つだけ、しばらく取っておく */
function saveWaitingLink_(url) {
  PropertiesService.getScriptProperties().setProperty(userKey_(WAITING_LINK_KEY),
    JSON.stringify({ url: url, at: Date.now() }));
}

/** 取り出したら消す。古いものは無かったことにする */
function takeWaitingLink_() {
  var props = PropertiesService.getScriptProperties();
  var key = userKey_(WAITING_LINK_KEY);
  var raw = props.getProperty(key);
  if (!raw) return '';

  props.deleteProperty(key);
  try {
    var saved = JSON.parse(raw);
    if (Date.now() - saved.at > RECIPE_LINK_WINDOW_MS) return '';
    return saved.url || '';
  } catch (err) {
    return '';
  }
}

/** 文末の改行を落とす。前置きの断り書きを1通のメッセージとして送るとき用 */
function stripTrailingNewlines_(text) {
  return String(text || '').replace(/\n+$/, '');
}

/**
 * 送られてきたリンクの受け口。預かって、次に来る写真1回ぶんにだけ使う。
 *
 * 前に送った写真には遡らない。「リンクを送る → その次の写真」だけが結びつくと
 * 決めておくほうが、どれに付いたのかを取り違えずに済む。
 * 使ったら捨てるので、そのあとの写真にも付かない（takeWaitingLink_）
 */
function replyRecipeLink_(replyToken, url) {
  saveWaitingLink_(url);
  replyText_(replyToken, '🔗 リンクを受け取りました。続けてレシピの写真を送ってください。');
}

/**
 * その照合に付いたリンクを外す。返り値は本人に返す文面。
 *
 * 違うレシピのリンクが付いたまま材料を足してしまったときの戻し口。
 * これから足す分に付かなくなるだけでなく、すでに足した品目からも外す。
 * レシピシートの行はそのまま残す（消すと、同じリンクを使い回している
 * ほかの品目からも消えてしまうため）
 */
function detachRecipeLink_(token) {
  var set = findAddSet_(token);
  if (!set) return ADD_SET_STALE_MESSAGE;
  if (!set.url && !set.recipeId) return 'この一覧にリンクは付いていません。';

  var cleared = shopSetRecipe_(set.shopIds || [], '');
  updateAddSet_(token, { url: '', recipeId: '' });

  return 'リンクの紐づけを外しました。'
    + (cleared ? '\n買い物リストの' + cleared + '件からも外しました。' : '')
    + '\nこの一覧から足す分には、もう付きません。';
}

/** 指定した買い物リストの品目に、レシピIDを書き入れる。書けた件数を返す */
function shopSetRecipe_(shopIds, recipeId) {
  // recipeId が空のときは消しに来ている（紐づけを外す）ので、そのまま進む
  if (!shopIds.length) return 0;

  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var want = {};
  shopIds.forEach(function (id) { want[String(id)] = true; });

  var ids = sh.getRange(2, SHOP_COL.ID, last - 1, 1).getValues();
  var n = 0;
  for (var i = 0; i < ids.length; i++) {
    if (!want[String(ids[i][0])]) continue;
    sh.getRange(i + 2, SHOP_COL.RECIPE).setValue(recipeId);
    n++;
  }
  return n;
}

/** 買い物リストへ入れた品目の ID を控えに足す。あとからリンクが来たときに遡るため */
function rememberShopIds_(set, ids) {
  if (!set || !ids || !ids.length) return;
  updateAddSet_(set.token, { shopIds: (set.shopIds || []).concat(ids.map(String)) });
}

/**
 * 配色を指す言い方かどうか。'dark' / 'light' / null を返す。
 *
 * 「白菜」「白ワイン」のような品名を巻き込まないよう、完全一致だけを見る。
 * 「白」「黒」の一語も、それ単独で送られたときは配色の指定と見てよい
 * （品名なら「白 卵」のように続きが付くか、接頭辞コマンドで来る）。
 */
function parseThemeCommand_(text) {
  var t = String(text || '').trim().replace(/\s+/g, ' ');
  if (['白', '表示 白', '色 白', '白基調', 'ライト', 'light'].indexOf(t) >= 0) return 'light';
  if (['黒', '表示 黒', '色 黒', '黒基調', 'ダーク', 'dark'].indexOf(t) >= 0) return 'dark';
  return null;
}

/** 配色を覚え、リッチメニューも同じほうへ貼り替える。返り値は本人に返す文面 */
function applyTheme_(theme) {
  setUserTheme_(theme);
  var name = theme === 'light' ? '白基調' : '黒基調';

  var note = '';
  try {
    if (!linkRichMenuForUser_(CURRENT_USER_)) {
      note = '\n\n※ リッチメニューはまだ2種類そろっていません。'
        + '\nGASエディタで setupRichMenu() を実行すると、メニューも切り替わるようになります。';
    }
  } catch (err) {
    console.error('リッチメニューの貼り替えに失敗: ' + err.stack);
    note = '\n\n※ メニューの画像だけ切り替えられませんでした。\n' + err.message;
  }

  return '配色を' + name + 'に変えました。'
    + '\nこれから送るバブルに反映されます（送信済みのものは変わりません）。'
    + '\nメニューはトークを開き直すと入れ替わります。'
    + '\n\n戻すときは「' + (theme === 'light' ? '黒' : '白') + '」と送ってください。'
    + note;
}

function handleText_(event, text) {
  // Claude を呼ばずに済む固定コマンドは先に処理する
  if (text === 'リンク' || text === 'link') {
    replyText_(event.replyToken, '買い物リストと在庫の画面:\n' + webUrl_()
      + '\n\n開けないときはこちら:\n' + webDirectUrl_());
    return;
  }
  if (!text || text === 'ヘルプ' || text === 'help' || text === '使い方') {
    replyText_(event.replyToken, HELP_MESSAGE);
    return;
  }
  // 質問を返している最中なら、その回答として先に受ける
  var note = '';
  var pending = getPending_();
  if (pending) {
    if (isCancelWord_(text)) {
      replyText_(event.replyToken, cancelPending_());
      return;
    }
    // 保留する質問は登録の重複確認だけ（消費の選択はバブルのボタンで受ける）
    var answer = parseRegisterAnswer_(text);
    if (answer !== null) {
      replyText_(event.replyToken, resolveRegister_(answer));
      return;
    }
    // 回答と解釈できない入力が来たら質問を打ち切る。
    // 黙って捨てると「答えたのに無視された」ように見えるので、必ず断りを入れる。
    clearPending_();
    note = '（先ほどの重複確認は取り消しました。登録していません）\n\n';
  }

  if (text === '取消' || text === '取り消し' || text === 'とりけし') {
    replyText_(event.replyToken, note + undoLast_());
    return;
  }
  // 配色の切り替え。品名と紛れないよう、決め打ちの言い方だけを受ける
  var theme = parseThemeCommand_(text);
  if (theme) {
    replyText_(event.replyToken, note + applyTheme_(theme));
    return;
  }
  // レシピのリンク。材料としては読まず、直近の材料確認に結びつける
  var link = parseRecipeLink_(text);
  if (link) {
    if (note) pushText_(stripTrailingNewlines_(note));
    replyRecipeLink_(event.replyToken, link);
    return;
  }
  // 接頭辞で種別が宣言されていれば、推定せずそのとおりに処理する
  var cmd = parseCommand_(text);
  if (cmd) {
    try {
      // 買い物リストの操作と在庫確認はバブルで返すので、文字列を組み立てる経路には乗せない
      if (cmd.action === 'shop_add' && cmd.rest) {
        replyShopAdd_(event.replyToken, note, parseItemNames_(cmd.rest));
      } else if (cmd.action === 'shop_bought' && cmd.rest) {
        var told = parseItemNames_(cmd.rest);
        if (told.length) {
          replyShopBought_(event.replyToken, note, told.map(function (it) { return it.name; }));
        } else {
          replyText_(event.replyToken, note + '品名を読み取れませんでした。');
        }
      } else if (cmd.action === 'stock_check' && cmd.rest) {
        var asked = parseItemNames_(cmd.rest);
        if (asked.length) {
          replyStockCheck_(event.replyToken, note, asked);
        } else {
          replyText_(event.replyToken, note + '品名を読み取れませんでした。');
        }
      } else {
        replyText_(event.replyToken, prefixReply_(note, runCommand_(cmd)));
      }
    } catch (err) {
      console.error('接頭辞コマンドの処理に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
    }
    return;
  }

  // 買い物リストの操作は言い回しが定型なので、種別の判定は API を使わずに済む。
  // 品名の特定だけ Claude に任せる（parseItemNames_）
  if (SHOP_LIST_CMD.test(text)) {
    replyShopList_(event.replyToken, note);
    return;
  }
  if (SHOP_CLEAR_CMD.test(text)) {
    replyText_(event.replyToken, note + shopClear_());
    return;
  }
  var shopAdd = parseShopAddFast_(text);
  if (shopAdd) {
    try {
      replyShopAdd_(event.replyToken, note, parseItemNames_(shopAdd));
    } catch (err) {
      console.error('買い物リストへの追加に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
    }
    return;
  }
  var bought = text.replace(/[。．!！]/g, '').trim().match(BOUGHT_VERB);
  if (bought) {
    try {
      var boughtItems = parseItemNames_(bought[1]);
      if (boughtItems.length) {
        replyShopBought_(event.replyToken, note, boughtItems.map(function (it) { return it.name; }));
      } else {
        replyText_(event.replyToken, note + '品名を読み取れませんでした。');
      }
    } catch (err) {
      console.error('買い物リストからの削除に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
    }
    return;
  }

  // 「牛乳使った」のような言い方も、種別は正規表現で決まる。品名だけ Claude に任せる
  var fast = parseConsumeFast_(text);
  if (fast) {
    try {
      replyText_(event.replyToken,
        prefixReply_(note, runConsumeCommand_(fast.text)));
      return;
    } catch (err) {
      console.error('消費処理に失敗: ' + err.stack);
      replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
      return;
    }
  }

  try {
    var result = parseTextExpiry_(text);
    var intent = (result && result.intent) || 'unknown';
    var items = (result && result.items) || [];

    var names = items.map(function (it) { return it.item_name; })
      .filter(function (n) { return n; });

    if (intent === 'shop_list') {
      replyShopList_(event.replyToken, note);
      return;
    }
    if (intent === 'shop_clear') {
      replyText_(event.replyToken, note + shopClear_());
      return;
    }
    if (intent === 'shop_add' && names.length) {
      var shopItems = items
        .filter(function (it) { return it.item_name; })
        .map(function (it) { return { name: it.item_name, category: it.category }; });
      replyShopAdd_(event.replyToken, note, shopItems);
      return;
    }
    if (intent === 'shop_bought' && names.length) {
      replyShopBought_(event.replyToken, note, names);
      return;
    }
    // 「捨てた」も消費として記録する。使ったか捨てたかで在庫の扱いは変わらない
    if (intent === 'consume' || intent === 'discard') {
      replyText_(event.replyToken, prefixReply_(note, consumeItems_(items)));
      return;
    }
    if (intent === 'register' && items.length) {
      replyText_(event.replyToken, prefixReply_(note, registerItems_(items, 'テキスト')));
      return;
    }
    replyText_(event.replyToken, note + TEXT_EMPTY_MESSAGE);
  } catch (err) {
    console.error('テキスト処理に失敗: ' + err.stack);
    replyText_(event.replyToken, note + '処理に失敗しました。\n' + err.message);
  }
}

// ---------------------------------------------------------------- LINE API

/** メッセージ ID から画像バイナリを取得し base64 にする */
function fetchLineImage_(messageId) {
  var res = UrlFetchApp.fetch(
    'https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content',
    {
      method: 'get',
      headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
      muteHttpExceptions: true
    }
  );

  if (res.getResponseCode() !== 200) {
    throw new Error('LINE から画像を取得できません (HTTP ' + res.getResponseCode() + ')');
  }

  var blob = res.getBlob();
  var bytes = blob.getBytes();
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('画像が大きすぎます (' + Math.round(bytes.length / 1024 / 1024 * 10) / 10 + 'MB)。'
      + 'カメラの解像度を下げるか、期限表示部分を拡大して撮り直してください。');
  }

  var mimeType = blob.getContentType() || 'image/jpeg';
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(mimeType) < 0) {
    mimeType = 'image/jpeg';
  }

  return { base64: Utilities.base64Encode(bytes), mimeType: mimeType };
}

// Quick Reply のボタン数の上限（LINE 仕様）
var QUICK_REPLY_MAX = 13;

/**
 * 返信の中身。文字列だけの返信と、ボタン付きの返信を同じ形で扱う。
 * ボタンを押すと label と同じテキストが送られてくるので、
 * 受け側（parseRegisterAnswer_ など）は手入力と区別せずそのまま処理できる。
 */
function asReply_(reply) {
  return typeof reply === 'string' ? { text: reply, labels: null } : reply;
}

/** 返信の本文。バブルだけの返信は text を持たないので空文字にそろえる */
function replyBody_(r) {
  return typeof r.text === 'string' ? r.text : '';
}

/** 返信の先頭に断り書きを足す。ボタンはそのまま保つ */
function prefixReply_(note, reply) {
  var r = asReply_(reply);
  if (!note) return r;
  // バブル付きの返信でも、断り書きを前のテキストに残す
  return { text: note + replyBody_(r), labels: r.labels, altText: r.altText, flex: r.flex };
}

/**
 * 候補の番号など、押すとその文字列がそのまま送信されるボタンを組み立てる。
 * 常設のコマンドはリッチメニュー側に移したので、ここは質問への回答専用。
 */
function buildQuickReply_(labels) {
  return {
    items: labels.slice(0, QUICK_REPLY_MAX).map(function (label) {
      var s = String(label);
      return {
        type: 'action',
        action: { type: 'message', label: s.substring(0, 20), text: s }
      };
    })
  };
}

/**
 * 返信トークンで返す。reply は文字列または {text, labels}。
 * ボタンは質問を返すときだけ付く（labels を指定した場合のみ）。
 */
function replyText_(replyToken, reply) {
  if (!replyToken) return;

  var r = asReply_(reply);
  var body = replyBody_(r);
  var messages = [];

  // 本文があるときだけテキストを付ける（空文字を送ると LINE の API がエラーになる）
  if (body) {
    var message = { type: 'text', text: body.substring(0, 4900) };
    if (r.labels && r.labels.length) message.quickReply = buildQuickReply_(r.labels);
    messages.push(message);
  }
  if (r.flex) {
    messages.push({ type: 'flex', altText: String(r.altText || 'お知らせ').substring(0, 400), contents: r.flex });
  }
  if (!messages.length) return;

  replyMessages_(replyToken, messages);
}

// インジケータの最大表示秒数。5の倍数（5〜60）。返信を送った時点で消える
var LOADING_SECONDS = 20;

/**
 * トークに「…」のローディング表示を出す。
 * Claude やスプレッドシートを見に行く間、反応が無いように見えるのを防ぐだけで、
 * 応答が速くなるわけではない。表示だけの機能なので、失敗しても本筋は止めない。
 * 1対1のトーク専用（chatId にユーザーID を渡す）。
 */
function showLoading_(userId) {
  if (!userId) return;

  try {
    var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/chat/loading/start', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
      payload: JSON.stringify({ chatId: userId, loadingSeconds: LOADING_SECONDS }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 202) {
      console.warn('ローディング表示に失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
    }
  } catch (err) {
    console.warn('ローディング表示に失敗: ' + err.message);
  }
}

/** Flex メッセージ1件で返信する。altText は通知やトーク一覧に出る代替テキスト */
function replyFlexMessage_(replyToken, altText, contents) {
  replyMessages_(replyToken, [{ type: 'flex', altText: String(altText).substring(0, 400), contents: contents }]);
}

/** reply API の共通呼び出し。messages は1〜5件の LINE メッセージオブジェクト */
function replyMessages_(replyToken, messages) {
  if (!replyToken || !messages || !messages.length) return;

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: messages
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.error('LINE reply 失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

// ---------------------------------------------------------------- Claude API

var RECIPE_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    item_name: { type: 'string', description: '材料名。分量や下ごしらえの指示は含めない。書かれたままの表記でよい（変換しない）。読み取れなければ空文字' },
    // 分量は買い物リストにそのまま載せる。単位まで含めて書かれたとおりに取る
    amount: { type: 'string', description: '材料名に添えられた分量。書かれたまま単位ごと。例:「大さじ2」「200g」「1/2個」「少々」。書かれていなければ空文字' },
    // 材料確認のバブルから買い物リストに入れられるようにしたので、区分もここで判定させる
    // （あとから分類し直すと、ボタンを押してから返信までが遅くなる）
    category: { type: 'string', description: '区分。次のいずれか1つ: ' + CATEGORIES.join(' / ') },
    confidence: { type: 'string', description: '"high" | "medium" | "low"' },
    note: { type: 'string', description: '判断に迷った点があれば日本語で1文。なければ空文字' }
  },
  required: ['item_name', 'amount', 'category', 'confidence', 'note'],
  additionalProperties: false
};

var RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    // 料理名。買い物リストに残すリンクの見出しに使う。
    // 材料の読み取りと同じ1回の呼び出しで取るので、API の往復は増えない
    dish_name: {
      type: 'string',
      description: '料理名。写真に見当たらなければ空文字'
    },
    items: {
      type: 'array',
      description: '材料欄に書かれている食材・調味料ごとに1要素',
      items: RECIPE_ITEM_SCHEMA
    }
  },
  required: ['items'],
  additionalProperties: false
};

var TEXT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    item_name: { type: 'string', description: '食材名。明らかな音声誤認識は妥当な食材名に訂正する。内容量や型番は含めない' },
    category: { type: 'string', description: '区分。次のいずれか1つ: ' + CATEGORIES.join(' / ') + '。intent が register または shop_add のときだけ判定し、それ以外は空文字でよい' },
    quantity: { type: 'number', description: '個数。「2個買った」のように明示された場合のみその数。述べられていなければ 1' },
    found: { type: 'boolean', description: 'この食材の期限を特定できたか' },
    label: { type: 'string', description: '「賞味期限」か「消費期限」のいずれか。消費期限と明示された場合のみ「消費期限」、それ以外は「賞味期限」' },
    date: { type: 'string', description: 'YYYY-MM-DD 形式。特定できなければ空文字' },
    date_precision: { type: 'string', description: '"day" | "month" | "none"' },
    raw_text: { type: 'string', description: '入力文のうち、この食材に対応する部分をそのまま抜き出したもの' },
    confidence: { type: 'string', description: '"high" | "medium" | "low"' },
    note: { type: 'string', description: '訂正した内容や判断に迷った点を日本語で1文。なければ空文字' }
  },
  required: ['item_name', 'category', 'quantity', 'found', 'label', 'date', 'date_precision', 'raw_text', 'confidence', 'note'],
  additionalProperties: false
};

var TEXT_EXPIRY_SCHEMA = {
  type: 'object',
  properties: {
    intent: {
      type: 'string',
      description: '"register"（期限の登録）| "consume"（食べた・使った）| "discard"（捨てた）'
        + '| "shop_add"（買い物リストに追加）| "shop_bought"（買ったのでリストから外す）'
        + '| "shop_clear"（買い物リストを空に）| "shop_list"（買い物リストを見る）| "unknown"'
    },
    items: {
      type: 'array',
      description: '入力文に登場した食材ごとに1要素。登場順に並べる',
      items: TEXT_ITEM_SCHEMA
    }
  },
  required: ['intent', 'items'],
  additionalProperties: false
};

/** 今日の日付を「2026-09-06（日）」形式で返す */
function todayJst_() {
  var now = new Date();
  var ymd = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  var wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(ymd + 'T00:00:00+09:00').getDay()];
  return ymd + '（' + wd + '）';
}

function buildTextPrompt_(text) {
  return [
    'ユーザーが食材について口頭で述べた文を解析してください。',
    '',
    '今日は ' + todayJst_() + '（日本時間）です。',
    '',
    'まず intent を判定してください:',
    '- "register" … 食材の期限を登録しようとしている。例「豆乳は2027年2月21日」「納豆明日まで」',
    '- "consume"  … 食べた・使った・飲んだと報告している。例「牛乳使った」「ヨーグルト食べた」',
    '- "discard"  … 捨てた・処分したと報告している。例「豆腐捨てた」「傷んでたので処分した」',
    '  consume と discard は在庫から消す点で同じ扱いになります。迷ったら consume で構いません。',
    '- "shop_add"    … 買い物リストに入れたい。例「買い物リストに牛乳と卵を追加」「パン買っておきたい」',
    '- "shop_bought" … 買ってきたのでリストから外す。例「牛乳買った」「卵は買えた」',
    '- "shop_clear"  … 買い物リストを空にする。例「買い物リスト全部消して」',
    '- "shop_list"   … 買い物リストを見たい。例「買い物リスト見せて」「何買うんだっけ」',
    '- "unknown"     … 上記のいずれでもない、または食材が読み取れない',
    '',
    '在庫と買い物リストは別物です。次の違いに注意してください。',
    '- 「牛乳使った」「牛乳食べた」… 手持ちを消費した → consume',
    '- 「牛乳買った」          … 買ってきた → shop_bought（在庫への登録ではありません）',
    '- 「牛乳は9月10日」        … 期限を伝えている → register',
    'shop_add / shop_bought では品名だけを items に入れ、date は空文字にしてください。',
    '',
    '区分（category）について:',
    '- intent が register または shop_add のときだけ、次の7つから1つを選んで category に入れてください: '
      + CATEGORIES.join(' / '),
    '- 迷ったときの目安: 豆腐・納豆・こんにゃくなどの日配品は「卵・乳製品」、乾物・缶詰・冷凍食品は「主食・加工食品」。',
    '- それ以外の intent（consume / discard / shop_bought など）では category は空文字にしてください。',
    '',
    'consume / discard の場合は、対象の食材名だけを items に入れてください。',
    'その場合 date は空文字、found は false のままで構いません（日付が述べられていればその日付を入れてください）。',
    '個数が述べられていれば quantity に入れてください。例:「片栗粉2つ捨てた」→ quantity=2。',
    '「全部」「すべて」と言われた場合は quantity=99 にしてください（該当する在庫すべての意味）。',
    'なお 99 を使うのは consume / discard のときだけです。register では実際に買った個数だけを入れてください。',
    '',
    'register の場合は、以下に従って期限日を特定してください。',
    '',
    '入力文はスマートフォンの音声入力で作られている前提です。次の特徴を考慮してください。',
    '',
    '文の区切りについて:',
    '- 句読点がなく、複数の食材が切れ目なく続くことがあります。',
    '- 「次に」「そして」「あと」「それから」「えーと」などのつなぎ言葉やフィラーは区切りとして扱い、食材名には含めないでください。',
    '- 例:「豆乳は2027年2月21日次にヨーグルトは2026年9月17日そして生クリームは2026年9月14日」',
    '  → 豆乳=2027-02-21、ヨーグルト=2026-09-17、生クリーム=2026-09-14 の3件。',
    '  「日次に」を日付の一部と誤解しないこと。',
    '',
    '誤認識の訂正について:',
    '- 音声入力では同音異義語の誤変換が起こります。食材の文脈に照らして明らかにおかしい語は、妥当な食材名に訂正してください。',
    '  例:「投入」→「豆乳」、「牛乳」の誤変換としての「給料」、「納豆」→「何と」、「卵」→「玉子」（これは訂正不要）。',
    '- 訂正した場合は note に「『投入』を『豆乳』と解釈」のように記し、confidence を "medium" にしてください。',
    '- 食材名として解釈できるか自信が持てない場合も、item_name は最も可能性の高い食材名にし、confidence を "low" にしてください。',
    '- 言い直しがある場合は後に述べた方を採用してください。例:「牛乳は8月3日いや13日」→ 8月13日。',
    '- 内容量や個数を述べられても item_name には含めないでください。例:「牛乳1リットル」→「牛乳」。',
    '- 個数が明示された場合は quantity に入れてください。例:「牛乳を2個買った」→ quantity=2。',
    '  「2個」「2本」「2つ」「2パック」などが対象です。内容量（1リットル、400g）は個数ではないので quantity=1 のままにしてください。',
    '  個数が述べられていなければ quantity は 1 にしてください。',
    '',
    '日付の解釈について:',
    '- 年が省略された場合（例「9月17日」「8/3」）は、今日以降で最も近い年を補ってください。',
    '- 相対表現を解決してください。「今日」「明日」「明後日」「3日後」「今週末」「来週の水曜」「今月末」など。',
    '- 「〜まで」「〜が期限」などの言い回しは期限日を指します。',
    '- label は「賞味期限」か「消費期限」のどちらかです。取り違えると安全性の判断が変わるため慎重に扱ってください。',
    '  「消費期限」と明示された場合のみ label を "消費期限" にします。「消費」「消費期限が」「消費の方」なども同じ扱いです。',
    '  それ以外はすべて "賞味期限" にしてください。何も言われていない場合も "賞味期限" です。',
    '  例:「牛乳は消費期限が9月10日」→ label="消費期限"',
    '  例:「豆腐、消費期限明日まで」→ label="消費期限"',
    '  例:「味噌は9月30日」→ label="賞味期限"',
    '  1つの発話に複数の食材がある場合、ラベルは食材ごとに判断してください。',
    '  例:「牛乳は消費期限9月10日、味噌は9月30日」→ 牛乳="消費期限"、味噌="賞味期限"',
    '  「消費期限」という語が1つの食材に付いていても、他の食材まで消費期限にしないこと。',
    '- 月までしか述べられていない場合（例「10月くらい」）は、その月の末日を date に入れ date_precision を "month"、confidence を "low" にしてください。',
    '- 日付をまったく特定できない食材は、items から省かずに found を false、date を空文字で入れてください。推測で日付を作らないこと。',
    '  「水」「米」「塩」のように期限を言われなかったものも同じです。常にあるものとして登録されるので、',
    '  それらしい期限を補う必要はありません。',
    '',
    '- 食材名が読み取れていれば、期限が述べられていなくても items に入れてください（found=false、date は空文字）。',
    '  期限のないものは「常にあるもの」として登録されるので、items から外さないでください。',
    '  例:「砂糖」だけ → item_name="砂糖"、found=false、date=""。',
    '',
    'items を空の配列にするのは、食材名がひとつも読み取れないときだけです。',
    '',
    '--- 入力文 ---',
    text
  ].join('\n');
}

function buildRecipePrompt_() {
  return [
    '料理レシピの写真から、材料欄に書かれている食材・調味料をすべて読み取ってください。',
    '',
    '対象外にするもの:',
    '- 作り方の手順、コラム、広告など材料欄以外の文章',
    '- ページ全体のタイトルや料理名（材料そのものではないため）',
    '',
    '料理名（dish_name）:',
    '- 材料の一覧とは別に、その料理の名前を dish_name に入れてください。',
    '- 「〇〇の作り方」「簡単！」のような飾りは落とし、料理名だけにしてください。',
    '- 写真に料理名が見当たらなければ空文字にしてください（推測で作らない）。',
    '',
    '材料名（item_name）の書き方:',
    '- 分量（大さじ1、200g、2個、少々 など）は含めないでください。',
    '- 「みじん切り」「薄切り」「常温に戻す」などの下ごしらえの指示は含めないでください。',
    '- 「A」「合わせ調味料」のようなグループ見出し自体は無視し、その中身の食材だけを列挙してください。',
    '- 表記はレシピに書かれたままにしてください（かなを漢字にするなどの変換はしない）。',
    '',
    '分量（amount）の書き方:',
    '- 材料名に分量が添えられていれば、単位まで書かれたとおりに amount に入れてください。',
    '  例:「砂糖 大さじ2」→ item_name「砂糖」/ amount「大さじ2」',
    '  例:「たまねぎ 1/2個」→ item_name「たまねぎ」/ amount「1/2個」',
    '- 「少々」「適量」「お好みで」も分量として入れてください。',
    '- 分量が書かれていなければ空文字にしてください（推測で補わない）。',
    '',
    '区分（category）は ' + CATEGORIES.join(' / ') + ' から1つ選んでください。',
    '',
    '確信が持てない場合:',
    '- 手書き文字がかすれている、印刷が不鮮明、複数の候補が考えられるなどで自信が持てない場合は',
    '  confidence を "low" にし、note に理由を書いてください。',
    '- 材料欄が見当たらない、または読み取れる食材が1つもない場合は items を空の配列にしてください。'
  ].join('\n');
}

/** Claude Vision に画像を投げてレシピの材料一覧を JSON で取得する */
function extractRecipeItems_(base64Image, mimeType) {
  return callClaude_([
    { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
    { type: 'text', text: buildRecipePrompt_() }
  ], RECIPE_SCHEMA, MODEL_VISION);
}

/** テキスト（音声入力を含む）を解析して期限情報を JSON で取得する */
function parseTextExpiry_(text) {
  return callClaude_([
    { type: 'text', text: buildTextPrompt_(text) }
  ], TEXT_EXPIRY_SCHEMA, MODEL_TEXT);
}

var NAMES_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      description: '述べられた品名ごとに1要素。登場順に並べる',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '品名。個数・内容量・助詞は含めない' },
          category: { type: 'string', description: '区分。次のいずれか1つ: ' + CATEGORIES.join(' / ') },
          quantity: { type: 'number', description: '個数。述べられていなければ 1。「全部」は 99' },
          note: { type: 'string', description: '訂正や判断に迷った点を日本語で1文。なければ空文字' }
        },
        required: ['name', 'category', 'quantity', 'note'],
        additionalProperties: false
      }
    }
  },
  required: ['items'],
  additionalProperties: false
};

function buildNamesPrompt_(text) {
  return [
    '述べられた食品名を列挙してください。日付や期限は関係ありません。',
    '',
    '入力はスマートフォンの音声入力で作られている前提です。',
    '区切りの記号がないまま品名が続けて並べられることがあります。',
    '',
    '- 例:「牛乳コチュジャンプロテイン」→ 牛乳／コチュジャン／プロテイン の3件',
    '- 例:「牛乳と卵」→ 牛乳／卵 の2件。この「と」は助詞です',
    '- 例:「とうふとうもろこし」→ とうふ／とうもろこし の2件。',
    '  「と」は助詞のこともあれば品名の一部のこともあります。文字面で切らず、',
    '  食品として意味の通る単位で切ってください。',
    '- 1品の長い商品名を無理に分割しないこと。',
    '  例:「ブルガリアヨーグルト」→ 1件。「エクストラバージンオリーブオイル」→ 1件',
    '- 切り出した品名は入力の表記のまま返してください。',
    '  かなを漢字に直すなどの変換はしないこと。例:「とうふ」→「とうふ」（「豆腐」にしない）',
    '  買い物リストと在庫は登録時の表記で照合するため、変換すると見つからなくなります。',
    '- ただし明らかな音声誤認識（同音異義語の誤変換）は訂正し、note に理由を書いてください。',
    '  例:「投入」→「豆乳」。これは表記ゆれの統一とは別物です。',
    '- 品名として読み取れるものがなければ items を空の配列にしてください。',
    '',
    '個数について:',
    '- 個数や内容量は name に含めないでください。例:「牛乳2本」→ name「牛乳」',
    '- 個数が述べられていれば quantity に入れてください。',
    '  「2個」「2本」「2つ」「2パック」などが対象です。',
    '  内容量（1リットル、400g）は個数ではないので quantity は 1 のままにしてください。',
    '- 述べられていなければ quantity は 1 にしてください。',
    '- 「全部」「すべて」と言われた場合は quantity を 99 にしてください。',
    '',
    '区分（category）について:',
    '- 次の7つから1つを選んで category に入れてください: ' + CATEGORIES.join(' / '),
    '- 迷ったときの目安: 豆腐・納豆・こんにゃくなどの日配品は「卵・乳製品」、乾物・缶詰・冷凍食品は「主食・加工食品」。',
    '',
    '--- 入力 ---',
    text
  ].join('\n');
}

/**
 * 文から食品名（と個数）を取り出す。
 * 記号で切ると「とうふ」の「と」まで落ちてしまい、
 * 「牛乳コチュジャンプロテイン」のような区切りなしの並びも切れないため、
 * 品名の特定は Claude に任せている。
 */
function parseItemNames_(text) {
  var result = callClaude_([
    { type: 'text', text: buildNamesPrompt_(text) }
  ], NAMES_SCHEMA, MODEL_TEXT);

  return ((result && result.items) || [])
    .map(function (it) {
      return { name: String(it.name || '').trim(), category: it.category, quantity: it.quantity };
    })
    .filter(function (it) { return it.name; });
}

/** Messages API を叩き、structured output の JSON を返す共通処理 */
function callClaude_(content, schema, model) {
  assertClaudeRate_(); // 課金が青天井にならないよう、回数の上限を先に見る

  var useModel = model || MODEL_VISION;
  var outputConfig = { format: { type: 'json_schema', schema: schema } };

  // effort は Haiku 4.5 では未対応（指定すると 400 になる）。対応モデルのみ付ける。
  // 抽出タスクなので低 effort で十分で、LINE の応答時間短縮にもなる。
  if (useModel.indexOf('haiku') < 0) {
    outputConfig.effort = 'low';
  }

  var payload = {
    model: useModel,
    max_tokens: 8000, // 複数商品を返すため余裕を持たせる
    output_config: outputConfig,
    messages: [{ role: 'user', content: content }]
  };

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': prop_('ANTHROPIC_API_KEY', true),
      'anthropic-version': ANTHROPIC_VERSION
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (res.getResponseCode() !== 200) {
    // 応答本文はそのまま利用者に返さない（内部の事情が混ざるため）。詳しくはログに残す
    console.error('Claude API エラー (HTTP ' + res.getResponseCode() + '): '
      + res.getContentText().substring(0, 500));
    throw new Error('読み取りに失敗しました (HTTP ' + res.getResponseCode() + ')');
  }

  var body = JSON.parse(res.getContentText());

  if (body.stop_reason === 'refusal') {
    throw new Error('リクエストが拒否されました');
  }

  // content 配列から text ブロックを拾って JSON としてパースする
  var text = '';
  for (var i = 0; i < body.content.length; i++) {
    if (body.content[i].type === 'text') text += body.content[i].text;
  }
  if (!text) throw new Error('Claude から応答テキストが返りませんでした');

  console.log('usage: ' + JSON.stringify(body.usage));
  // 返信は簡潔にしているため、判断の根拠（note / raw_text / confidence）はここに残す。
  // ⚠ が付いた理由を調べたいときは実行ログのこの行を見る。
  console.log('result: ' + text);
  return JSON.parse(text);
}

// ---------------------------------------------------------------- 返信文の組み立て

/** 今日から見た残日数 */
function daysLeft_(dateStr) {
  var d = new Date(dateStr + 'T00:00:00+09:00');
  var today = new Date(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd') + 'T00:00:00+09:00');
  return Math.round((d - today) / 86400000);
}

/** 期限が近い順に並べて、見出し付きの一覧テキストにする */
function formatItems_(items, header) {
  var sorted = items.slice().sort(function (a, b) {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  var multi = sorted.length > 1;
  var blocks = sorted.map(function (it, i) {
    return formatItem_(it, multi ? String(i + 1) + '. ' : '');
  });

  return header + '\n\n' + blocks.join('\n\n');
}

/**
 * 1件分を2行に整形する。
 *   1. ヨーグルト
 *   2026-09-17（11日）⚠
 * 末尾の ⚠ は、誤変換の訂正・言い直しの採用・年の補完などで
 * モデルの確度が high でなかったことを示す。理由は実行ログに残る。
 */
function formatItem_(it, prefix) {
  var name = it.item_name || '(食材名不明)';
  if (it.position) name += '［' + it.position + '］';

  if (isAlways_(it)) {
    return prefix + name + '\n常備品（期限なし）';
  }

  if (!it.found || !it.date) {
    return prefix + name + '\n期限を特定できず ⚠';
  }

  var days = daysLeft_(it.date);
  var remain = days < 0 ? days * -1 + '日超過' : days === 0 ? '今日まで' : days + '日';
  var approx = it.date_precision === 'month' ? '頃' : '';
  var warn = it.confidence === 'high' ? '' : ' ⚠';

  return prefix + name + '\n' + labelPrefix_(it.label) + it.date + approx
    + '（' + remain + '）' + warn;
}

// ---------------------------------------------------------------- スプレッドシート操作

/**
 * openById は1回あたり数百ミリ秒かかる。同じ実行の中で何度も開くと
 * そのぶん返信が遅れるので、開いたシートは使い回す。
 * GAS のグローバル変数は実行ごとに作り直されるため、古い参照は残らない。
 */
var SHEET_CACHE_ = null;
var SHOP_SHEET_CACHE_ = null;
var RECIPE_SHEET_CACHE_ = null;

/** 在庫シートを返す。未設定なら手順を添えて落とす */
function sheet_() {
  if (SHEET_CACHE_) return SHEET_CACHE_;

  var id = prop_('SPREADSHEET_ID', false);
  if (!id) {
    throw new Error('記録先が未設定です。GASエディタで setupSpreadsheet を1回実行してください。');
  }
  var sh = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('シート「' + SHEET_NAME + '」が見つかりません');

  SHEET_CACHE_ = sh;
  return sh;
}

/**
 * 記録用スプレッドシートを新規作成し、ID をスクリプトプロパティに保存する。
 * エディタから1回だけ実行する。すでに設定済みなら何もしない。
 */
function setupSpreadsheet() {
  requireEditor_();
  var existing = prop_('SPREADSHEET_ID', false);
  if (existing) {
    console.log('設定済みです: ' + SpreadsheetApp.openById(existing).getUrl());
    return;
  }

  var ss = SpreadsheetApp.create('食材在庫');
  var sh = ss.getSheets()[0].setName(SHEET_NAME);
  sh.getRange(1, 1, 1, COL_COUNT).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // 期限が日付型に自動変換されると扱いにくいので、文字列のまま保持する
  sh.getRange(2, COL.DATE, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  // 「12:55」が時刻値に変換されると読み戻しが面倒になるので文字列で保つ
  sh.getRange(2, COL.REG_TIME, sh.getMaxRows() - 1, 1).setNumberFormat('@');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  PROP_CACHE_ = null;   // 設定値の控えを捨てて、次の prop_ で読み直させる
  console.log('作成しました: ' + ss.getUrl());
}

/**
 * 「区分」列を追加するための一度きりの移行処理。
 * 食材名（列3）の右に新しい列を挿入し、ヘッダー行を今の HEADERS に合わせて書き直す。
 * 在庫データはクリア済み前提で、既存行の値は移し替えない。
 * エディタから1回だけ実行する。
 */
function migrateAddCategoryColumn() {
  requireEditor_();
  var sh = sheet_();
  sh.insertColumnAfter(3);
  sh.getRange(1, 1, 1, COL_COUNT).setValues([HEADERS]).setFontWeight('bold');
  sh.getRange(2, COL.DATE, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  sh.getRange(2, COL.REG_TIME, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  console.log('区分列を追加しました。');
}

/**
 * 買い物リストにも「区分」列を追加する一度きりの移行処理。
 * 品名（列2）の右に新しい列を挿入し、ヘッダー行を今の SHOP_HEADERS に合わせて書き直す。
 * こちらはデータをクリアしていないので、既存行は列がずれるだけで値は保持される
 * （区分だけ空欄のまま残る）。エディタから1回だけ実行する。
 */
function migrateAddShopCategoryColumn() {
  requireEditor_();
  var sh = shopSheet_();
  sh.insertColumnAfter(2);
  sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');
  console.log('買い物リストに区分列を追加しました。');
}

/**
 * 在庫シートの先頭に「ID」列を追加する一度きりの移行処理。
 * バブルの「使った」ボタンが行番号ではなく ID で品目を指すようにするため、
 * 既存行にも上から順に連番を振る。エディタから1回だけ実行する。
 */
function migrateAddStockIdColumn() {
  requireEditor_();
  var sh = sheet_();
  sh.insertColumnBefore(1);
  sh.getRange(1, 1, 1, COL_COUNT).setValues([HEADERS]).setFontWeight('bold');

  var last = sh.getLastRow();
  if (last >= 2) {
    var ids = [];
    for (var i = 0; i < last - 1; i++) ids.push([i + 1]);
    sh.getRange(2, COL.ID, ids.length, 1).setValues(ids);
    PropertiesService.getScriptProperties().setProperty('STOCK_NEXT_ID', String(ids.length + 1));
  }
  console.log('在庫シートにID列を追加しました。');
}

/**
 * 買い物リストの先頭に「ID」列を追加する一度きりの移行処理。
 * postback（買った/全部買ったボタン）が行番号ではなく ID で品目を指すようにするため、
 * 既存行にも上から順に連番を振る。エディタから1回だけ実行する。
 */
function migrateAddShopIdColumn() {
  requireEditor_();
  var sh = shopSheet_();
  sh.insertColumnBefore(1);
  sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');

  var last = sh.getLastRow();
  if (last >= 2) {
    var ids = [];
    for (var i = 0; i < last - 1; i++) ids.push([i + 1]);
    sh.getRange(2, SHOP_COL.ID, ids.length, 1).setValues(ids);
    PropertiesService.getScriptProperties().setProperty('SHOP_NEXT_ID', String(ids.length + 1));
  }
  console.log('買い物リストにID列を追加しました。');
}

/**
 * 買い物リストに「レシピID」列を足す一度きりの移行処理。
 * 写真から足した品目に、出どころのレシピ（料理名とリンク）を結びつけるため。
 * 既存の行は空のままでよい（手で足した品目と同じ扱いになる）。
 * エディタから1回だけ実行する。
 */
function migrateAddShopRecipeColumn() {
  requireEditor_();
  var sh = shopSheet_();
  if (sh.getMaxColumns() < SHOP_COL_COUNT) {
    sh.insertColumnsAfter(sh.getMaxColumns(), SHOP_COL_COUNT - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');
  console.log('買い物リストにレシピID列を追加しました。既存の行は空のままです。');
}

/**
 * 買い物リストに「分量」列を足す一度きりの移行処理。
 * レシピの写真に分量が書かれていたら、そのまま買い物リストに載せるため。
 * 既存の行は空のままでよい。エディタから1回だけ実行する。
 */
function migrateAddShopAmountColumn() {
  requireEditor_();
  var sh = shopSheet_();
  if (sh.getMaxColumns() < SHOP_COL_COUNT) {
    sh.insertColumnsAfter(sh.getMaxColumns(), SHOP_COL_COUNT - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');
  console.log('買い物リストに分量列を追加しました。既存の行は空のままです。');
}

/** Date でも文字列でも 'YYYY-MM-DD' に揃える */
function normalizeYmd_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v).trim();
}

/**
 * 食材名の表記ゆれ辞書。漢字・かな・送り仮名の違いを1つの代表名にまとめる。
 * 左が代表名、右がそれと同じものとして扱う表記。
 * ここに書いた語は文字列一致の段階で解決するので、Claude に問い合わせずに済む。
 * 足りない表記に気づいたら、この表に足せば在庫・買い物リストの両方に効く。
 *
 * 注意:「酢」「塩」のような1〜2文字の語は、買い物リストの照合が部分一致
 * （indexOf）のため別の語に紛れ込みやすい。短すぎる語はここに入れない。
 */
var NAME_SYNONYMS = {
  'かつおぶし': ['鰹節', 'かつお節', '鰹ぶし', 'かつぶし', '削り節', 'けずり節', '花かつお', '花鰹'],
  'たまご': ['卵', '玉子', '鶏卵'],
  'にんじん': ['人参'],
  'たまねぎ': ['玉ねぎ', '玉葱'],
  'じゃがいも': ['じゃが芋', '馬鈴薯'],
  'さつまいも': ['さつま芋', '薩摩芋'],
  'だいこん': ['大根'],
  'はくさい': ['白菜'],
  'きゅうり': ['胡瓜'],
  'なす': ['茄子', 'なすび'],
  'ねぎ': ['葱'],
  'しょうが': ['生姜'],
  'にんにく': ['大蒜'],
  'かぼちゃ': ['南瓜'],
  'ほうれんそう': ['ほうれん草', '法蓮草', '菠薐草'],
  'れんこん': ['蓮根'],
  'ごぼう': ['牛蒡'],
  'たけのこ': ['竹の子', '筍'],
  'とうふ': ['豆腐'],
  'あぶらあげ': ['油揚げ', '油あげ', 'あぶらげ', '薄揚げ'],
  'なっとう': ['納豆'],
  'ぎゅうにゅう': ['牛乳'],
  'とうにゅう': ['豆乳'],
  'ぶたにく': ['豚肉'],
  'ぎゅうにく': ['牛肉'],
  'とりにく': ['鶏肉', '鳥肉'],
  'ひきにく': ['挽肉', 'ひき肉', '挽き肉', 'ミンチ'],
  'しいたけ': ['椎茸'],
  'えのき': ['榎茸', 'えのき茸', 'えのきだけ'],
  'のり': ['海苔'],
  'わかめ': ['若布'],
  'こんぶ': ['昆布'],
  'ごま': ['胡麻'],
  'しょうゆ': ['醤油', '正油'],
  'みそ': ['味噌'],
  'さとう': ['砂糖'],
  'みりん': ['味醂'],
  'こしょう': ['胡椒'],
  'こむぎこ': ['小麦粉'],
  'かたくりこ': ['片栗粉'],
  'はちみつ': ['蜂蜜'],
  'うめぼし': ['梅干し', '梅干'],
  'つけもの': ['漬物', '漬け物'],
  'だし': ['出汁', '出し汁', 'だし汁']
};

var NAME_SYNONYM_MAP_ = null;

/** NAME_SYNONYMS を「表記 → 代表名」の1段の表に開く。初回だけ作って使い回す */
function nameSynonymMap_() {
  if (NAME_SYNONYM_MAP_) return NAME_SYNONYM_MAP_;
  var map = {};
  Object.keys(NAME_SYNONYMS).forEach(function (canon) {
    var key = foldName_(canon);
    map[key] = key;
    NAME_SYNONYMS[canon].forEach(function (v) { map[foldName_(v)] = key; });
  });
  NAME_SYNONYM_MAP_ = map;
  return map;
}

/**
 * 文字の見た目の違いだけを吸収する。
 * 全角英数を半角に（NFKC）、空白・中黒・長音を落とし、カタカナをひらがなに、
 * アルファベットを小文字に揃える。これで「カツオ節」と「かつお節」は同じになる。
 */
function foldName_(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\s　・･\-ー]/g, '')
    .replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); })
    .toLowerCase();
}

/**
 * 食材名の比較用のキー。文字の揺れを foldName_ で均したうえで、
 * 辞書にある表記（鰹節／かつお節など）は代表名に寄せる。
 */
function normalizeName_(s) {
  var key = foldName_(s);
  return nameSynonymMap_()[key] || key;
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

function todayStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

function timeStamp_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'HH:mm');
}

/**
 * 表示に使うラベル。消費期限は「過ぎたら食べない」という安全側の意味を持つので、
 * 賞味期限と取り違えないよう必ず出す。読み取れていない場合は何も付けない。
 */
function labelPrefix_(label) {
  return (label === '賞味期限' || label === '消費期限') ? label + ' ' : '';
}

/** 「商品名（消費期限 2026-09-17・あと11日）」の形にする */
function withDate_(name, date, label) {
  if (!date) return name;
  var d = daysLeft_(date);
  var remain = d < 0 ? (d * -1) + '日超過' : d === 0 ? '今日まで' : 'あと' + d + '日';
  return name + '（' + labelPrefix_(label) + date + '・' + remain + '）';
}

/** シート1行を、表示用のアイテムオブジェクトに変換する */
function rowToItem_(row) {
  return {
    id: String(row[COL.ID - 1] || ''),   // 週次通知のバブルから「使用済」を押すのに使う
    item_name: row[COL.NAME - 1],
    position: '',
    found: true,
    date: normalizeYmd_(row[COL.DATE - 1]),
    date_precision: row[COL.PRECISION - 1],
    label: row[COL.LABEL - 1],
    confidence: row[COL.CONFIDENCE - 1]
  };
}

// ---------------------------------------------------------------- 登録・消費・取消

/** 直前の操作を記録しておき、「取消」で戻せるようにする */
function setLastOp_(op) {
  PropertiesService.getScriptProperties().setProperty(userKey_('LAST_OP'), JSON.stringify(op));
}

function getLastOp_() {
  var s = prop_(userKey_('LAST_OP'), false);
  return s ? JSON.parse(s) : null;
}

/** 種別は「消費期限」と明示されたときだけ消費期限。それ以外はすべて賞味期限に寄せる */
function normalizeLabel_(label) {
  return label === '消費期限' ? '消費期限' : '賞味期限';
}

/**
 * 個数を 1〜max に丸める。誤認識による暴発を防ぐためのもの。
 * 登録は実在する買い物の数なので 20 まで、
 * 消費・破棄は「全部」を 99 で表すので 99 まで許す。
 */
function clampQty_(q, max) {
  var n = parseInt(q, 10);
  if (!n || n < 1) return 1;
  return Math.min(n, max);
}

/**
 * 在庫の品目に振る連番を n 個まとめて確保する。
 * 買い物リストと同じ考え方で、行の並び替えや削除の影響を受けないようにする。
 */
function stockReserveIds_(n) {
  // 読んで足して書くまでを囲う。割り込まれると同じIDを2回配ってしまう
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var next = Number(props.getProperty('STOCK_NEXT_ID')) || (stockMaxId_() + 1);
    props.setProperty('STOCK_NEXT_ID', String(next + n));

    var ids = [];
    for (var i = 0; i < n; i++) ids.push(next + i);
    return ids;
  });
}

function stockMaxId_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var ids = sh.getRange(2, COL.ID, last - 1, 1).getValues();
  var max = 0;
  ids.forEach(function (r) {
    var n = Number(r[0]);
    if (n > max) max = n;
  });
  return max;
}

/** 実際にシートへ追記し、追記した行番号を返す */
function appendRows_(sh, items, source) {
  if (!items.length) return [];

  // 最終行の取得から書き込みまでを囲う。途中で割り込まれると同じ行に重ねて書いてしまう
  return withLock_(function () {
    var startRow = sh.getLastRow() + 1;
    var stamp = nowStamp_();
    var ids = stockReserveIds_(items.length);

    var values = items.map(function (it, idx) {
      var row = new Array(COL_COUNT).fill('');
      row[COL.ID - 1] = ids[idx];
      row[COL.REG_DATE - 1] = todayStamp_();
      row[COL.REG_TIME - 1] = timeStamp_();
      row[COL.NAME - 1] = it.item_name || '(名称不明)';
      row[COL.CATEGORY - 1] = it.category || '';
      row[COL.DATE - 1] = it.date;
      row[COL.PRECISION - 1] = it.date_precision || 'day';
      // 常備品は賞味／消費の別を持たない。空にしないと一覧で期限があるように見える
      row[COL.LABEL - 1] = isAlways_(it) ? '' : normalizeLabel_(it.label);
      row[COL.CONFIDENCE - 1] = it.confidence || 'high';
      row[COL.SOURCE - 1] = source;
      row[COL.RAW - 1] = it.raw_text || '';
      row[COL.STATUS - 1] = STATUS.STOCK;
      row[COL.UPDATED - 1] = stamp;
      return row;
    });

    sh.getRange(startRow, 1, values.length, COL_COUNT).setValues(values);
    // 登録後のバブルの「登録取消」がこの ID で行を探す
    items.forEach(function (it, idx) { it.stock_id = ids[idx]; });
    return values.map(function (_, i) { return startRow + i; });
  });
}

/**
 * 読み取り結果をシートに追記する。
 * 同じ名前・同じ期限の在庫がすでにある場合は勝手に増やさず確認する。
 * ただし「2個買った」と個数が明示されていれば意図した重複なので確認しない。
 */
function registerItems_(items, source) {
  var ok = [];
  var ng = [];

  items.forEach(function (it) {
    if (!(it.found && it.date)) {
      // 日付を言われなかったものは「常にあるもの」として入れる（水・米など）。
      // 期限で追いかけないので、個数を言われても行は1つでよい
      it.date = '';
      it.date_precision = PRECISION_ALWAYS;
      it.label = '';
      ok.push({ item: it, stated: false });
      return;
    }
    // 返信とシートで表示が食い違わないよう、ここで種別を確定させる
    it.label = normalizeLabel_(it.label);
    var qty = clampQty_(it.quantity, 20);
    for (var i = 0; i < qty; i++) {
      ok.push({ item: it, stated: qty > 1 });
    }
  });

  if (!ok.length) {
    return '期限を特定できなかったため登録しませんでした。\n'
      + '日付を添えて送り直してください。';
  }

  var sh = sheet_();
  // 追記する前の在庫と突き合わせる。
  // 同じ写真に同じ商品が2つ写っている場合は実物が2つあるということなので、
  // ここで作った集合には入らず、確認せずどちらも登録される。
  var stockKeys = stockKeySet_(sh);

  var toAdd = [];
  var toConfirm = [];
  ok.forEach(function (e) {
    var key = normalizeName_(e.item.item_name) + '|' + e.item.date;
    if (!e.stated && stockKeys[key]) toConfirm.push(e.item);
    else toAdd.push(e.item);
  });

  return finishRegister_(sh, {
    kind: 'register',
    source: source,
    changed: appendRows_(sh, toAdd, source),
    registered: toAdd,
    confirm: toConfirm,
    ng: ng,
    skipped: 0
  });
}

/** 確認待ちがあれば保留して問い返し、なければ結果を返す */
function finishRegister_(sh, session) {
  if (session.confirm.length) {
    savePending_(session);
    var head = buildRegisterReport_(session, false);
    var q = formatDuplicateQuestion_(session.confirm);
    return head ? { text: head + '\n\n' + q.text, labels: q.labels } : q;
  }

  clearPending_();
  if (session.changed.length) {
    setLastOp_({ type: 'register', rows: session.changed });
  }
  return buildRegisterReport_(session, true) || '登録するものがありませんでした。';
}

/**
 * 登録結果の返信を組み立てる。
 * 最終の返信はバブル（各行に「登録取消」）で返し、※の断り書きがあれば
 * バブルの前にテキストとして添える。
 * 重複確認の質問に添える見出し（isFinal が false）は、質問文と繋げるため
 * 今までどおりテキストのままにする。
 */
function buildRegisterReport_(session, isFinal) {
  var notes = [];
  if (session.ng.length) {
    notes.push('※ 期限が不明で登録できなかったもの: ' + session.ng.join('、'));
  }
  if (isFinal && session.skipped) {
    notes.push('※ 重複として ' + session.skipped + '件は登録しませんでした。');
  }

  if (!isFinal) {
    var parts = [];
    if (session.registered.length) {
      parts.push(formatItems_(session.registered, session.registered.length + '件を登録しました'));
    }
    return parts.concat(notes).join('\n\n');
  }

  if (!session.registered.length) return notes.join('\n\n');

  return {
    text: notes.join('\n\n'),
    altText: '登録しました ' + session.registered.length + '件',
    flex: buildRegisteredBubble_(session.registered)
  };
}

function formatDuplicateQuestion_(confirm) {
  var lines = ['同じものが既に在庫にあります。', ''];
  confirm.forEach(function (it) {
    lines.push('・' + (it.item_name || '(名称不明)') + '（' + it.date + '）');
  });
  lines.push('');
  lines.push('1. 登録する（2つ目を買った）');
  lines.push('2. 登録しない（二重登録だった）');
  lines.push('');
  lines.push('番号でも「登録する」「登録しない」でも答えられます。');
  return {
    text: lines.join('\n'),
    labels: ['登録する', '登録しない', 'やめる']
  };
}

/** 重複確認への回答を処理する */
function resolveRegister_(n) {
  var session = getPending_();
  if (!session || session.kind !== 'register' || !session.confirm.length) {
    clearPending_();
    return '確認の対象がありません。';
  }

  if (n !== 1 && n !== 2) {
    savePending_(session);
    var q = formatDuplicateQuestion_(session.confirm);
    return { text: '1 か 2 で答えてください。\n\n' + q.text, labels: q.labels };
  }

  var sh = sheet_();
  if (n === 1) {
    session.changed = session.changed.concat(appendRows_(sh, session.confirm, session.source));
    session.registered = session.registered.concat(session.confirm);
  } else {
    session.skipped = session.confirm.length;
  }
  session.confirm = [];

  return finishRegister_(sh, session);
}

var LIST_MATCH_SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      description: 'ユーザーが言った品名ごとに1要素',
      items: {
        type: 'object',
        properties: {
          said: { type: 'string', description: 'ユーザーが言った品名（与えられた文字列をそのまま返す）' },
          row: { type: 'number', description: '該当する行番号。該当なしは 0' },
          reason: { type: 'string', description: 'そう判断した理由を日本語で簡潔に' }
        },
        required: ['said', 'row', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['matches'],
  additionalProperties: false
};

/**
 * 文字列一致で見つからなかった品名を、リストと意味で突き合わせる。
 * 在庫は写真から読み取った正式名称になるため「コーヒー」→
 * 「ネスカフェ ゴールドブレンド」のような言い換えを、
 * 買い物リストは「とうふ」→「豆腐」のような表記ゆれを解決する。
 *
 * rows は {row, name} の配列。在庫の場合は date も持たせる。
 */
function matchListByClaude_(names, rows, kind) {
  var isStock = kind === 'stock' || kind === 'recipe';
  var lines = [];

  lines.push(
    kind === 'stock' ? 'ユーザーが「使った」「捨てた」と言った食材が、在庫リストのどれを指すか特定してください。'
      : kind === 'recipe' ? 'レシピの材料が、在庫リストのどれに該当するか特定してください。'
        : 'ユーザーが「買った」と言った品物が、買い物リストのどれを指すか特定してください。');
  lines.push('');
  lines.push(isStock ? '在庫リスト（行番号: 商品名（期限））' : '買い物リスト（行番号: 品名）');
  lines.push(rows.map(function (s) {
    return s.row + ': ' + s.name + (isStock ? '（' + s.date + '）' : '');
  }).join('\n'));
  lines.push('');
  lines.push(kind === 'recipe' ? 'レシピの材料名:' : 'ユーザーが言った品名:');
  lines.push(names.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n'));
  lines.push('');
  lines.push('判断の指針:');

  if (isStock) {
    lines.push(kind === 'recipe'
      ? '- 商品名は写真から読み取った正式名称です。レシピの材料名は一般名・カテゴリ名で書かれています。'
      : '- 商品名は写真から読み取った正式名称です。ユーザーは略称・一般名・カテゴリ名で呼びます。');
    lines.push('  例:「ヨーグルト」→「ダノンビオ」、「コーヒー」→「ネスカフェ ゴールドブレンド」');
    if (kind === 'recipe') {
      lines.push('- 文字面が似ていても別の食材は別物として扱ってください。');
      lines.push('  例:「ごま」と「ごま油」、「醤油」と「めんつゆ」、「小麦粉」と「片栗粉」はそれぞれ別物です。');
    }
  } else {
    lines.push('- リストの品名はユーザー自身が入れたものです。略称や一般名で呼ばれることがあります。');
    lines.push('  例:「ヨーグルト」→「ブルガリアヨーグルト」');
  }

  lines.push('- 表記ゆれは同一とみなしてください。例: 卵/たまご/タマゴ、豆腐/とうふ、人参/にんじん、鰹節/かつお節/かつおぶし');
  if (isStock) {
    lines.push('- 同じ食材が複数該当する場合は、期限が最も近い行を選んでください。');
  }
  lines.push('- 該当がなければ row を 0 にしてください。似ているだけの別のもので代用しないこと。');
  lines.push('  例: ユーザーが「牛乳」と言い、リストに「豆乳」しかない場合は 0 です。');
  lines.push('- 同じ行を複数の品名に割り当てないでください。');

  var result = callClaude_([{ type: 'text', text: lines.join('\n') }],
    LIST_MATCH_SCHEMA, MODEL_TEXT);
  return (result && result.matches) || [];
}

/**
 * matchListByClaude_ の結果から、まだ使っていない行を1つ取り出す。
 * 同じ行を2つの品名に割り当てないよう taken で除く。
 */
function pickMatch_(said, matches, rows, taken) {
  for (var i = 0; i < matches.length; i++) {
    if (matches[i].said !== said || !matches[i].row) continue;
    if (taken.indexOf(matches[i].row) >= 0) return null;
    for (var j = 0; j < rows.length; j++) {
      if (rows[j].row === matches[i].row) return rows[j];
    }
    return null;
  }
  return null;
}

/** 在庫にある「名前|期限」の集合。重複判定に使う */
function stockKeySet_(sh) {
  var keys = {};
  var last = sh.getLastRow();
  if (last < 2) return keys;

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  data.forEach(function (row) {
    if (row[COL.STATUS - 1] !== STATUS.STOCK) return;
    keys[normalizeName_(row[COL.NAME - 1]) + '|' + normalizeYmd_(row[COL.DATE - 1])] = true;
  });
  return keys;
}

/** 在庫（STATUS.STOCK）の行を {row, name, date, precision, label} で返す */
function currentStockRows_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var stock = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] !== STATUS.STOCK) continue;
    stock.push({
      row: i + 2,
      id: data[i][COL.ID - 1],
      name: data[i][COL.NAME - 1],
      date: normalizeYmd_(data[i][COL.DATE - 1]),
      precision: data[i][COL.PRECISION - 1],   // 常備品を見分けるのに要る
      label: data[i][COL.LABEL - 1],
      regDate: normalizeYmd_(data[i][COL.REG_DATE - 1])
    });
  }
  return stock;
}

/**
 * 一致した在庫行の期限・登録日を、元のアイテムに付け足す。
 * 区分は材料確認のバブルから買い物リストに入れるときに使うので落とさない
 */
function withStockInfo_(it, stockRow) {
  return {
    item_name: it.item_name,
    category: it.category || '',
    // 家にあるものも買い足せるので、分量も落とさない
    amount: it.amount || '',
    confidence: it.confidence,
    id: stockRow.id,          // バブルの「使った」ボタンが指す先
    date: stockRow.date,
    date_precision: stockRow.precision,
    label: stockRow.label,
    regDate: stockRow.regDate
  };
}

/**
 * 品名リストが在庫にあるかどうかで {have, missing} に振り分ける。
 * have には一致した在庫行の期限・登録日を付ける。数量は見ない（あるかないかだけ）。
 *
 * 名前の突き合わせは第1段階を完全一致のみとし、それ以外は全部第2段階の
 * 意味照合（matchListByClaude_）に回す。消費・買い物リストの突き合わせと違い、
 * ここは部分一致（indexOf）を使わない。「ごま」が「ごま油」に含まれるからと
 * いって同じ食材とは限らず、部分一致だと別物を誤って「ある」と判定してしまう。
 * Claude の意味照合には元々「似ているだけの別物で代用しない」という指示が
 * 入っているため、そちらに任せる。レシピ照合・在庫確認の両方から使う。
 *
 * all を立てると、同じ品名の在庫が複数あるときにそのすべてを返す。
 * 在庫確認は期限ごとに見たいので all、材料確認はあるかないかだけなので 1件にする。
 */
function matchNamesToStock_(items, all) {
  var stock = currentStockRows_();
  if (!stock.length) return { have: [], missing: items };

  var have = [];
  var unresolved = [];

  items.forEach(function (it) {
    var key = normalizeName_(it.item_name);
    var hits = key ? stock.filter(function (s) { return normalizeName_(s.name) === key; }) : [];
    if (!hits.length) {
      unresolved.push(it);
      return;
    }
    (all ? hits : hits.slice(0, 1)).forEach(function (hit) { have.push(withStockInfo_(it, hit)); });
  });

  var missing = [];
  if (unresolved.length) {
    var matches = [];
    try {
      matches = matchListByClaude_(
        unresolved.map(function (it) { return it.item_name; }), stock, 'recipe');
    } catch (err) {
      console.error('在庫の意味照合に失敗: ' + err.stack);
    }
    unresolved.forEach(function (it) {
      var m = matches.filter(function (mm) { return mm.said === it.item_name && mm.row > 0; })[0];
      var row = m && stock.filter(function (s) { return s.row === m.row; })[0];
      if (!row) {
        missing.push(it);
        return;
      }
      // 意味照合は1行しか返さないので、all のときは同じ品名の行をここで揃える
      var rows = all
        ? stock.filter(function (s) { return normalizeName_(s.name) === normalizeName_(row.name); })
        : [row];
      rows.forEach(function (r) { have.push(withStockInfo_(it, r)); });
    });
  }

  return { have: have, missing: missing };
}

/**
 * レシピの材料を「買うべきもの」「家にあるもの」に振り分け、バブルで返信する。
 * どちらの行にも買い物リストへの「追加」ボタンを付ける（家にあっても買い足したい
 * ことがあるため）。期限・登録日は出さない。期限を見たいときは在庫確認を使う。
 */
function replyRecipeMatch_(replyToken, items, dish) {
  var r = matchNamesToStock_(items);
  var missing = r.missing.map(recipeEntry_);
  var have = r.have.map(recipeEntry_);

  // ボタンの postback には並び順の番号だけを入れ、品名と区分は控えのほうから引く。
  // postback の data は300文字までで、材料が多いと品名を並べきれないため
  var token = saveAddSet_(missing.concat(have), missing.length, dish);

  // リンクを写真より先に送っていた場合は、ここで結びつける
  var waiting = takeWaitingLink_();
  if (waiting) updateAddSet_(token, { url: waiting });

  // 紐づけ中の表示。料理名が読めていればそれを、読めていなければ帯だけ出す
  var linkNote = waiting ? (dish || true) : '';

  replyFlexMessage_(replyToken, '材料確認 買うべきもの' + missing.length + '件',
    buildRecipeBubble_(missing, have, token, linkNote));
}

/** バブルとその控えで使う1件ぶん。表示に要るのは名前と分量、追加には区分も要る */
function recipeEntry_(it) {
  return {
    name: it.item_name,
    amount: String(it.amount || '').trim(),
    category: it.category || '',
    low: !!(it.confidence && it.confidence !== 'high')
  };
}

/**
 * 在庫確認をバブルで返す。あるものは期限を色付きで添えて「使った」ボタンを、
 * ないものは品名だけを並べて「追加」ボタン（買い物リストへ）を付ける。
 */
function replyStockCheck_(replyToken, note, items) {
  var asked = items.map(function (it) {
    return { item_name: it.name, category: it.category || '' };
  });
  // 同じ品名が複数あれば期限ごとに全部並べる
  var r = matchNamesToStock_(asked, true);

  // ない側の「追加」は材料確認と同じ仕組み。postback には控えの番号だけを入れる
  var missing = r.missing.map(recipeEntry_);
  var token = saveAddSet_(missing, missing.length);

  var messages = [];
  if (note) messages.push({ type: 'text', text: note.replace(/\n+$/, '') });
  messages.push({
    type: 'flex',
    altText: '在庫確認 あり' + r.have.length + '件 / なし' + missing.length + '件',
    contents: buildStockCheckBubble_(r.have, missing, token)
  });
  replyMessages_(replyToken, messages);
}

/**
 * 「牛乳使った」等に対応して在庫を消す。
 * 期限違いの同名が複数あるときは、バブルでどれを使ったか選んでもらう。
 */
function consumeItems_(items) {
  if (!items.length) return '対象の食材を読み取れませんでした。';

  var sh = sheet_();
  var stamp = nowStamp_();
  var stock = currentStockRows_();
  if (!stock.length) return '在庫がありません。';

  // この一連のやり取りの状態。候補が複数あるものは queue に積んで質問する
  var session = {
    changed: [], done: [], missed: [], queue: []
  };
  var unresolved = [];

  // 第1段階: 名前の文字列一致で探す（API を使わないので速い）
  items.forEach(function (it) {
    var key = normalizeName_(it.item_name);
    if (!key) {
      session.missed.push(it.item_name || '(名称不明)');
      return;
    }

    var candidates = stock.filter(function (s) {
      if (session.changed.indexOf(s.row) >= 0) return false; // 同じ発話で二重に消さない
      var name = normalizeName_(s.name);
      return name.indexOf(key) >= 0 || key.indexOf(name) >= 0;
    });

    if (!candidates.length) {
      unresolved.push(it.item_name); // 第2段階に回す
      return;
    }

    candidates.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    // 何件処理するかは resolveQueue_ が判断する（自動で片付くならそこで片付く）
    session.queue.push({ said: it.item_name, choices: candidates, need: clampQty_(it.quantity, 99) });
  });

  // 第2段階: 文字列で当たらなかったものだけ、意味でClaudeに照合させる
  // （「コーヒー」→「ネスカフェ ゴールドブレンド」や「たまご」→「卵」を拾うため）
  if (unresolved.length) {
    var remaining = stock.filter(function (s) { return session.changed.indexOf(s.row) < 0; });
    var matches = [];
    if (remaining.length) {
      try {
        matches = matchListByClaude_(unresolved, remaining, 'stock');
      } catch (err) {
        console.error('在庫の意味照合に失敗: ' + err.stack);
      }
    }

    unresolved.forEach(function (said) {
      var hit = pickMatch_(said, matches, remaining, session.changed);
      if (hit) markRow_(sh, hit, session); else session.missed.push(said);
    });
  }

  return finishSession_(sh, session);
}

/**
 * 対象行を消費済みにして、返信用の1行を積む。
 * 状態と更新日時は隣り合う列なので、1回の setValues でまとめて書く
 * （別々に setValue すると書き込みが2往復になり、そのぶん返信が遅れる）
 */
function markRow_(sh, choice, session) {
  sh.getRange(choice.row, COL.STATUS, 1, 2).setValues([[STATUS.USED, nowStamp_()]]);
  session.changed.push(choice.row);
  session.done.push(choice.name);
}

/** 名前も期限も同じなら、どちらを消しても結果は変わらない */
function allSameItem_(list) {
  for (var i = 1; i < list.length; i++) {
    if (normalizeName_(list[i].name) !== normalizeName_(list[0].name)) return false;
    if (list[i].date !== list[0].date) return false;
  }
  return true;
}

/**
 * 候補を順に片付ける。聞く必要がないものはここで処理する:
 *   - すでに消した行を除いて0件 … 見つからなかった扱い
 *   - 候補が1件だけ … そのまま処理する
 *   - 個数が指定されている … 期限が近い順にその個数だけ処理する
 *   - 名前も期限も同じものが並ぶだけ … どれを選んでも同じなので先頭を処理する
 * 残った（期限違いが複数ある）ものを、バブルで選んでもらう分として返す。
 */
function resolveQueue_(sh, session) {
  var ambiguous = [];

  while (session.queue.length) {
    var q = session.queue.shift();
    var need = q.need || 1;
    var choices = q.choices.filter(function (c) { return session.changed.indexOf(c.row) < 0; });

    if (!choices.length) {
      session.missed.push(q.said);
      continue;
    }

    // 期限が近い順に並んでいるので、先頭から必要数だけ取ればよい
    if (choices.length === 1 || need > 1 || allSameItem_(choices)) {
      choices.slice(0, need).forEach(function (c) { markRow_(sh, c, session); });
      continue;
    }

    ambiguous.push({ said: q.said, choices: choices });
  }

  return ambiguous;
}

/**
 * 済んだ分の報告文を作る。何もなければ空文字。
 * withBubble を立てると、このあとに続く選択バブルの分と混ざらないよう断っておく。
 */
function buildSessionReport_(session, withBubble) {
  var lines = [];
  if (session.done.length) {
    // 消した品名は並べず、件数だけを返す。
    lines.push((withBubble ? '下記以外は' : '') + '在庫から削除しました（' + session.done.length + '件）');
  }
  if (session.missed.length) {
    if (lines.length) lines.push('');
    // 見出しと品名を行で分ける。複数あるときは読点でつなぐ
    lines.push('在庫に見つかりませんでした。');
    lines.push(session.missed.join('、'));
  }
  return lines.join('\n');
}

/**
 * 片付いた分を報告し、期限違いが複数あって決められなかったものは
 * バブルで選んでもらう。番号での問い返しはしないので、選択待ちの状態は持たない
 * （バブルを放置しても失効せず、あとから押してもその場で消せる）。
 */
function finishSession_(sh, session) {
  var ambiguous = resolveQueue_(sh, session);

  clearPending_();
  if (session.changed.length) {
    setLastOp_({ type: 'consume', rows: session.changed });
  }

  if (ambiguous.length) {
    return {
      text: buildSessionReport_(session, true),
      altText: 'どれを使ったか選んでください',
      flex: buildConsumeChoiceBubble_(ambiguous)
    };
  }

  // 空文字を返すと LINE の返信 API がエラーになり、何も返らなくなるので必ず何か返す
  return buildSessionReport_(session) || '対象の食材を読み取れませんでした。';
}

// ---------------------------------------------------------------- 選択待ちの状態

var PENDING_TTL_MS = 10 * 60 * 1000; // 古い質問に後から番号だけ返すと事故になるので時間で失効させる

function savePending_(session) {
  session.ts = Date.now();
  PropertiesService.getScriptProperties().setProperty(userKey_('PENDING'), JSON.stringify(session));
}

function getPending_() {
  var s = prop_(userKey_('PENDING'), false);
  if (!s) return null;
  var session = JSON.parse(s);
  if (Date.now() - (session.ts || 0) > PENDING_TTL_MS) {
    clearPending_();
    return null;
  }
  return session;
}

function clearPending_() {
  PropertiesService.getScriptProperties().deleteProperty(userKey_('PENDING'));
}

/** 全角英数を半角にし、記号と空白を落とす */
function toPlain_(text) {
  return String(text)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[\s　。、．，.,！!？?「」]/g, '')
    .toLowerCase();
}

/** 「2」「２」「2番」「2つ目」などから番号を取り出す。番号でなければ null */
function parseChoice_(text) {
  var m = toPlain_(text).match(/^(\d{1,2})(番|番目|つ目|個目|です|でお願いします|にします)?$/);
  return m ? parseInt(m[1], 10) : null;
}

var YES_PATTERN = /^(1|登録する|登録|する|はい|うん|ok|おっけー|オッケー|了解|買った|2つ目|2つ目を買った|追加|追加する|そう|yes|y)$/;
var NO_PATTERN = /^(2|登録しない|しない|いらない|不要|いいえ|いや|違う|ちがう|間違い|間違え|重複|だぶり|no|n)$/;

/** 重複確認への回答。「登録しない」のような言葉でも答えられるようにする */
function parseRegisterAnswer_(text) {
  var t = toPlain_(text);
  if (YES_PATTERN.test(t)) return 1;
  if (NO_PATTERN.test(t)) return 2;
  return parseChoice_(text);
}

function isCancelWord_(text) {
  return /^(やめる|やめて|キャンセル|中止|とりやめ)$/.test(toPlain_(text));
}

// ---------------------------------------------------------------- API を使わない近道

// 「捨てた」も在庫から消す点は同じなので、消費と分けずに1つにまとめている
var USED_VERB = /^(.{1,14}?)(?:を|は)?(使った|使いました|つかった|食べた|たべた|食べました|飲んだ|のんだ|飲みました|消費した|開けた|捨てた|すてた|捨てました|処分した|廃棄した|だめにした)$/;

// 「買い物リスト表示」はリッチメニューが送る文字。ボタンの見出しと揃えてあるので、
// あとから履歴を見たときに、どのボタンを押したのかが分かる
var SHOP_LIST_CMD = /^(買い物リスト表示|買い物リスト|買物リスト|買うもの|買い物)$/;
var SHOP_CLEAR_CMD = /^買い?物リスト(を)?(全部|すべて|全て|ぜんぶ)?(削除|消して|消す|クリア|リセット|空に)(して|する)?$/;
var BOUGHT_VERB = /^(.{1,14}?)(?:を|は)?(買った|買いました|購入した|買ってきた|買えた)$/;
var SHOP_ADD_A = /^買い?物リスト(?:に|へ)(.+?)(?:を)?(?:追加|入れて|足して|加えて|メモ)(?:して|しといて|しておいて|とく)?$/;
var SHOP_ADD_B = /^(.+?)(?:を)?買い?物リスト(?:に|へ)(?:追加|入れて|足して|加えて|メモ)(?:して|しといて|しておいて|とく)?$/;

/**
 * 「買い物リストに牛乳を追加」形式かどうかを判定し、品名の部分を返す。
 * 種別の判定はここで済むので、Claude は品名の特定にだけ使う。
 */
function parseShopAddFast_(text) {
  var t = String(text).replace(/[。．!！]/g, '').trim();
  var m = t.match(SHOP_ADD_A) || t.match(SHOP_ADD_B);
  return m ? m[1].trim() : null;
}

/**
 * 「牛乳使った」「豆腐捨てた」形式かどうかを判定し、食材名の部分を返す。
 * 品名の切り分けは Claude に任せるので、ここでは形だけ見る。
 */
function parseConsumeFast_(text) {
  var m = String(text).replace(/[。、．，.,!！]/g, '').trim().match(USED_VERB);
  if (!m) return null;

  var name = m[1].trim();
  return name ? { text: name } : null;
}

/** 選択・確認を中止する。すでに記録した分はそのまま残す */
function cancelPending_() {
  var session = getPending_();
  clearPending_();
  if (!session) return '中止する操作がありません。';

  var kind = session.kind === 'register' ? 'register' : 'consume';
  if (session.changed.length) {
    setLastOp_({ type: kind, rows: session.changed });
    return '中止しました。\nすでに記録した ' + session.changed.length + '件はそのままです。';
  }
  return '中止しました。記録は変更していません。';
}

/** 直前の登録・消費を元に戻す。行は消さず状態列だけ書き換える */
function undoLast_() {
  var op = getLastOp_();
  if (!op || !op.rows || !op.rows.length) {
    return '取り消せる操作がありません。';
  }
  if (op.sheet === 'shopping') return undoShopping_(op);

  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) {
    PropertiesService.getScriptProperties().deleteProperty('LAST_OP');
    return '取り消せる操作がありません。';
  }

  // 1行ずつ getValue / setValue すると件数ぶん往復して遅い。
  // 全体を1回読み、状態・更新日時の2列を1回で書き戻す
  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var stamp = nowStamp_();
  var back = op.type === 'register' ? STATUS.CANCELED : STATUS.STOCK;
  var names = [];
  var cells = data.map(function (r) { return [r[COL.STATUS - 1], r[COL.UPDATED - 1]]; });

  op.rows.forEach(function (row) {
    var i = row - 2;
    if (i < 0 || i >= data.length) return;
    names.push(data[i][COL.NAME - 1]);
    cells[i] = [back, stamp];
  });

  if (names.length) {
    sh.getRange(2, COL.STATUS, cells.length, 2).setValues(cells);
  }

  PropertiesService.getScriptProperties().deleteProperty('LAST_OP');

  if (!names.length) return '取り消せる操作がありません。';

  // 品名は並べず、件数だけを返す
  return op.type === 'register'
    ? '直前の登録を取り消しました（' + names.length + '件）'
    : '在庫に戻しました（' + names.length + '件）';
}

/** 買い物リスト側の取り消し。追加は取消印、購入済は未購入に戻す */
function undoShopping_(op) {
  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) {
    PropertiesService.getScriptProperties().deleteProperty('LAST_OP');
    return '取り消せる操作がありません。';
  }

  // 在庫側の取り消しと同じく、読み1回・書き1回にまとめる
  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var stamp = nowStamp_();
  var back = op.type === 'shop_add' ? SHOP_STATUS.CANCELED : SHOP_STATUS.TODO;
  var names = [];
  var cells = data.map(function (r) { return [r[SHOP_COL.STATUS - 1], r[SHOP_COL.UPDATED - 1]]; });

  op.rows.forEach(function (row) {
    var i = row - 2;
    if (i < 0 || i >= data.length) return;
    names.push(data[i][SHOP_COL.NAME - 1]);
    cells[i] = [back, stamp];
  });

  if (names.length) {
    sh.getRange(2, SHOP_COL.STATUS, cells.length, 2).setValues(cells);
  }

  PropertiesService.getScriptProperties().deleteProperty('LAST_OP');
  if (!names.length) return '取り消せる操作がありません。';

  if (op.type === 'shop_clear') {
    // 全件削除の取り消しは件数だけ返す（品名は並べない）
    return '買い物リストをもとに戻しました（' + names.length + '件）';
  }

  var head = op.type === 'shop_add' ? '直前の追加を取り消しました'
    : '買い物リストに戻しました';

  return head + '（' + names.length + '件）\n' + names.join('、');
}

/** 在庫の一覧を返す */
// ---------------------------------------------------------------- 週次通知

/**
 * 毎週土曜の朝に実行する。
 * 1品につき「残り30日を切った最初の土曜」と「残り7日を切った最初の土曜」の2回だけ通知し、
 * 期限切れのものは処分の報告を受けるまで毎週先頭に再掲する。
 * 該当がなければ push を送らない（LINE の無料通数を消費しないため）。
 */
/** 期限の近い順。期限が分からないものは末尾に回す（一覧の並びは全部これで揃える） */
function sortByDate_(items) {
  return items.slice().sort(function (a, b) {
    if (!a.date) return b.date ? 1 : 0;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });
}

/** 通知やトーク一覧に出る代替テキスト。バブルを開かなくても件数だけは分かるようにする */
function weeklyAltText_(sections) {
  var parts = sections.filter(function (sec) { return sec.items.length; })
    .map(function (sec) { return sec.title + ' ' + sec.items.length + '件'; });
  return '食材の期限: ' + parts.join(' / ');
}

function notifyWeekly(e) {
  if (!isOwnTrigger_(e) && !isEditor_()) throw new Error('週1の通知はトリガーか GAS エディタからだけ実行できます。');
  var sections = weeklyNotifySections_();
  if (!sections) { console.log('通知対象なし。push をスキップ'); return; }

  // 中身は受け取る人ごとに組み立て直す。配色がその人の設定で決まるため
  pushFlex_(weeklyAltText_(sections), function () { return buildWeeklyBubble_(sections); });
  console.log('通知しました: ' + sections.map(function (sec) {
    return sec.title + sec.items.length;
  }).join(' / '));
}

/**
 * 通知に載せる3区分を作る。対象が1件も無ければ null。
 *
 * 期限が近いものは、使用済にするまで毎週出し続ける。
 * バブルに「使用済」ボタンが付いてからは、通知は読むものではなく
 * その場で片づけるものになったので、片づくまで残るほうが都合がよい。
 * （以前は残り1週間・残り1か月を1回だけ出し、シートの NOTIFIED_1M /
 * NOTIFIED_1W に印を付けて重複を避けていた。今はその2列を読まない。）
 *
 * シートには何も書かないので、エディタから何度実行しても中身は変わらない。
 */
function weeklyNotifySections_() {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return null;

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var expired = [], week = [], month = [];

  data.forEach(function (row) {
    if (row[COL.STATUS - 1] !== STATUS.STOCK) return;

    var date = normalizeYmd_(row[COL.DATE - 1]);
    if (!date) return;

    var days = daysLeft_(date);
    var item = rowToItem_(row);
    if (days < 0) expired.push(item);
    else if (days <= NOTIFY_1W_DAYS) week.push(item);
    else if (days <= NOTIFY_1M_DAYS) month.push(item);
  });

  if (!expired.length && !week.length && !month.length) return null;

  // 期限の近い順に並べてから区分ごとに積む。縦棒の色で急ぎ具合が分かるようにする
  return [
    { title: '期限切れ', items: sortByDate_(expired), color: pal_().red },
    { title: '残り1週間', items: sortByDate_(week), color: pal_().yellow },
    { title: '残り1か月', items: sortByDate_(month), color: pal_().green }
  ];
}

/** 自分宛に push 送信する（返信と違い LINE の無料通数を消費する） */
function pushText_(text) {
  pushMessages_([{ type: 'text', text: text.substring(0, 4900) }]);
}

/**
 * 許可した人「全員」へ送る。週次通知に使う。
 * 買い物リストも在庫も共有なので、期限の知らせは全員が受け取るほうが都合がよい。
 */
function pushMessages_(messages) {
  var to = allowedUserIds_();
  if (!to.length) {
    throw new Error('通知先が未設定です。スクリプトプロパティ ALLOWED_USER_IDS に userId を設定してください。');
  }
  sendPush_(to, messages);
}

/** 1人だけに送る。操作した本人にだけ伝えたいとき（書き込み失敗の知らせなど）に使う */
function pushTextTo_(userId, text) {
  if (!userId) { pushText_(text); return; }   // 誰か分からないときは全員に送って取りこぼさない
  sendPush_([userId], [{ type: 'text', text: text.substring(0, 4900) }]);
}

/**
 * push の実体。宛先が1人なら push、複数なら multicast を使う。
 * multicast は1回の呼び出しで全員に届くので、人数ぶん往復せずに済む。
 */
function sendPush_(to, messages) {
  var single = to.length === 1;
  var url = single
    ? 'https://api.line.me/v2/bot/message/push'
    : 'https://api.line.me/v2/bot/message/multicast';

  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    payload: JSON.stringify(single
      ? { to: to[0], messages: messages }
      : { to: to, messages: messages }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('LINE push 失敗 (HTTP ' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

/**
 * 毎週土曜 8時台に notifyWeekly を実行するトリガーを設定する。
 * エディタから1回だけ実行する。同じ関数の古いトリガーがあれば張り替える。
 */
function setupWeeklyTrigger() {
  requireEditor_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'notifyWeekly') {
      console.log('既存トリガーを張り替えます');
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('notifyWeekly')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SATURDAY)
    .atHour(8)
    .create();

  console.log('毎週土曜 8時台に notifyWeekly を実行するトリガーを設定しました');
}

// ---------------------------------------------------------------- 買い物リスト

/**
 * 買い物リストのシートを返す。無ければ作り、ヘッダーが無ければ入れる。
 * （手動で空のシートだけ作ってある状態でもそのまま使えるようにしている）
 */
/**
 * レシピシート。無ければその場で作る。
 * 買い物リストと違い、写真から材料を足した人が出るまで1行も要らないので、
 * 初回の書き込みまで存在しなくてよい
 */
function recipeSheet_() {
  if (RECIPE_SHEET_CACHE_) return RECIPE_SHEET_CACHE_;

  var id = prop_('SPREADSHEET_ID', false);
  if (!id) {
    throw new Error('記録先が未設定です。GASエディタで setupSpreadsheet を1回実行してください。');
  }

  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(RECIPE_SHEET_NAME) || ss.insertSheet(RECIPE_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, RECIPE_COL_COUNT).setValues([RECIPE_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }

  RECIPE_SHEET_CACHE_ = sh;
  return sh;
}

/** レシピを1行足して、その ID を返す */
function recipeAdd_(title, url) {
  var sh = recipeSheet_();
  var last = sh.getLastRow();
  var id = String(last);   // 見出し行があるので、行数がそのまま次の連番になる

  sh.getRange(last + 1, 1, 1, RECIPE_COL_COUNT).setValues([[
    id, nowStamp_(), title || '', url || '', CURRENT_USER_ || ''
  ]]);
  return id;
}

/** レシピID → { title, url } の対応表。買い物リストを表示するたびに1回だけ読む */
function recipeMap_() {
  var id = prop_('SPREADSHEET_ID', false);
  if (!id) return {};

  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(RECIPE_SHEET_NAME);
  if (!sh) return {};   // まだ1件も登録していない

  var last = sh.getLastRow();
  if (last < 2) return {};

  var map = {};
  sh.getRange(2, 1, last - 1, RECIPE_COL_COUNT).getValues().forEach(function (r) {
    var key = String(r[RECIPE_COL.ID - 1] || '');
    if (!key) return;
    map[key] = {
      title: String(r[RECIPE_COL.TITLE - 1] || ''),
      url: String(r[RECIPE_COL.URL - 1] || '')
    };
  });
  return map;
}

function shopSheet_() {
  if (SHOP_SHEET_CACHE_) return SHOP_SHEET_CACHE_;

  var id = prop_('SPREADSHEET_ID', false);
  if (!id) {
    throw new Error('記録先が未設定です。GASエディタで setupSpreadsheet を1回実行してください。');
  }

  var ss = SpreadsheetApp.openById(id);
  var sh = ss.getSheetByName(SHOP_SHEET_NAME) || ss.insertSheet(SHOP_SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else {
    ensureShopColumns_(sh);
  }

  SHOP_SHEET_CACHE_ = sh;
  return sh;
}

/**
 * 列を増やしたあと、見出し行を今の定義に合わせて1回だけ直す。
 * 済んだことはスクリプトプロパティに控えるので、ふだんはシートを読みに行かない
 * （移行のたびにエディタから手で実行しなくて済むようにするための仕掛け）。
 * データのある列には触れず、足りない列を足して見出しを書き直すだけ
 */
function ensureShopColumns_(sh) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SHOP_SCHEMA') === String(SHOP_COL_COUNT)) return;

  if (sh.getMaxColumns() < SHOP_COL_COUNT) {
    sh.insertColumnsAfter(sh.getMaxColumns(), SHOP_COL_COUNT - sh.getMaxColumns());
  }
  sh.getRange(1, 1, 1, SHOP_COL_COUNT).setValues([SHOP_HEADERS]).setFontWeight('bold');
  props.setProperty('SHOP_SCHEMA', String(SHOP_COL_COUNT));
}

/** 未購入の行を {row, id, name} で返す */
function shopTodoRows_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];

  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var out = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][SHOP_COL.STATUS - 1] !== SHOP_STATUS.TODO) continue;
    out.push({
      row: i + 2,
      id: data[i][SHOP_COL.ID - 1],
      name: data[i][SHOP_COL.NAME - 1],
      amount: String(data[i][SHOP_COL.AMOUNT - 1] || ''),
      by: String(data[i][SHOP_COL.ADDED_BY - 1] || '')
    });
  }
  return out;
}

/**
 * 買い物リストの品目に振る連番を n 個まとめて確保する。
 * スクリプトプロパティで採番するので、行の並び替えや削除の影響を受けない。
 * 1品ずつ採番するとプロパティの読み書きが件数ぶん発生するため、まとめて取る。
 */
function shopReserveIds_(n) {
  // 読んで足して書くまでを囲う。割り込まれると同じIDを2回配ってしまう
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var next = Number(props.getProperty('SHOP_NEXT_ID')) || (shopMaxId_() + 1);
    props.setProperty('SHOP_NEXT_ID', String(next + n));

    var ids = [];
    for (var i = 0; i < n; i++) ids.push(next + i);
    return ids;
  });
}

function shopMaxId_() {
  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) return 0;

  var ids = sh.getRange(2, SHOP_COL.ID, last - 1, 1).getValues();
  var max = 0;
  ids.forEach(function (r) {
    var n = Number(r[0]);
    if (n > max) max = n;
  });
  return max;
}

/**
 * 買い物リストに品名を追加する本体。すでに未購入で載っているものは足さない。
 * 戻り値は { added, dup }（どちらも品名の配列）。返信の組み立ては呼び出し側に任せる
 * ので、テキスト返信（shopAdd_）とバブル返信（材料確認）の両方から使える。
 */
function shopAddPlan_(items, recipeId, by) {
  var clean = items
    .map(function (it) {
      return {
        name: String((it && it.name) || '').trim(),
        category: (it && it.category) || '',
        amount: String((it && it.amount) || '').trim()
      };
    })
    .filter(function (it) { return it.name; });
  if (!clean.length) return { add: [], dup: [] };

  var sh = shopSheet_();
  var last = sh.getLastRow();
  var known = {};
  if (last >= 2) {
    var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
    for (var i = 0; i < data.length; i++) {
      if (data[i][SHOP_COL.STATUS - 1] !== SHOP_STATUS.TODO) continue;
      var name = data[i][SHOP_COL.NAME - 1];
      known[normalizeName_(name)] = name;
    }
  }

  var add = [];
  var dup = [];
  clean.forEach(function (it) {
    var key = normalizeName_(it.name);
    if (known[key]) { dup.push(known[key]); return; }
    known[key] = it.name;   // 同じ発話の中での重複も防ぐ
    add.push(it);
  });

  // IDは書き込み前にここで確保しておく。返信のバブルに付ける削除ボタンが
  // IDを必要とし、その返信を書き込みより先に送っているため
  return {
    sheet: sh, startRow: last + 1, add: add, dup: dup,
    recipeId: recipeId || '',
    // LINE からは誰の操作か分かるので自動で入る。画面からは名乗ってもらった分を受け取る
    by: by || userName_(),
    ids: add.length ? shopReserveIds_(add.length) : []
  };
}

/** shopAddPlan_ が仕分けた分を書き込む。追記と取消用の記録をまとめて行う */
function shopAddCommit_(plan) {
  if (!plan.add.length) return;

  withLock_(function () {
    // 行の位置は plan を作った時点ではなく、書く直前に取り直す。
    // 返信を先に送る作りなので、その間に相手が追加していると行が重なるため
    var startRow = plan.sheet.getLastRow() + 1;
    var stamp = nowStamp_();
    var today = todayStamp_();

    var values = plan.add.map(function (it, i) {
      var row = new Array(SHOP_COL_COUNT).fill('');
      row[SHOP_COL.ID - 1] = plan.ids[i];
      row[SHOP_COL.ADDED - 1] = today;
      row[SHOP_COL.NAME - 1] = it.name;
      row[SHOP_COL.CATEGORY - 1] = it.category;
      row[SHOP_COL.STATUS - 1] = SHOP_STATUS.TODO;
      row[SHOP_COL.UPDATED - 1] = stamp;
      row[SHOP_COL.RECIPE - 1] = plan.recipeId || '';
      row[SHOP_COL.AMOUNT - 1] = it.amount || '';
      row[SHOP_COL.ADDED_BY - 1] = plan.by || '';
      return row;
    });
    plan.sheet.getRange(startRow, 1, values.length, SHOP_COL_COUNT).setValues(values);

    setLastOp_({
      type: 'shop_add',
      sheet: 'shopping',
      rows: values.map(function (_, i) { return startRow + i; })
    });
  });
}


/**
 * 指定した行をまとめて購入済にする。行が飛び飛びでも、状態・更新日時の
 * 2列を1回読んで1回書き戻すだけで済ませる（1行ずつだと件数ぶん往復する）
 */
function markShopRowsDone_(sh, rows, stamp) {
  var last = sh.getLastRow();
  if (last < 2 || !rows.length) return;

  var range = sh.getRange(2, SHOP_COL.STATUS, last - 1, 2);
  var cells = range.getValues();
  rows.forEach(function (row) {
    var i = row - 2;
    if (i >= 0 && i < cells.length) cells[i] = [SHOP_STATUS.DONE, stamp];
  });
  range.setValues(cells);
}

/** 買ったものをリストから外す（購入済にする） */
function shopBought_(names) {
  var sh = shopSheet_();
  var todo = shopTodoRows_(sh);
  if (!todo.length) return '買い物リストは空です。';

  var stamp = nowStamp_();
  var done = [];
  var missed = [];
  var changed = [];
  var unresolved = [];

  // ここでは対象を控えるだけ。シートへの書き込みは最後に1回でまとめて行う
  function take(hit) {
    changed.push(hit.row);
    done.push(hit.name);
  }

  // 第1段階: 名前の文字列一致で探す（API を使わないので速い）
  names.forEach(function (n) {
    var key = normalizeName_(n);
    if (!key) { missed.push(n || '(名称不明)'); return; }

    var hit = null;
    for (var i = 0; i < todo.length; i++) {
      if (changed.indexOf(todo[i].row) >= 0) continue;
      var name = normalizeName_(todo[i].name);
      if (name.indexOf(key) >= 0 || key.indexOf(name) >= 0) { hit = todo[i]; break; }
    }

    if (hit) take(hit); else unresolved.push(n);  // 第2段階に回す
  });

  // 第2段階: 文字列で当たらなかったものだけ、意味で照合する。
  // 在庫と同じ扱い。「とうふ」→「豆腐」や「ヨーグルト」→「ブルガリアヨーグルト」を拾う。
  // 当たらなかったときだけ呼ぶので、ふだんは API を使わない。
  if (unresolved.length) {
    var remaining = todo.filter(function (t) { return changed.indexOf(t.row) < 0; });
    var matches = [];
    if (remaining.length) {
      try {
        matches = matchListByClaude_(unresolved, remaining, 'shopping');
      } catch (err) {
        console.error('買い物リストの意味照合に失敗: ' + err.stack);
      }
    }

    unresolved.forEach(function (said) {
      var hit = pickMatch_(said, matches, remaining, changed);
      if (hit) take(hit); else missed.push(said);
    });
  }

  if (changed.length) {
    markShopRowsDone_(sh, changed, stamp);
    setLastOp_({ type: 'shop_bought', sheet: 'shopping', rows: changed });
  }

  return { done: done, missed: missed };
}

/**
 * テキストでの「牛乳買った」等への返信。ボタンを押したときと同じ ✓ のバブルで
 * 外したものを並べ、見つからなかったものはテキストで添える。
 */
function replyShopBought_(replyToken, note, names) {
  var r = shopBought_(names);

  var messages = [];
  if (note) messages.push({ type: 'text', text: note.replace(/\n+$/, '') });

  if (r.done.length) {
    messages.push({
      type: 'flex',
      altText: '買い物リストから削除 ' + r.done.length + '件',
      contents: buildShopCheckBubble_(r.done)
    });
  }
  if (r.missed.length) {
    messages.push({ type: 'text', text: 'リストに見つかりませんでした: ' + r.missed.join('、') });
  }
  if (!messages.length || (!r.done.length && !r.missed.length)) {
    messages.push({ type: 'text', text: '対象を読み取れませんでした。' });
  }
  replyMessages_(replyToken, messages);
}

/**
 * 未購入をすべて購入済にする。行は消さないので「取消」で戻せる。
 * 返すのは変更した行の一覧（{row, id, name}）。空なら null（テキスト版・Flex版で
 * 「すでに空です」の文言が違うため、ここでは判定だけ済ませて呼び出し側に委ねる）
 */
function shopClearPlan_() {
  return shopBulkDonePlan_(null, null, 'shop_clear');
}

/**
 * ID が first〜last の未購入だけを購入済にする下ごしらえ。
 * 追加バブルの「全て削除」用。IDはまとめて確保するので必ず連番になり、
 * postback の data には範囲（例 12-14）だけ入れれば足りる。
 */
function shopRangePlan_(first, last) {
  return shopBulkDonePlan_(first, last, 'shop_bought');
}

/**
 * 未購入を購入済にする下ごしらえ。first/last が null なら全件が対象。
 * 行は消さないので「取消」で戻せる。対象が無ければ null を返し、
 * 文言は呼び出し側に委ねる（「すでに空です」など場面で異なるため）。
 */
function shopBulkDonePlan_(firstId, lastId, opType) {
  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) return null;

  // 1件ずつ setValue すると件数ぶん往復して遅いので、状態・更新日時の2列を
  // まとめて1回で書き戻す。対象外の行は読んだ値をそのまま入れ直すだけ
  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var stamp = nowStamp_();
  var todo = [];
  var cells = [];
  for (var i = 0; i < data.length; i++) {
    var status = data[i][SHOP_COL.STATUS - 1];
    var updated = data[i][SHOP_COL.UPDATED - 1];
    var id = Number(data[i][SHOP_COL.ID - 1]);
    var inRange = firstId === null || (id >= firstId && id <= lastId);

    if (status === SHOP_STATUS.TODO && inRange) {
      todo.push({ row: i + 2, id: id, name: data[i][SHOP_COL.NAME - 1] });
      status = SHOP_STATUS.DONE;
      updated = stamp;
    }
    cells.push([status, updated]);
  }
  if (!todo.length) return null;

  return { sheet: sh, cells: cells, todo: todo, opType: opType };
}

/** shopBulkDonePlan_ が組み立てた内容を書き込む */
function shopBulkDoneCommit_(plan) {
  plan.sheet.getRange(2, SHOP_COL.STATUS, plan.cells.length, 2).setValues(plan.cells);
  setLastOp_({
    type: plan.opType,
    sheet: 'shopping',
    rows: plan.todo.map(function (t) { return t.row; })
  });
}

function shopClearInternal_() {
  var plan = shopClearPlan_();
  if (!plan) return null;

  shopBulkDoneCommit_(plan);
  return plan.todo;
}

/** 未購入をすべて購入済にする（テキスト版の文言） */
function shopClear_() {
  var todo = shopClearInternal_();
  if (!todo) return '買い物リストはすでに空です。';

  // ボタン版の全件削除と揃えて、品名は並べず件数だけを返す
  return '買い物リストを全て削除しました（' + todo.length + '件）'
    + '\n\n戻す場合は「取消」と送ってください。';
}

/**
 * postback「買った」ボタン用。押された1件をシートから読んで、何を返すかだけ決める。
 * まだ書き込みはしない（handlePostback_ が返信を先に送ってから commit する）。
 * 戻り値: { sheet, row, name, remaining } / { already, name }（二度押し）/ { notFound }
 *
 * 押してから返信が届くまでを短くしたいので、シートへの往復を最小にしている。
 * 対象の行と残りの未購入件数は、同じ1回の getValues から数える。
 * remaining は「空になったか」の判定にだけ使い、件数自体は返信に出さない。
 */
function shopBoughtPlan_(id) {
  var sh = shopSheet_();
  var last = sh.getLastRow();
  if (last < 2) return { notFound: true };

  var data = sh.getRange(2, 1, last - 1, SHOP_COL_COUNT).getValues();
  var hit = null;
  var remaining = 0;
  for (var i = 0; i < data.length; i++) {
    var status = data[i][SHOP_COL.STATUS - 1];
    if (String(data[i][SHOP_COL.ID - 1]) === String(id)) {
      hit = { row: i + 2, name: data[i][SHOP_COL.NAME - 1], status: status };
    } else if (status === SHOP_STATUS.TODO) {
      remaining++;   // 押した1件を除いた未購入の数
    }
  }

  if (!hit) return { notFound: true };
  if (hit.status !== SHOP_STATUS.TODO) return { already: true, name: hit.name };

  return { sheet: sh, row: hit.row, name: hit.name, remaining: remaining };
}

/** shopBoughtPlan_ が決めた1件を実際に購入済にする。状態と更新日時を1回で書く */
function shopBoughtCommit_(plan) {
  plan.sheet.getRange(plan.row, SHOP_COL.STATUS, 1, 2).setValues([[SHOP_STATUS.DONE, nowStamp_()]]);
  setLastOp_({ type: 'shop_bought', sheet: 'shopping', rows: [plan.row] });
}

// ---------------------------------------------------------------- 週次通知（Flexバブル）

// バブルに並べる品目の上限。Flex メッセージには JSON の大きさに上限があり、
// 期限切れは使用済にするまで毎週出続けるので、溜まっても送れなくならないようにする。
// 1行おおよそ1KB。40行なら上限に対して十分な余裕がある
var WEEKLY_MAX_ROWS = 40;

/**
 * 土曜朝の通知バブル。期限の近いものを区分ごとに並べ、その場で「使用済」を押せる。
 *
 * 材料確認・在庫確認のバブルと同じ作りにしてある。違いは次の2点。
 *   - まとめて処理するボタン（「全て追加」にあたるもの）は置かない。
 *     通知は不意に届くので、1タップで在庫がまとめて消えると事故になるため。
 *   - 日付は出さず、残日数だけを品名の右に添える。一覧として見るときは
 *     「あと何日か」だけ分かればよく、日付は在庫確認の画面で見られる。
 */
function buildWeeklyBubble_(sections) {
  var rows = [];
  var left = WEEKLY_MAX_ROWS;
  var omitted = 0;

  sections.forEach(function (sec) {
    if (!sec.items.length) return;

    // まとめ処理のボタンは渡さない（第4引数なし）。件数は省いた分も含めた全体を出す
    rows.push(bubbleSectionHeader_(sec.title, sec.items.length, sec.color));

    var shown = left > 0 ? sec.items.slice(0, left) : [];
    omitted += sec.items.length - shown.length;
    left -= shown.length;

    shown.forEach(function (it, i) {
      if (i > 0) rows.push({ type: 'separator', color: pal_().line });
      rows.push(weeklyItemRow_(it, sec.color));
    });
  });

  if (omitted) rows.push(weeklyOmittedRow_(omitted));

  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

/** 入りきらなかった分の断り書き。押せる行ではないので区切り線も付けない */
function weeklyOmittedRow_(count) {
  return {
    type: 'box',
    layout: 'vertical',
    paddingStart: '14px',
    paddingEnd: '14px',
    paddingTop: '12px',
    paddingBottom: '12px',
    contents: [{
      type: 'text',
      text: 'ほか' + count + '件は「在庫確認」の画面で見てください。',
      color: pal_().gray,
      size: 'xs',
      wrap: true
    }]
  };
}

/**
 * 通知バブルの1行。品名の右に残日数、さらに右に「使用済」。
 * 残日数の色は区分の色に合わせる（縦棒と同じ赤・黄）。
 */
function weeklyItemRow_(it, color) {
  // 読み取り確度の ⚠ は付けない。通知は一覧として眺めるものなので、
  // 品名と残日数だけに絞る（怪しいものは在庫確認の画面で確かめられる）
  var name = it.item_name || '(食材名不明)';
  var sub = { text: weeklyRemainText_(it), color: color || pal_().gray, side: true };

  return bubbleActionRow_(name, '使用済',
    { type: 'postback', label: '使用済', data: STOCK_USED_PREFIX + it.id }, sub);
}

/**
 * 「残り3日」「12日超過」。日付そのものは出さない。
 * 月までしか読めていない在庫は「約」を頭に付ける（日付を出さないので、
 * 日付側に付けていた「頃」をここへ移した形）。
 */
function weeklyRemainText_(it) {
  if (isAlways_(it)) return '常備';
  if (!it.date) return '期限不明';

  var days = daysLeft_(it.date);
  var approx = it.date_precision === 'month' ? '約' : '';
  if (days < 0) return approx + (days * -1) + '日超過';
  if (days === 0) return '今日まで';
  return '残り' + approx + days + '日';
}

/** 通知先へ Flex メッセージを push する。pushText_ の Flex 版 */
/**
 * バブルを全員へ送る。配色が人ごとに違うので、1通を multicast で配ることはできない。
 * 宛先ごとに、その人の配色で組み立て直してから送る。
 *
 * build は中身を作って返す関数。呼ばれるたびに pal_() がその人の色を返す
 */
function pushFlex_(altText, build) {
  var to = allowedUserIds_();
  if (!to.length) {
    throw new Error('通知先が未設定です。スクリプトプロパティ ALLOWED_USER_IDS に userId を設定してください。');
  }
  to.forEach(function (uid) {
    withUser_(uid, function () {
      sendPush_([uid], [{
        type: 'flex',
        altText: String(altText).substring(0, 400),
        contents: build()
      }]);
    });
  });
}

// ---------------------------------------------------------------- 買い物リスト（Flexバブル）

/**
 * 「買い物リスト表示」の返信バブル。品名の右に「買った」ボタン（postback）が
 * 1つずつ付き、押しても入力欄に文字は入らず自分の発言も残らない。
 * 押した後の反応は handlePostback_ 側で個別に返す（このバブル自体は編集できない）。
 */
// 背景は3段。下に行くほど暗くして、上下の関係が見た目で分かるようにしている
//   バブル上部の見出し帯 … 一番明るい
//   セクション見出しの帯 … 中間
//   品目の行           … 一番暗い（バブルの地色）
var SHOP_PALETTES = {
  // 暗いほう。LINE のダークテーマ（トーク背景 #121212 ／ ヘッダ #2A2A2A）に並べたとき、
  // バブルだけが青く浮かないよう、灰色には色味を持たせない
  dark: {
    bg: '#212121',
    sectionBg: '#282828',
    headerBg: '#303030',
    green: '#4ADE80',
    blue: '#93C5FD',
    gray: '#9CA3AF',
    red: '#F87171',
    yellow: '#FBBF24',
    text: '#EDEDED',
    line: '#383838'
  },
  // 明るいほう。白の上では LINE のブランド緑 #06C755 は 2.3:1 しかなく、
  // 細い文字だと読めない。文字と同じ基準（4.5:1）を満たす濃さに落としてある
  light: {
    bg: '#FFFFFF',
    sectionBg: '#EDF0F4',
    headerBg: '#DDE2EA',
    green: '#077A3E',
    blue: '#1D6FD0',
    gray: '#4B5563',
    red: '#C62828',
    yellow: '#B45309',
    text: '#111418',
    line: '#D3D8E0'
  }
};

// セクション見出しの帯の高さ。ボタンの有無で高さがずれないよう決め打ちにする。
// 丸いボタン（md の文字＋上下の余白＋枠）が収まる高さにしてあるので、
// ボタンの文字を大きくするならここも合わせて上げること
var SECTION_HEADER_H = '52px';

/** いま組み立てているバブルの配色。相手の設定で決まる */
var THEME_CACHE_ = null;

function pal_() {
  if (!THEME_CACHE_) THEME_CACHE_ = SHOP_PALETTES[userTheme_()];
  return THEME_CACHE_;
}
var SHOP_POSTBACK_ALL = 'shop_bought_all';
// 追加バブルの「全て削除」。消すのはそのバブルに並んでいる分だけで、ID の範囲で指す
var SHOP_POSTBACK_RANGE = 'shop_bought_ids:';

function shopBoughtPostbackData_(id) { return 'shop_bought:' + id; }

/**
 * 品名を左、操作を右に置く1行。買い物リストと材料確認で見た目を揃えるため共通にする。
 * button コンポーネントは height:'sm' でも約40pxの固定高があるので、余白を自前で
 * 持たせた box に action を付けて代用している（緑文字のまま、タップ領域は保てる）。
 */
function bubbleActionRow_(name, actionLabel, action, sub, actionColor) {
  // sub.side を付けると、品名の下ではなく右隣に置く（週次通知の「残り3日」など）。
  // 日付を出さず残日数だけを添えるので、1行に収めたほうが一覧として読みやすい
  var label = sub && sub.side
    ? {
      type: 'box',
      layout: 'horizontal',
      flex: 1,
      alignItems: 'center',
      contents: [
        // 折り返さず1行に収める（長い品名は末尾が「…」になる）。
        // 縦に伸びると一覧として追いにくく、行ごとの高さも揃わなくなるため
        { type: 'text', text: String(name), color: pal_().text, size: 'md', flex: 1, wrap: false },
        { type: 'text', text: sub.text, color: sub.color, size: 'xs', flex: 0, margin: 'md', gravity: 'center' }
      ]
    }
  // 品名の下に小さく添える行（在庫確認の期限など）。無いときは品名だけ
  : sub
    ? {
      type: 'box',
      layout: 'vertical',
      flex: 1,
      spacing: 'xs',
      contents: [
        { type: 'text', text: String(name), color: pal_().text, size: 'md', wrap: true },
        { type: 'text', text: sub.text, color: sub.color, size: 'xs', wrap: true }
      ]
    }
    // size:'md'（16px）が LINE の通常のトーク文字と同じ大きさ。太さは既定（regular）のまま
    : { type: 'text', text: String(name), color: pal_().text, size: 'md', flex: 1, wrap: true, gravity: 'center' };

  return {
    type: 'box',
    layout: 'horizontal',
    paddingStart: '14px',
    paddingEnd: '4px',
    // 余白を足すのは品名の下に添える形（縦積み）のときだけ。
    // 横並びは1行で収まるので、ボタン側の余白だけで高さが決まる
    paddingTop: sub && !sub.side ? '10px' : '0px',
    paddingBottom: sub && !sub.side ? '10px' : '0px',
    alignItems: 'center',
    contents: [
      label,
      {
        type: 'box',
        layout: 'vertical',
        flex: 0,
        paddingStart: '16px',
        paddingEnd: '10px',
        paddingTop: '8px',
        paddingBottom: '8px',
        action: action,
        contents: [
          { type: 'text', text: actionLabel, color: actionColor || pal_().green, size: 'md', align: 'end' }
        ]
      }
    ]
  };
}

/**
 * バブル上部の帯。左に見出し、右に件数（note を省くと見出しだけ）。
 * 色は用途で変える。セクション見出しを持つバブル（材料確認・在庫確認）は
 * 白にして、緑はセクションの縦棒とボタンのほうに使う。
 */
// 注意: これはバブルの header ブロックではなく、body の先頭に置く帯として使う。
// header ブロックに高さを指定すると中身が切られて、見出しもボタンも欠ける
function bubbleHeader_(title, note, titleColor, pill) {
  var contents = [
    { type: 'text', text: title, weight: 'bold', size: 'md', color: titleColor || pal_().green, flex: 0, gravity: 'center' },
    { type: 'text', text: note || '', size: 'xs', color: pal_().gray, flex: 0, gravity: 'center', margin: 'md' },
    // 伸び縮みする余白。幅が足りないときはここが先に潰れるので、
    // 見出しや件数の文字が欠けない
    { type: 'filler' }
  ];
  if (pill) contents.push(pill);

  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: pal_().headerBg,
    paddingStart: '14px',
    paddingEnd: '14px',
    // ボタンの有無で高さが変わらないよう、セクション見出しと同じ決め打ちにする
    height: SECTION_HEADER_H,
    alignItems: 'center',
    contents: contents
  };
}

/**
 * セクションの見出し帯。左に色の縦棒、見出し、件数を置き、
 * 右にひとつだけ丸いボタンを添えられる（「全て追加」用）。
 * 帯の地色を1段明るくして、品目の行と区別する。
 */
function bubbleSectionHeader_(title, count, barColor, pill) {
  var contents = [
    // 縦棒。幅と高さを両方決めること。高さを省くと中身が無いぶん潰れて描画されない
    {
      type: 'box',
      layout: 'vertical',
      flex: 0,
      width: '5px',
      height: '20px',
      backgroundColor: barColor,
      cornerRadius: '3px',
      contents: [{ type: 'filler' }]
    },
    { type: 'text', text: title, weight: 'bold', size: 'md', color: pal_().text, flex: 0, gravity: 'center', margin: 'md' },
    { type: 'text', text: count + '件', size: 'xs', color: pal_().gray, flex: 0, gravity: 'center', margin: 'md' },
    // 伸び縮みする余白。幅が足りないときはここが先に潰れる
    { type: 'filler' }
  ];
  if (pill) contents.push(pill);

  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: pal_().sectionBg,
    paddingStart: '14px',
    paddingEnd: '14px',
    // 高さを決め打ちにして、ボタンの有無で帯の高さが変わらないようにする
    // （ボタンのあるほうだけ縦に広がって、並べたときに揃わないため）
    height: SECTION_HEADER_H,
    alignItems: 'center',
    contents: contents
  };
}

/**
 * 縦線のない見出し帯。在庫/買い物のように2種類を並べない場面用で、
 * 色で区別する必要がないため帯の高さだけを揃えている。
 */
function bubblePlainHeader_(title, count, pill) {
  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: pal_().sectionBg,
    paddingStart: '14px',
    paddingEnd: '14px',
    height: SECTION_HEADER_H,
    alignItems: 'center',
    contents: [
      { type: 'text', text: String(title), weight: 'bold', size: 'md', color: pal_().text, flex: 0, gravity: 'center' },
      { type: 'text', text: count + '件', size: 'xs', color: pal_().gray, flex: 0, gravity: 'center', margin: 'md' },
      { type: 'filler' }
    ].concat(pill ? [pill] : [])
  };
}

/**
 * 見出し帯の右に置く、緑の枠線だけの丸いボタン。
 * 文字は行の「追加」「使用済」と同じ md。枠のぶん小さく見えないよう揃えている
 * （そのぶん帯は高くなるので、SECTION_HEADER_H もあわせて決めてある）
 */
function bubblePillButton_(label, action, color) {
  color = color || pal_().green;
  return {
    type: 'box',
    layout: 'vertical',
    flex: 0,
    borderColor: color,
    borderWidth: '1px',
    cornerRadius: '999px',
    paddingStart: '14px',
    paddingEnd: '14px',
    paddingTop: '5px',
    paddingBottom: '5px',
    action: action,
    contents: [
      { type: 'text', text: label, color: color, size: 'md', align: 'center' }
    ]
  };
}

/** 最下段などに置く、横いっぱいの1行ボタン */
function bubbleWideButton_(label, action) {
  return {
    type: 'box',
    layout: 'vertical',
    paddingTop: '11px',
    paddingBottom: '11px',
    action: action,
    contents: [
      { type: 'text', text: label, color: pal_().green, size: 'md', align: 'center' }
    ]
  };
}

function buildShopListBubble_(todo) {
  // 「全て削除」は見出しの右のボタンに置く。最下段に横いっぱいのボタンを
  // 置くより、品目の並びが途切れず読みやすい
  var rows = [
    bubbleHeader_('買い物リスト', todo.length + '件', pal_().text,
      bubblePillButton_('全て削除', { type: 'postback', label: '全て削除', data: SHOP_POSTBACK_ALL }))
  ];
  todo.forEach(function (t, i) {
    if (i > 0) rows.push({ type: 'separator', color: pal_().line });
    rows.push(bubbleActionRow_(t.name, '削除',
      { type: 'postback', label: '削除', data: shopBoughtPostbackData_(t.id) },
      amountSub_(t.amount)));
  });

  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

/**
 * 「削除」「追加」「使用済」を押したときの確認。チェックだけ緑にして、品名は
 * トークの文字と同じ白で出す（span で1行の中の色を分けている）。
 * 品名の配列を渡すと1つのバブルに複数行で並べる（手入力でまとめて操作したとき用）。
 */
function buildShopCheckBubble_(names) {
  var list = Array.isArray(names) ? names : [names];
  return shopNoteShell_(list.map(function (name) {
    return {
      type: 'text',
      size: 'md',
      wrap: true,
      contents: [
        { type: 'span', text: '✓ ', color: pal_().green },
        { type: 'span', text: String(name), color: pal_().text }
      ]
    };
  }));
}

/** 1行バブルの外枠。中身のテキスト部品（1つでも配列でも）を差し替えて使う */
function shopNoteShell_(textComponents) {
  return {
    type: 'bubble',
    size: 'deca',
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: pal_().bg,
      paddingStart: '14px',
      paddingEnd: '14px',
      paddingTop: '12px',
      paddingBottom: '12px',
      spacing: 'sm',
      contents: Array.isArray(textComponents) ? textComponents : [textComponents]
    }
  };
}

function buildShopEmptyBubble_() {
  return {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: pal_().bg,
      paddingAll: '14px',
      contents: [
        { type: 'text', text: '買い物リストが空になりました', color: pal_().green, weight: 'bold', size: 'md', wrap: true }
      ]
    }
  };
}

/**
 * 買い物リスト表示の返信本体。note（先ほどの質問を打ち切った旨など）があれば
 * テキストメッセージとして先に添え、その後にリスト（空ならテキスト、あればFlex）を返す。
 */
function replyShopList_(replyToken, note) {
  var todo = shopTodoRows_(shopSheet_());
  var messages = [];
  if (note) messages.push({ type: 'text', text: note.replace(/\n+$/, '') });

  if (!todo.length) {
    messages.push({ type: 'text', text: '買い物リストは空です。' });
  } else {
    messages.push({ type: 'flex', altText: '買い物リスト ' + todo.length + '件', contents: buildShopListBubble_(todo) });
  }
  replyMessages_(replyToken, messages);
}

// ---------------------------------------------------------------- 材料確認・在庫確認（Flexバブル）

// data の文字列は変えないこと。トークに残っている古いバブルが押せなくなる
var ADD_PREFIX = 'recipe_add:';
var ADD_ALL_PREFIX = 'recipe_add_all:';

/**
 * バブルに出した品目の控え。材料確認と在庫確認の「追加」ボタンが共用する。
 * postback の data は300文字までで、品目が多いと品名を並べきれない。
 * そこで data には並び順の番号だけを入れ、品名と区分はスクリプトプロパティに
 * 預けておく。直近 ADD_SET_KEEP 回ぶんだけ残し、それより古いバブルを
 * 押したときは案内を返す。
 */
var ADD_SET_KEY = 'RECIPE_SETS';
var ADD_SET_KEEP = 3;

var ADD_SET_STALE_MESSAGE = 'この一覧は古くなりました。\nもう一度実行してください。';

function loadAddSets_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(ADD_SET_KEY) || '[]');
  } catch (err) {
    console.error('バブルの控えを読めませんでした: ' + err.stack);
    return [];
  }
}

function saveAddSet_(entries, missingCount, dish) {
  var token = String(Date.now());
  var sets = loadAddSets_();
  sets.unshift({
    token: token,
    missingCount: missingCount,
    dish: dish || '',      // 写真から読み取った料理名
    url: '',               // あとから本人が送ってくるリンク
    recipeId: '',          // レシピシートに行を作ったら、その ID
    shopIds: [],           // この照合から買い物リストへ入れた品目の ID
    // 分量も控える。「追加」を押した時点で買い物リストに書き写すため
    items: entries.map(function (e) { return { name: e.name, category: e.category, amount: e.amount || '' }; })
  });

  // スクリプトプロパティ1件の上限（9KB）に当てないよう、大きいときは直近だけ残す
  var json = JSON.stringify(sets.slice(0, ADD_SET_KEEP));
  if (json.length > 8000) json = JSON.stringify(sets.slice(0, 1));
  PropertiesService.getScriptProperties().setProperty(ADD_SET_KEY, json);

  return token;
}

function findAddSet_(token) {
  return loadAddSets_().filter(function (s) { return s.token === token; })[0] || null;
}

/** 控えの1件だけを書き換える。リンクや、買い物リストへ入れた品目の ID を足すのに使う */
function updateAddSet_(token, patch) {
  var sets = loadAddSets_();
  var hit = null;
  sets.forEach(function (s) {
    if (s.token !== token) return;
    hit = s;
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
  });
  if (!hit) return null;

  PropertiesService.getScriptProperties().setProperty(ADD_SET_KEY, JSON.stringify(sets));
  return hit;
}

/**
 * その控えに対応するレシピ行の ID。まだ無ければ作る。
 * 料理名もリンクも無いうちは行を作らない（中身の無い行が増えるだけのため）
 */
function ensureRecipeId_(set) {
  if (!set) return '';
  if (set.recipeId) return set.recipeId;
  if (!set.dish && !set.url) return '';

  var id = recipeAdd_(set.dish, set.url);
  updateAddSet_(set.token, { recipeId: id });
  set.recipeId = id;
  return id;
}

/**
 * 材料確認のバブル。買うべきもの／家にあるものを縦に並べ、どちらの行にも
 * 買い物リストへの「追加」ボタンを付ける（家にあっても買い足したいことがある）。
 * 「全部追加」は買うべきものの下にだけ置く。
 */
function buildRecipeBubble_(missing, have, token, linkNote) {
  var rows = [];

  // 預かっていたリンクを使ったときは、そのことを一番上に出す。
  // 「効いている」ことが見えないと、順番を覚えていないと使えない機能になってしまう
  if (linkNote) rows.push(recipeLinkBanner_(linkNote, token));

  if (missing.length) {
    rows.push(bubbleSectionHeader_('買うべきもの', missing.length, pal_().blue,
      bubblePillButton_('全て追加', { type: 'postback', label: '全て追加', data: ADD_ALL_PREFIX + token })));
    missing.forEach(function (e, i) {
      if (i > 0) rows.push({ type: 'separator', color: pal_().line });
      rows.push(recipeItemRow_(e, token, i));
    });
  }

  if (have.length) {
    rows.push(bubbleSectionHeader_('家にあるもの', have.length, pal_().green));
    have.forEach(function (e, i) {
      if (i > 0) rows.push({ type: 'separator', color: pal_().line });
      // 家にあるものは買い足しのための控えめな扱い。押せるが色は目立たせない
      rows.push(recipeItemRow_(e, token, missing.length + i, pal_().gray));
    });
  }

  // 見出し帯は置かない。何の返信かは押したボタンで分かるので、
  // セクションの見出し（買うべきもの）が一番上に来るほうが情報が早く読める
  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

/** 「リールに紐づけ中」の帯。料理名が読めていれば併せて出す */
function recipeLinkBanner_(dish, token) {
  var lines = [{
    type: 'text', size: 'md', wrap: true,
    contents: [
      { type: 'span', text: '🔗 ', color: pal_().blue },
      { type: 'span', text: 'リンクに紐づけ中', color: pal_().text, weight: 'bold' }
    ]
  }];

  // 料理名は次の行に落とす。横に並べると、長い名前で「外す」が押しづらくなる
  if (dish && dish !== true) {
    lines.push({ type: 'text', text: dish, size: 'md', wrap: true, color: pal_().gray });
  }

  return {
    type: 'box',
    layout: 'horizontal',
    backgroundColor: pal_().headerBg,
    paddingAll: '10px',
    paddingStart: '14px',
    paddingEnd: '14px',
    alignItems: 'center',
    contents: [
      { type: 'box', layout: 'vertical', flex: 1, contents: lines },
      // 違うレシピのリンクが付いていたとき、この場で外せるようにする。
      // 目立たせる必要はないので、枠も文字もグレーにしておく
      bubblePillButton_('外す',
        { type: 'postback', label: '外す', data: LINK_OFF_PREFIX + token },
        pal_().gray)
    ]
  };
}

/** 材料1件の行。読み取り確度が低いものには ⚠ を添える */
function recipeItemRow_(entry, token, index, actionColor) {
  return bubbleActionRow_(entry.name + (entry.low ? ' ⚠' : ''), '追加',
    { type: 'postback', label: '追加', data: ADD_PREFIX + token + ':' + index },
    amountSub_(entry.amount), actionColor);
}

/**
 * 品名の右に添える分量。書かれていなければ何も添えない。
 * side を付けて1行に収めるので、分量のあるなしで行の高さは変わらない
 */
function amountSub_(amount) {
  return amount ? { text: String(amount), color: pal_().gray, side: true } : null;
}

// ---------------------------------------------------------------- 在庫確認（Flexバブル）

var STOCK_USED_PREFIX = 'stock_used:';

/**
 * 品名の下に添える期限の1行。日付そのものは出さず、残り日数だけにする。
 * 期限が近いものから順に並べているので、危ないものは色を変えなくても上に来る。
 * 色を変えないぶん、行の読みやすさが一定に保たれる。
 */
function stockExpirySub_(it) {
  if (isAlways_(it)) return { text: '常備品', color: pal_().gray };
  if (!it.date) return { text: '期限不明', color: pal_().gray };

  var days = daysLeft_(it.date);
  var label = it.label === '消費期限' ? '消費期限' : '賞味期限';
  var remain = days < 0 ? (days * -1) + '日超過' : days === 0 ? '今日まで' : '残り' + days + '日';

  return { text: label + ' ' + remain, color: pal_().gray };
}

/**
 * 在庫確認のバブル。あるものは期限を色付きで添えて「使った」を、
 * ないものは品名だけを並べて「追加」（買い物リストへ）を付ける。
 */
function buildStockCheckBubble_(have, missing, token) {
  var rows = [];

  if (have.length) {
    // 期限が近いものを上に。期限が分からないものは末尾に回す
    have = have.slice().sort(function (a, b) {
      if (!a.date) return b.date ? 1 : 0;
      if (!b.date) return -1;
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    rows.push(bubbleSectionHeader_('在庫あり', have.length, pal_().green));
    have.forEach(function (it, i) {
      if (i > 0) rows.push({ type: 'separator', color: pal_().line });
      rows.push(bubbleActionRow_(
        it.item_name + (it.confidence && it.confidence !== 'high' ? ' ⚠' : ''),
        '使用済',
        { type: 'postback', label: '使用済', data: STOCK_USED_PREFIX + it.id },
        stockExpirySub_(it)));
    });
  }

  if (missing.length) {
    rows.push(bubbleSectionHeader_('在庫なし', missing.length, pal_().blue,
      bubblePillButton_('全て追加', { type: 'postback', label: '全て追加', data: ADD_ALL_PREFIX + token })));
    missing.forEach(function (e, i) {
      if (i > 0) rows.push({ type: 'separator', color: pal_().line });
      rows.push(recipeItemRow_(e, token, i));
    });
  }

  // 材料確認と同じく見出し帯は置かない（セクションの見出しが一番上に来る）
  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

var STOCK_UNREG_PREFIX = 'stock_unreg:';

/**
 * 登録直後の行に添える期限の1行。ここだけは日付も出す
 * （読み取った日付が合っているかをその場で確かめられるように）。
 */
function registeredExpirySub_(it) {
  if (isAlways_(it)) return { text: '常備品（期限なし）', color: pal_().gray };
  if (!it.date) return { text: '期限不明', color: pal_().gray };

  var days = daysLeft_(it.date);
  var label = it.label === '消費期限' ? '消費期限' : '賞味期限';
  var approx = it.date_precision === 'month' ? '頃' : '';
  var remain = days < 0 ? (days * -1) + '日超過' : days === 0 ? '今日まで' : '残り' + days + '日';

  // 中黒を挨むと行が折り返されやすいので、区切りは空白だけにする
  return { text: label + ' ' + it.date + approx + '  ' + remain, color: pal_().gray };
}

/**
 * 登録した分を並べたバブル。在庫確認と同じ行の形で、各行に「登録取消」を付ける。
 * 品名や期限を取り違えていたときに、その場で取り消せるようにするため。
 */
function buildRegisteredBubble_(items) {
  // 期限が近いものを上に。期限が分からないものは末尾に回す
  var sorted = items.slice().sort(function (a, b) {
    if (!a.date) return b.date ? 1 : 0;
    if (!b.date) return -1;
    return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
  });

  var rows = [bubblePlainHeader_('登録しました', sorted.length)];
  sorted.forEach(function (it, i) {
    if (i > 0) rows.push({ type: 'separator', color: pal_().line });
    rows.push(bubbleActionRow_(
      (it.item_name || '(名称不明)') + (it.confidence && it.confidence !== 'high' ? ' ⚠' : ''),
      '登録取消',
      { type: 'postback', label: '登録取消', data: STOCK_UNREG_PREFIX + it.stock_id },
      registeredExpirySub_(it)));
  });

  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

var STOCK_USED_ALL_PREFIX = 'stock_used_ids:';

/**
 * 「使用済 牛乳」の候補が期限違いで複数あったときのバブル。
 * 登録直後のバブルと同じ行の形で並べ、品名ごとの見出しに「全て使用済」を置く。
 */
function buildConsumeChoiceBubble_(groups) {
  var rows = [];

  groups.forEach(function (g) {
    var ids = g.choices.map(function (c) { return c.id; }).join(',');
    // 見出しには品名を出さない（行に同じ品名が並ぶので重複する）
    rows.push(bubblePlainHeader_('使用済を選択', g.choices.length,
      bubblePillButton_('全て使用済',
        { type: 'postback', label: '全て使用済', data: STOCK_USED_ALL_PREFIX + ids })));
    g.choices.forEach(function (c, i) {
      if (i > 0) rows.push({ type: 'separator', color: pal_().line });
      rows.push(bubbleActionRow_(c.name, '使用済',
        { type: 'postback', label: '使用済', data: STOCK_USED_PREFIX + c.id },
        registeredExpirySub_(c)));
    });
  });

  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

/**
 * postback「全て使用済」用。渡された ID のうち、まだ在庫にある行を集める。
 */
function stockUsedIdsPlan_(idList) {
  var ids = String(idList).split(',').filter(function (v) { return v; });
  if (!ids.length) return { rows: [] };

  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return { rows: [] };

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  var rows = [];
  for (var i = 0; i < data.length; i++) {
    if (data[i][COL.STATUS - 1] !== STATUS.STOCK) continue;
    if (ids.indexOf(String(data[i][COL.ID - 1])) < 0) continue;
    rows.push(i + 2);
  }
  return { sheet: sh, rows: rows };
}

/** stockUsedIdsPlan_ が集めた行をまとめて消費済にする。読み1回・書き1回にする */
function stockUsedIdsCommit_(plan) {
  var stamp = nowStamp_();
  plan.rows.forEach(function (row) {
    plan.sheet.getRange(row, COL.STATUS, 1, 2).setValues([[STATUS.USED, stamp]]);
  });
  setLastOp_({ type: 'consume', rows: plan.rows });
}

/**
 * postback「登録取消」用。IDで1件だけ取消にする下ごしらえ。
 * 使用済と同じく、ここでは書かずに返信を先に送る。
 */
function stockUnregisterPlan_(id) {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return { notFound: true };

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL.ID - 1]) !== String(id)) continue;

    var name = data[i][COL.NAME - 1];
    if (data[i][COL.STATUS - 1] !== STATUS.STOCK) return { already: true, name: name };
    return { sheet: sh, row: i + 2, name: name };
  }
  return { notFound: true };
}

/** stockUnregisterPlan_ が決めた1件を取消にする。行は消さない */
function stockUnregisterCommit_(plan) {
  plan.sheet.getRange(plan.row, COL.STATUS, 1, 2).setValues([[STATUS.CANCELED, nowStamp_()]]);
  PropertiesService.getScriptProperties().deleteProperty('LAST_OP');
}

/**
 * postback「使った」ボタン用。IDで1件だけ消費済にする下ごしらえ。
 * 買い物リストと同じく、ここでは書かずに返信を先に送る。
 */
function stockUsedPlan_(id) {
  var sh = sheet_();
  var last = sh.getLastRow();
  if (last < 2) return { notFound: true };

  var data = sh.getRange(2, 1, last - 1, COL_COUNT).getValues();
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][COL.ID - 1]) !== String(id)) continue;

    var name = data[i][COL.NAME - 1];
    if (data[i][COL.STATUS - 1] !== STATUS.STOCK) return { already: true, name: name };
    return { sheet: sh, row: i + 2, name: name };
  }
  return { notFound: true };
}

/** stockUsedPlan_ が決めた1件を消費済にする。状態と更新日時を1回で書く */
function stockUsedCommit_(plan) {
  plan.sheet.getRange(plan.row, COL.STATUS, 1, 2).setValues([[STATUS.USED, nowStamp_()]]);
  setLastOp_({ type: 'consume', rows: [plan.row] });
}

/**
 * 追加した分だけを並べたバブル。買い物リスト表示と同じ形で、各行に削除ボタンを付ける。
 * 品名を取り違えたときにその場で消せるようにするためで、リスト全件は出さない
 * （追加のたびに全件返すと、件数が増えたときトークが埋まるため）。
 */
function buildShopAddedListBubble_(plan) {
  // 「全て取消」が消すのは、このバブルに並んでいる分だけ（買い物リスト全体ではない）。
  // IDはまとめて確保していて必ず連番なので、範囲だけ渡せば足りる
  var range = plan.ids[0] + '-' + plan.ids[plan.ids.length - 1];

  // 見出しは「買い物リストに追加」だと、件数と丸いボタンを足した幅が
  // バブルに収まらない。何のリストかは押したボタンで分かるので短くする
  var rows = [
    bubbleHeader_('リストに追加', plan.add.length + '件', pal_().text,
      bubblePillButton_('全て取消',
        { type: 'postback', label: '全て取消', data: SHOP_POSTBACK_RANGE + range }))
  ];

  // 今入れた分を取り下げる操作なので、買い物リスト表示の「削除」ではなく「取消」にする
  plan.add.forEach(function (it, i) {
    if (i > 0) rows.push({ type: 'separator', color: pal_().line });
    rows.push(bubbleActionRow_(it.name, '取消',
      { type: 'postback', label: '取消', data: shopBoughtPostbackData_(plan.ids[i]) },
      amountSub_(it.amount)));
  });

  return {
    type: 'bubble',
    size: 'mega',
    body: { type: 'box', layout: 'vertical', backgroundColor: pal_().bg, paddingAll: '0px', spacing: 'none', contents: rows }
  };
}

/**
 * 買い物リストへの追加の返信。追加した分のバブルを返し、すでに載っていたものが
 * あればテキストで添える。「買った」と同じく、仕分けが決まった時点で先に返信し、
 * 書き込みは後に回す。
 */
/**
 * 買い物リストへ足して、その結果をバブルで返す。
 * set は材料確認の控え。渡されたときは、入れた品目にレシピID（リンクの出どころ）を付ける
 */
function replyShopAdd_(replyToken, note, items, set) {
  if (!items || !items.length) {
    replyText_(replyToken, (note || '') + '品名を読み取れませんでした。');
    return;
  }

  var plan = shopAddPlan_(items, ensureRecipeId_(set));
  rememberShopIds_(set, plan.ids);
  if (!plan.add.length) {
    replyText_(replyToken, (note || '') + (plan.dup.length
      ? 'すでにリストにあります: ' + plan.dup.join('、')
      : '追加するものを読み取れませんでした。'));
    return;
  }

  var messages = [];
  if (note) messages.push({ type: 'text', text: note.replace(/\n+$/, '') });
  messages.push({
    type: 'flex',
    altText: '買い物リストに追加 ' + plan.add.length + '件',
    contents: buildShopAddedListBubble_(plan)
  });
  if (plan.dup.length) {
    messages.push({ type: 'text', text: 'すでにリストにあります: ' + plan.dup.join('、') });
  }
  replyMessages_(replyToken, messages);

  commitOrNotify_(function () { shopAddCommit_(plan); }, '買い物リストへの追加');
}

/** 材料確認のバブルから1件だけ買い物リストに入れる */
function handleBubbleAdd_(replyToken, data) {
  var m = /^(\d+):(\d+)$/.exec(data);
  var set = m && findAddSet_(m[1]);
  if (!set) {
    replyText_(replyToken, ADD_SET_STALE_MESSAGE);
    return;
  }

  var item = set.items[Number(m[2])];
  if (!item) {
    replyText_(replyToken, 'この項目は見つかりませんでした。');
    return;
  }

  // 「買った」と同じく、仕分けが決まった時点で先に返信し、書き込みは後に回す
  var plan = shopAddPlan_([item], ensureRecipeId_(set));
  rememberShopIds_(set, plan.ids);
  if (plan.add.length) {
    replyFlexMessage_(replyToken, '買い物リスト', buildShopCheckBubble_(plan.add[0].name));
  } else {
    replyText_(replyToken, item.name + ' はすでにリストにあります。');
  }

  commitOrNotify_(function () { shopAddCommit_(plan); }, item.name + ' の追加');
}

/** 材料確認のバブルから「買うべきもの」をまとめて買い物リストに入れる */
function handleBubbleAddAll_(replyToken, token) {
  var set = findAddSet_(token);
  if (!set) {
    replyText_(replyToken, ADD_SET_STALE_MESSAGE);
    return;
  }

  var items = set.items.slice(0, set.missingCount);
  if (!items.length) {
    replyText_(replyToken, '買うべきものはありません。');
    return;
  }

  replyShopAdd_(replyToken, '', items, set);
}

/**
 * ボタン（postback）を処理する。
 *
 * 買い物リストの「買った」「全部買った」は、押してから吹き出しが出るまでを
 * 短くしたいので、シートを読んで内容が決まった時点で先に返信し、書き込みは
 * その後に回している。書き込みに失敗すると「返したのに記録されていない」状態に
 * なるので、そのときだけ push で知らせる（黙って消えないようにする）。
 */
function handlePostback_(event) {
  var data = (event.postback && event.postback.data) || '';

  if (data.indexOf(ADD_PREFIX) === 0) {
    handleBubbleAdd_(event.replyToken, data.substring(ADD_PREFIX.length));
    return;
  }
  if (data.indexOf(ADD_ALL_PREFIX) === 0) {
    handleBubbleAddAll_(event.replyToken, data.substring(ADD_ALL_PREFIX.length));
    return;
  }

  // 材料バブルの「外す」。その照合に付いたリンクを、追加済みの品目ごと外す
  if (data.indexOf(LINK_OFF_PREFIX) === 0) {
    replyText_(event.replyToken, detachRecipeLink_(data.substring(LINK_OFF_PREFIX.length)));
    return;
  }

  // 登録バブルの「登録取消」。押された1件だけを取消にする
  if (data.indexOf(STOCK_UNREG_PREFIX) === 0) {
    var unreg = stockUnregisterPlan_(data.substring(STOCK_UNREG_PREFIX.length));
    if (unreg.notFound) {
      replyText_(event.replyToken, 'この項目は見つかりませんでした。');
      return;
    }
    if (unreg.already) {
      replyText_(event.replyToken, unreg.name + ' はすでに在庫にありません。');
      return;
    }
    replyText_(event.replyToken, '登録を取り消しました（1件）');
    commitOrNotify_(function () { stockUnregisterCommit_(unreg); }, unreg.name + ' の登録取消');
    return;
  }

  // 選択バブルの「全て使用済」。その品名の候補をまとめて消費済にする
  if (data.indexOf(STOCK_USED_ALL_PREFIX) === 0) {
    var usedAll = stockUsedIdsPlan_(data.substring(STOCK_USED_ALL_PREFIX.length));
    if (!usedAll.rows.length) {
      replyText_(event.replyToken, 'この分はすでに在庫にありません。');
      return;
    }
    replyText_(event.replyToken, '在庫から削除しました（' + usedAll.rows.length + '件）');
    commitOrNotify_(function () { stockUsedIdsCommit_(usedAll); }, '全て使用済');
    return;
  }

  // 在庫確認のバブルの「使った」。押された1件だけを消費済にする
  if (data.indexOf(STOCK_USED_PREFIX) === 0) {
    var used = stockUsedPlan_(data.substring(STOCK_USED_PREFIX.length));
    if (used.notFound) {
      replyText_(event.replyToken, 'この項目は見つかりませんでした。');
      return;
    }
    if (used.already) {
      replyText_(event.replyToken, used.name + ' はすでに使用済です。');
      return;
    }
    replyText_(event.replyToken, '在庫から削除しました（1件）');
    commitOrNotify_(function () { stockUsedCommit_(used); }, used.name + ' の使用');
    return;
  }

  if (data === SHOP_POSTBACK_ALL) {
    var clear = shopClearPlan_();
    if (!clear) {
      replyText_(event.replyToken, '買い物リストはすでに空です。');
      return;
    }
    // 削除した品名は並べず、件数だけを普通のテキストで返す
    replyText_(event.replyToken, '買い物リストを全て削除しました（' + clear.todo.length + '件）');
    commitOrNotify_(function () { shopBulkDoneCommit_(clear); }, '買い物リストの全件削除');
    return;
  }

  // 追加バブルの「全て取消」。そのバブルに並んでいた分（IDの範囲）だけを消す
  if (data.indexOf(SHOP_POSTBACK_RANGE) === 0) {
    var range = /^(\d+)-(\d+)$/.exec(data.substring(SHOP_POSTBACK_RANGE.length));
    var part = range && shopRangePlan_(Number(range[1]), Number(range[2]));
    if (!part) {
      replyText_(event.replyToken, 'この追加はすでに取り消し済みです。');
      return;
    }
    // 取り消した品名は並べず、件数だけを普通のテキストで返す
    replyText_(event.replyToken, '追加を取り消しました（' + part.todo.length + '件）');
    commitOrNotify_(function () { shopBulkDoneCommit_(part); }, '追加の取り消し');
    return;
  }

  var m = /^shop_bought:(.+)$/.exec(data);
  if (!m) return; // リッチメニューの 'fill' など、買い物リスト以外の postback は無視

  var plan = shopBoughtPlan_(m[1]);
  if (plan.notFound) {
    replyText_(event.replyToken, 'この項目は見つかりませんでした。');
    return;
  }
  if (plan.already) {
    replyText_(event.replyToken, plan.name + ' はすでに削除済みです。');
    return;
  }

  // 最後の1件だけは「空になった」ことを伝える。それ以外は品名だけ返す
  replyFlexMessage_(event.replyToken, '買い物リスト', plan.remaining === 0
    ? buildShopEmptyBubble_()
    : buildShopCheckBubble_(plan.name));

  commitOrNotify_(function () { shopBoughtCommit_(plan); }, plan.name + ' の削除');
}

/** 返信後の書き込み。失敗したら push で知らせる（返信は取り消せないため） */
function commitOrNotify_(commit, label) {
  try {
    commit();
  } catch (err) {
    console.error('返信後の書き込みに失敗: ' + err.stack);
    try {
      pushTextTo_(CURRENT_USER_, '※ ' + label + 'を記録できませんでした。\n'
        + 'もう一度ボタンを押すか、時間をおいて試してください。\n' + err.message);
    } catch (pushErr) {
      console.error('失敗通知の push にも失敗: ' + pushErr.stack);
    }
  }
}

// ---------------------------------------------------------------- リッチメニュー

/**
 * トーク下部に常設するメニュー。Quick Reply と違い常に見えていて、
 * PC版のLINEでも表示される（Quick Reply は iOS/Android のみ）。
 *
 * 押すと fillInText が入力欄に入るだけで送信はされない。続きを打って自分で送る。
 * ただし postback イベント自体は届くので、doPost 側では無視している
 * （handleEvent_ が message 以外を早期 return する）。
 */
// 1段の高さは4段だった頃（1686/4 ≒ 421）と同じにし、3段ぶんの高さにした
var RICHMENU_SIZE = { width: 2500, height: 1263 };

// richmenu.png の格子と一致させること（2列×3行）。
// 1250 = 2500/2、421 = 1263/3。割り切れない高さに変えたときのために、
// 最下段だけ余りを足して下端が画像の高さにぴったり合うようにしておく
var RICHMENU_ROWS = 3;
var RICHMENU_COL_W = RICHMENU_SIZE.width / 2;
var RICHMENU_ROW_H = Math.floor(RICHMENU_SIZE.height / RICHMENU_ROWS);
var RICHMENU_LAST_ROW_H = RICHMENU_SIZE.height - RICHMENU_ROW_H * (RICHMENU_ROWS - 1);

/**
 * 画像と同じ並び（左列を上から、続いて右列を上から）。
 *   col        … 列番号（0=左, 1=右）
 *   row        … 行番号（0が最上段）
 *   fill       … 押すと入力欄に差し込まれる。続きを打って自分で送る
 *   send       … 押すとそのまま送信される。続けて入力するものがない操作に使う
 *   cameraRoll … 押すと写真選択画面が開く（レシピ写真を選んで送る用）
 *   webTab     … 押すとブラウザの画面が開く（'shop' = 買い物, 'stock' = 在庫）
 *
 * 最上段の2つはブラウザの画面へ飛ばす。一覧を見て消すだけならトーク内のバブルより
 * 画面のほうが速く、スワイプでの操作もできるため。
 * 材料確認（写真）は毎日は使わないので最下段に置いた。
 *
 * ⚠ webTab の URL には画面トークンが入る。リッチメニューは作った時点の URL を抱えるので、
 * rotateWebToken() でトークンを作り直したら setupRichMenu() も実行し直すこと。
 *
 * 「買い物リストを全部削除」はメニューから外した。買い物リスト表示の
 * バブル最下段に「全て削除」があり、そちらのほうが誤爆しにくいため
 * （文字で「買い物リストを全部削除」と送る経路は残してある）。
 *
 * 「買い物リスト削除」「使用済」も使わないのでメニューから外した。
 * どちらも画面のスワイプや通知バブルの「使用済」で済むため
 * （文字で「買い物リスト削除 牛乳」「使用済 牛乳」と送る経路は残してある）。
 */
var RICHMENU_CELLS = [
  { col: 0, row: 0, webTab: 'shop', label: '買い物リスト表示' },
  { col: 0, row: 1, fill: '買い物リスト追加\n' },
  { col: 0, row: 2, cameraRoll: true },                      // 材料確認
  { col: 1, row: 0, webTab: 'stock', label: '在庫確認' },
  { col: 1, row: 1, fill: '期限登録\n' },
  { col: 1, row: 2, send: '取消' }
];

function buildRichMenu_(theme) {
  return {
    size: RICHMENU_SIZE,
    selected: true,          // 友だち追加時から開いた状態にする
    // 名前は LINE 側の一覧に出るだけ。2つ並ぶので、どちらの配色か分かるようにしておく
    name: '食材在庫メニュー' + (theme === 'light' ? '(白)' : '(黒)'),
    chatBarText: 'メニュー',
    areas: RICHMENU_CELLS.map(function (cell) {
      // 最下段だけ、割り切れなかったぶんを足して下端を画像に合わせる
      var h = cell.row === RICHMENU_ROWS - 1 ? RICHMENU_LAST_ROW_H : RICHMENU_ROW_H;
      return {
        bounds: {
          x: cell.col * RICHMENU_COL_W,
          y: cell.row * RICHMENU_ROW_H,
          width: RICHMENU_COL_W,
          height: h
        },
        action: cell.webTab
          ? { type: 'uri', label: cell.label, uri: webUrl_(cell.webTab) }
          : cell.send
            ? { type: 'message', text: cell.send }
            : cell.cameraRoll
              ? { type: 'cameraRoll', label: '材料確認' }
              : {
                type: 'postback',
                data: 'fill',   // 使わないが postback には必須
                inputOption: 'openKeyboard',
                fillInText: cell.fill
              }
      };
    })
  };
}

function lineApi_(method, url, options) {
  var res = UrlFetchApp.fetch(url, Object.assign({
    method: method,
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    muteHttpExceptions: true
  }, options || {}));

  if (res.getResponseCode() !== 200) {
    throw new Error('LINE API 失敗 (HTTP ' + res.getResponseCode() + ') ' + url + '\n'
      + res.getContentText().substring(0, 300));
  }
  return res;
}

/**
 * リッチメニューを作り直して既定に設定する。エディタから実行する。
 * 画像や配置を変えたら、そのつど実行し直すこと。
 * 古いものは消してから作るので、何度実行しても増えない。
 */
function setupRichMenu() {
  requireEditor_();
  // メニューには画面のURLを焼き込むので、先に本物の /exec が分かっているか確かめる
  console.log('公開URL: ' + assertExecUrl_());

  // 誰に配るかが決まっていないと、トークン入りのリンクの配り先を絞れない
  var users = allowedUserIds_();
  if (!users.length) {
    throw new Error('ALLOWED_USER_IDS（または ALLOWED_USER_ID）が未設定です。\n'
      + 'メニューには画面のURLが入るため、配る相手を決めずには作れません。');
  }
  users.forEach(function (uid) {
    withUser_(uid, function () {
      RICHMENU_CELLS.forEach(function (cell) {
        if (cell.webTab) console.log((userName_() || uid) + ' の ' + cell.label + ' → ' + webUrl_(cell.webTab));
      });
    });
  });

  var old = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  (old.richmenus || []).forEach(function (m) {
    lineApi_('delete', 'https://api.line.me/v2/bot/richmenu/' + m.richMenuId);
    console.log('古いリッチメニューを削除: ' + m.richMenuId);
  });

  // メニューは人ごとに作る。押したときの動きも画像も同じだが、焼き込む画面のURLに
  // その人の呼び名が入るので、画面が「あなた」を名乗らせずに済む。
  // 配色は後から変えられるので、1人につき黒・白の2枚を先に作っておく
  var themes = [
    { theme: 'dark',  image: RICHMENU_IMAGE_BASE64, name: 'richmenu.png' },
    { theme: 'light', image: richMenuLightImage_(), name: 'richmenu-light.png' }
  ];

  var byUser = {};
  users.forEach(function (uid) {
    withUser_(uid, function () {
      byUser[uid] = {};
      themes.forEach(function (m) {
        if (!m.image) {
          console.log('※ ' + m.theme + ' の画像が無いので作りません（RichMenuImageLight.gs 未反映）');
          return;
        }
        var created = JSON.parse(lineApi_('post', 'https://api.line.me/v2/bot/richmenu', {
          contentType: 'application/json',
          payload: JSON.stringify(buildRichMenu_(m.theme))
        }).getContentText());
        byUser[uid][m.theme] = created.richMenuId;

        var png = Utilities.newBlob(Utilities.base64Decode(m.image), 'image/png', m.name);
        lineApi_('post', 'https://api-data.line.me/v2/bot/richmenu/' + created.richMenuId + '/content', {
          contentType: 'image/png',
          payload: png.getBytes()
        });
        console.log('作成(' + (userName_() || uid) + ' / ' + m.theme + '): ' + created.richMenuId);
      });
    });
  });

  PropertiesService.getScriptProperties().setProperty('RICHMENU_IDS', JSON.stringify(byUser));

  // 既定（全ユーザー）には割り当てない。
  // メニューの「買い物リスト表示」「在庫確認」は画面トークン入りのURLを抱えているので、
  // 既定にすると Bot を友だち追加しただけの人にもそのリンクが配られ、
  // ALLOWED_USER_IDS を通らずに買い物リストと在庫を読み書きされてしまう。
  lineApiIgnore404_('delete', 'https://api.line.me/v2/bot/user/all/richmenu');

  users.forEach(function (uid) {
    withUser_(uid, function () {
      linkRichMenuForUser_(uid);
      console.log('割り当て: ' + uid + ' → ' + userTheme_());
    });
  });
  console.log(users.length + '人に設定しました。トークを開き直すと出ます。');
  console.log('※ 使う人を増やしたら、ALLOWED_USER_IDS に追記したうえで、この関数をもう一度実行すること。');
}

/** 人ごとのリッチメニューID。{ userId: { dark: id, light: id } } */
function richMenuIds_() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty('RICHMENU_IDS') || '{}');
  } catch (err) {
    console.warn('RICHMENU_IDS を読めません: ' + err.message);
    return {};
  }
}

/**
 * 白基調の画像。RichMenuImageLight.gs を置いていなければ空を返す。
 * 参照するだけで ReferenceError になるので、typeof で確かめてから触る
 */
function richMenuLightImage_() {
  return typeof RICHMENU_IMAGE_LIGHT_BASE64 === 'string' ? RICHMENU_IMAGE_LIGHT_BASE64 : '';
}

/**
 * その人の設定に合うリッチメニューを貼る。貼れたら true。
 * まだ2種類そろっていない（setupRichMenu() を流していない）ときは false。
 */
function linkRichMenuForUser_(userId) {
  if (!userId) return false;

  var theme = userTheme_() === 'light' ? 'light' : 'dark';
  var mine = richMenuIds_()[userId] || {};
  // その配色がまだ無ければ、もう一方で代える（画像だけの違いなので動きは同じ）
  var id = mine[theme] || mine.dark || mine.light || '';
  if (!id) return false;

  lineApi_('post', 'https://api.line.me/v2/bot/user/' + encodeURIComponent(userId)
    + '/richmenu/' + id);
  return true;
}

/**
 * 404 を失敗と見なさない lineApi_。
 * 「既定のリッチメニューを外す」は、もともと設定が無いときに 404 を返すため。
 */
function lineApiIgnore404_(method, url) {
  var res = UrlFetchApp.fetch(url, {
    method: method,
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 404) {
    throw new Error('LINE API 失敗 (HTTP ' + code + ') ' + url + '\n'
      + res.getContentText().substring(0, 300));
  }
  return res;
}

/**
 * いま LINE 側がどうなっているかを見る。GASエディタから実行する。読むだけで何も変えない。
 *
 * ちらつきを調べるときに使う。メニューが2つ以上残っていたり、既定と個別割り当ての
 * 両方が設定されていたりすると、開いた直後に片方からもう片方へ切り替わって見える。
 */
function showRichMenuStatus() {
  requireEditor_();
  var list = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  var menus = list.richmenus || [];
  console.log('登録されているリッチメニュー: ' + menus.length + '件'
    + (menus.length > 1 ? '  ← 2件以上あると切り替わって見えることがある' : ''));
  menus.forEach(function (m) {
    console.log('  ' + m.richMenuId + '  name=' + m.name + '  selected=' + m.selected);
  });

  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
    muteHttpExceptions: true
  });
  console.log('既定のリッチメニュー: '
    + (res.getResponseCode() === 200 ? res.getContentText() + '  ← 個別割り当てと二重になっている'
      : 'なし（個別割り当てのみ。これが今の想定）'));

  allowedUserIds_().forEach(function (uid) {
    var r = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/' + encodeURIComponent(uid) + '/richmenu', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
      muteHttpExceptions: true
    });
    console.log('個別割り当て ' + uid + ': '
      + (r.getResponseCode() === 200 ? r.getContentText() : 'なし（HTTP ' + r.getResponseCode() + '）'));
  });

  showThemes();
}

/**
 * 誰がどちらの配色を選んでいるかを見る。GASエディタから実行する。読むだけで何も変えない。
 *
 * 配色を変えるのは本人が「白」「黒」と送ったときだけで、ここからは変えない。
 * 代わりに設定したいときは setUserThemeById_(userId, 'light') を使う
 */
function showThemes() {
  requireEditor_();
  var props = PropertiesService.getScriptProperties();
  var menus = richMenuIds_();
  var names = userNameMap_();
  console.log('黒基調=dark（既定） / 白基調=light');
  allowedUserIds_().forEach(function (uid) {
    var mine = menus[uid] || {};
    console.log('  ' + (names[uid] || '(呼び名なし)') + ' ' + uid
      + ': ' + (props.getProperty('THEME:' + uid) || 'dark（未設定）')
      + ' / メニュー dark=' + (mine.dark || '未作成') + ' light=' + (mine.light || '未作成'));
  });
}

/** 本人に送ってもらう代わりに、こちらから配色を決める。GASエディタから実行する */
function setUserThemeById_(userId, theme) {
  withUser_(userId, function () {
    setUserTheme_(theme);
    var linked = linkRichMenuForUser_(userId);
    console.log(userId + ' → ' + userTheme_() + (linked ? '（メニューも貼り替え）' : '（メニューは未作成）'));
  });
}

/** リッチメニューを全部消す。表示を止めたいときにエディタから実行する */
function deleteRichMenus() {
  requireEditor_();
  var list = JSON.parse(lineApi_('get', 'https://api.line.me/v2/bot/richmenu/list').getContentText());
  var menus = list.richmenus || [];
  if (!menus.length) { console.log('リッチメニューはありません'); return; }

  menus.forEach(function (m) {
    lineApi_('delete', 'https://api.line.me/v2/bot/richmenu/' + m.richMenuId);
    console.log('削除: ' + m.richMenuId);
  });
}

// ---------------------------------------------------------------- 動作確認用

/**
 * 品名の切り分けを確かめる。エディタから実行する。
 * 区切りのない並びや、品名に「と」を含むものが正しく切れるか見るためのもの。
 * シートには何も書かないので、何度実行しても副作用はない。
 */
function testItemNames() {
  requireEditor_();
  [
    '牛乳コチュジャンプロテイン',   // 区切りなしの並び
    '牛乳と卵',                   // 「と」は助詞
    'とうふとうもろこし',           // 「と」が品名の一部
    '納豆とうふねぎ',              // かなのまま返ること（「豆腐」に直さない）
    'たまごとチーズ',              // 同上（「卵」に直さない）
    'ブルガリアヨーグルト',         // 単品。分割しないこと
    'エクストラバージンオリーブオイル',
    '牛乳2本と卵1パック',          // 個数
    '牛乳1リットル',               // 内容量は個数ではない
    '片栗粉2つ',
    '牛乳全部'                    // quantity=99
  ].forEach(function (t) {
    try {
      console.log(t + '  ->  ' + parseItemNames_(t).map(function (it) {
        return it.name + '×' + it.quantity;
      }).join(' / '));
    } catch (err) {
      console.log(t + '  ->  *** ' + err.message + ' ***');
    }
  });
}

/** エディタから実行して、プロパティ設定と Claude API 疎通を確認する */
function testConfig() {
  requireEditor_();
  ['LINE_CHANNEL_ACCESS_TOKEN', 'ANTHROPIC_API_KEY'].forEach(function (k) {
    console.log(k + ': ' + (prop_(k, false) ? 'OK' : '*** 未設定 ***'));
  });

  // 守りの設定。どちらも欠けると、外から読み書きされる穴になる
  console.log('ALLOWED_USER_IDS: ' + (allowedUserIds_().length
    ? allowedUserIds_().length + '人 OK' : '*** 未設定（誰も使えません） ***'));
  var secret = webhookSecret_();
  if (!secret) {
    console.log('WEBHOOK_SECRET: *** 未設定（誰でも POST できます）。setupWebhookSecret() を実行すること ***');
  } else {
    // LINE に登録された Webhook URL が今の秘密を持っているか。秘密そのものはログに出さない
    var ep = UrlFetchApp.fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
      headers: { Authorization: 'Bearer ' + prop_('LINE_CHANNEL_ACCESS_TOKEN', true) },
      muteHttpExceptions: true
    });
    var endpoint = ep.getResponseCode() === 200 ? (JSON.parse(ep.getContentText()).endpoint || '') : '';
    console.log('WEBHOOK_SECRET: 設定済み / LINE 側の URL: '
      + (endpoint.indexOf('s=' + secret) >= 0 ? '一致 OK'
        : '*** 不一致。setupWebhookSecret() の URL を LINE に貼り直すこと ***'));
  }

  [MODEL_VISION, MODEL_TEXT].forEach(function (model) {
    var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/models/' + model, {
      method: 'get',
      headers: {
        'x-api-key': prop_('ANTHROPIC_API_KEY', true),
        'anthropic-version': ANTHROPIC_VERSION
      },
      muteHttpExceptions: true
    });
    console.log(model + ': HTTP ' + res.getResponseCode()
      + (res.getResponseCode() === 200 ? ' OK' : ' / ' + res.getContentText().substring(0, 150)));
  });

  // リッチメニューが差し込む語を COMMAND_WORDS に足し忘れると、
  // 押しても普通の文として扱われてしまう。目に見えにくいのでここで検査する
  RICHMENU_CELLS.forEach(function (cell, i) {
    if (cell.send) {
      // そのまま送信するボタンは、その文字でコマンドが成立しないと何も起きない。
      // 見出しを変えたときに判定側を直し忘れると気づきにくいので検査する
      var known = SHOP_LIST_CMD.test(cell.send) || SHOP_CLEAR_CMD.test(cell.send)
        || cell.send === '取消' || cell.send === '取り消し' || cell.send === 'とりけし';
      console.log('メニュー' + (i + 1) + '「' + cell.send + '」: そのまま送信'
        + (known ? ' OK' : ' *** どのコマンドにも当たらない ***'));
      return;
    }
    if (cell.cameraRoll) {
      console.log('メニュー' + (i + 1) + ': 写真選択画面を開く');
      return;
    }
    if (cell.webTab) {
      console.log('メニュー' + (i + 1) + '「' + cell.label + '」: 画面を開く（' + cell.webTab + '）');
      return;
    }
    var cmd = parseCommand_(cell.fill + 'テスト');
    console.log('メニュー' + (i + 1) + '「' + cell.fill.trim() + '」: '
      + (cmd ? cmd.action + ' OK' : '*** COMMAND_WORDS に未登録 ***'));
  });

  // 画像の格子とタップ領域がずれていないか
  var areas = buildRichMenu_().areas;
  var right = Math.max.apply(null, areas.map(function (a) { return a.bounds.x + a.bounds.width; }));
  var bottom = Math.max.apply(null, areas.map(function (a) { return a.bounds.y + a.bounds.height; }));
  console.log('リッチメニュー: ' + areas.length + '領域 / 右端' + right + ' 下端' + bottom
    + (right === RICHMENU_SIZE.width && bottom === RICHMENU_SIZE.height
      ? ' OK' : ' *** 画像サイズと不一致 ***'));
}
