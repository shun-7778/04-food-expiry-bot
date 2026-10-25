/**
 * スタンプラリーの決まり。シートにも LINE にも触らない、計算だけのファイル。
 *
 * main.gs（シートの読み書き・LINE）と webapp.gs（画面のAPI）がここを使う。
 * GAS 以外（ブラウザや Node）でもそのまま動くので、動作確認はこのファイルを直接読み込んで行う。
 *
 * 記録は1行1件で、行は消さない（取り消しは状態を「取消」にする）。
 *   スタンプ     … 週1回ジムに行って押したもの
 *   コイン穴埋め … 行けなかった週を、コイン1枚で行ったことにしたもの
 *   コイン       … 同じ週の2回目以降に行ってためたもの（1日1枚まで）
 *   ご褒美交換   … 手持ちのコイン5枚をご褒美と交換したもの
 */

var GYM_TYPE = { STAMP: 'スタンプ', PAID: 'コイン穴埋め', COIN: 'コイン', EXCHANGE: 'ご褒美交換' };
var GYM_ACTIVE = '有効';
var GYM_CANCELED = '取消';

var GYM_TOTAL = 40;      // 10/19の週から毎週1マスで、7月後半の週がゴール
var GYM_COIN_SET = 5;    // コイン5枚でご褒美と交換できる
var GYM_LAST_WEEK = '2027-07-26';   // この週まで押せる（月曜の日付）

// 特別なマス。週1で続けると、ご褒美は12月末・3月末・6月末の週に当たる位置
var GYM_SPECIAL = {
  6:  { type: 'petit',  name: 'マッサージ', art: 'massage' },
  11: { type: 'reward', name: '登山靴', art: 'boot' },
  18: { type: 'petit',  name: 'マカロン', art: 'macaron' },
  24: { type: 'reward', name: 'ジャケット／パンツ', art: 'jacket' },
  31: { type: 'petit',  name: 'マッサージ', art: 'massage' },
  37: { type: 'reward', name: '帽子とサングラス', art: 'hat' },
  40: { type: 'goal',   name: '富士山へ出発！', art: 'fuji' }
};
var GYM_COIN_REWARD = '手作りお菓子';

var GYM_KINDS = ['dumbbell', 'heart', 'star', 'sakura', 'flame', 'hanamaru', 'shoe', 'crown', 'drop', 'clover'];
var GYM_PRAISES = [
  ['えらい！', '今週もちゃんと行けたね！'],
  ['すごい！', '行くまでが一番大変。そこを越えたのがすごい！'],
  ['ナイス！', '先月の自分より、確実に強くなってる。'],
  ['おつかれさま！', '今週の分は達成。あとはゆっくり休んでね～'],
  ['さすが！', '続けてるのが本当にえらい！'],
  ['いい調子！', '富士山がちょっと近づいた！']
];
var GYM_COIN_PRAISES = ['今週2回目、がんばりすぎ！', 'おかわりジム、えらすぎる。', '貯金ならぬ貯ジム。えらい。'];
var GYM_PAID_TITLE = 'コインで今週クリア！';
var GYM_PAID_TEXT = 'ためておいた自分に感謝。';

// ---------------------------------------------------------------- 日付（'yyyy-MM-dd' の文字列で扱う）

var GYM_DAY_MS = 86400000;

function gymYmdToMs_(ymd) {
  var p = String(ymd).split('-');
  return Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function gymMsToYmd_(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
}
/** その日を含む週の月曜（ミリ秒） */
function gymMondayMs_(ymd) {
  var t = gymYmdToMs_(ymd);
  return t - ((new Date(t).getUTCDay() + 6) % 7) * GYM_DAY_MS;
}
/** 曜日。0=日 … 6=土 */
function gymWeekday_(ymd) { return new Date(gymYmdToMs_(ymd)).getUTCDay(); }

function gymKindLabel_(type) { return type === 'petit' ? 'プチご褒美' : type === 'goal' ? 'ゴール' : 'ご褒美'; }

// ---------------------------------------------------------------- 状態

/**
 * 有効な行（ID順）と今日の日付から、画面と通知に要るものを全部まとめる。
 * rows: [{ id, type, date, kind, r, title, text, status }]
 */
function gymState_(rows, today) {
  var active = rows.filter(function (x) { return x.status !== GYM_CANCELED; })
    .slice().sort(function (a, b) { return a.id - b.id; });
  var monday = gymMondayMs_(today);

  var squares = [], coins = [], exchanges = [];
  active.forEach(function (x) {
    if (x.type === GYM_TYPE.STAMP || x.type === GYM_TYPE.PAID) {
      var n = squares.length + 1, sp = GYM_SPECIAL[n];
      var sq = { id: x.id, n: n, date: x.date, kind: x.kind, r: Number(x.r) || 0, paid: x.type === GYM_TYPE.PAID,
        title: x.title || '', text: x.text || '' };
      // 押したあとの特別なマスだけ、中身を画面に渡す（押す前は種類だけ）
      if (sp) { sq.special = sp.type; sq.name = sp.name; sq.art = sp.art; }
      squares.push(sq);
    } else if (x.type === GYM_TYPE.COIN) {
      coins.push({ id: x.id, date: x.date });
    } else if (x.type === GYM_TYPE.EXCHANGE) {
      exchanges.push({ id: x.id, date: x.date, name: x.title || GYM_COIN_REWARD });
    }
  });

  var weekIndex = -1;
  squares.forEach(function (s, i) { if (gymMondayMs_(s.date) === monday) weekIndex = i; });
  var weekDone = weekIndex >= 0;
  var weekPaid = weekDone && squares[weekIndex].paid;
  var wentToday = squares.some(function (s) { return !s.paid && s.date === today; })
    || coins.some(function (c) { return c.date === today; });
  var inPeriod = squares.length < GYM_TOTAL && monday <= gymYmdToMs_(GYM_LAST_WEEK);
  var paidCount = squares.filter(function (s) { return s.paid; }).length;
  var used = paidCount + GYM_COIN_SET * exchanges.length;
  var held = coins.length - used;

  var specialTypes = {};
  Object.keys(GYM_SPECIAL).forEach(function (n) { specialTypes[n] = GYM_SPECIAL[n].type; });
  var nextN = Object.keys(GYM_SPECIAL).map(Number).filter(function (n) { return n > squares.length; })[0];

  return {
    today: today, total: GYM_TOTAL, coinSet: GYM_COIN_SET,
    squares: squares, coins: coins, exchanges: exchanges, specialTypes: specialTypes,
    held: held, used: used, earned: coins.length,
    weekDone: weekDone, weekPaid: weekPaid, wentToday: wentToday, inPeriod: inPeriod,
    canStamp: !weekDone && inPeriod,
    canConvert: weekPaid && !wentToday,      // コインで埋めた週に結局行けた → スタンプに差し替え
    canUse: !weekDone && inPeriod && held > 0,
    canEarn: weekDone && !weekPaid && !wentToday,
    canExchange: held >= GYM_COIN_SET,
    next: nextN ? { n: nextN, type: GYM_SPECIAL[nextN].type, label: gymKindLabel_(GYM_SPECIAL[nextN].type) } : null
  };
}

// ---------------------------------------------------------------- 操作の計画
// どれも「何を書くか（append / update）」と「画面に返すできごと（event）」を返す。
// 書けないときは { error } を返す。rand は 0〜1 の乱数を返す関数（テストで固定できるように渡す）。

function gymPick_(list, rand) { return list[Math.floor(rand() * list.length)]; }

/** 「今週ジムに行った！」 */
function gymPlanStamp_(st, today, rand) {
  if (st.canConvert) {
    var sq = st.squares[gymWeekIndex_(st)];
    var p = sq.special ? [sq.title, sq.text] : gymPick_(GYM_PRAISES, rand);
    return {
      update: { id: sq.id, patch: { type: GYM_TYPE.STAMP, date: today, title: p[0], text: p[1] } },
      event: { type: 'convert', n: sq.n, title: p[0], text: p[1] }
    };
  }
  if (!st.canStamp) {
    return { error: st.weekDone ? '今週の分はもう押してあります。' : 'スタンプラリーの期間が終わっています。' };
  }
  var n = st.squares.length + 1, sp = GYM_SPECIAL[n];
  var kind = sp ? (sp.type === 'reward' ? 'medal' : sp.type) : gymPick_(GYM_KINDS, rand);
  var praise = sp ? [gymKindLabel_(sp.type) + '！', '中身は「' + sp.name + '」でした。'] : gymPick_(GYM_PRAISES, rand);
  return {
    append: { type: GYM_TYPE.STAMP, date: today, kind: kind, r: sp ? 0 : Math.round(rand() * 20 - 10), title: praise[0], text: praise[1] },
    event: { type: sp ? 'special' : 'stamp', n: n, title: praise[0], text: praise[1] }
  };
}

/** 今週のマスの位置（無ければ最後のマス） */
function gymWeekIndex_(st) {
  var monday = gymMondayMs_(st.today);
  for (var i = st.squares.length - 1; i >= 0; i--) if (gymMondayMs_(st.squares[i].date) === monday) return i;
  return st.squares.length - 1;
}

/** 「コインを使う」：行けなかった週を、コイン1枚で行ったことにする */
function gymPlanUseCoin_(st, today, rand) {
  if (!st.canUse) {
    return { error: st.weekDone ? '今週の分はもう押してあります。' : st.held <= 0 ? 'コインがありません。' : 'スタンプラリーの期間が終わっています。' };
  }
  var n = st.squares.length + 1, sp = GYM_SPECIAL[n];
  var kind = sp ? (sp.type === 'reward' ? 'medal' : sp.type) : gymPick_(GYM_KINDS, rand);
  var title = sp ? gymKindLabel_(sp.type) + '！' : GYM_PAID_TITLE;
  var text = sp ? '中身は「' + sp.name + '」でした。' : GYM_PAID_TEXT;
  return {
    append: { type: GYM_TYPE.PAID, date: today, kind: kind, r: 0, title: title, text: text },
    event: { type: sp ? 'special' : 'use', n: n, viaCoin: true, title: title, text: text }
  };
}

/** 「今週もう1回行った！」：コインを1枚ためる */
function gymPlanEarnCoin_(st, today, rand) {
  if (!st.canEarn) {
    return { error: !st.weekDone ? '先に今週のスタンプを押してください。' : st.weekPaid ? '今週はコインで埋めた週です。行けたらスタンプに変えてください。' : '今日の分はもらっています。' };
  }
  var text = gymPick_(GYM_COIN_PRAISES, rand);
  return {
    append: { type: GYM_TYPE.COIN, date: today, kind: '', r: 0, title: '', text: text },
    // 手持ちが5の倍数になったら、交換するか・ためておくかを聞く
    event: { type: 'coin', text: text, held: st.held + 1, choice: (st.held + 1) % GYM_COIN_SET === 0 }
  };
}

/** 手持ちのコイン5枚をご褒美と交換する */
function gymPlanExchange_(st, today) {
  if (!st.canExchange) return { error: 'コインが5枚たまっていません。' };
  return {
    append: { type: GYM_TYPE.EXCHANGE, date: today, kind: '', r: 0, title: GYM_COIN_REWARD, text: '' },
    event: { type: 'exchange', name: GYM_COIN_REWARD }
  };
}

/**
 * ご褒美の箱を開ける前に×で閉じた（押し間違い）ときの取り消し。
 * 直前に書いた行で、かつ最後の有効行のときだけ取り消す（古い行を誤って消さないため）。
 */
function gymPlanCancel_(rows, id) {
  var active = rows.filter(function (x) { return x.status !== GYM_CANCELED; }).sort(function (a, b) { return a.id - b.id; });
  var last = active[active.length - 1];
  if (!last || last.id !== Number(id)) return { error: '取り消せませんでした（ほかの記録が後から入っています）。' };
  if ([GYM_TYPE.STAMP, GYM_TYPE.PAID, GYM_TYPE.EXCHANGE].indexOf(last.type) < 0) return { error: '取り消せない記録です。' };
  return { update: { id: last.id, patch: { status: GYM_CANCELED } }, event: { type: 'canceled' } };
}

/** 一番下の「最後のスタンプ／コインを1つ消す」 */
function gymPlanErase_(st, tab) {
  if (tab === 'coin') {
    if (st.held <= 0 || !st.coins.length) return { error: '消せるコインがありません。' };
    var c = st.coins[st.coins.length - 1];
    return { update: { id: c.id, patch: { status: GYM_CANCELED } }, event: { type: 'erased', what: 'coin', date: c.date } };
  }
  if (!st.squares.length) return { error: '消せるスタンプがありません。' };
  var s = st.squares[st.squares.length - 1];
  return { update: { id: s.id, patch: { status: GYM_CANCELED } }, event: { type: 'erased', what: 'stamp', n: s.n, date: s.date } };
}
