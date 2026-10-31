// 旅行データ(JSON) → HTML → PDF(A4縦) → PNG(目視確認用)
//
//   node scripts/build.mjs trips/<name>.json [--force]
//
// 1. 中身の検査   : 定休日・営業時間・ダイヤ種別・乗り継ぎ時間
// 2. HTML を組む  : scripts/template.html に流し込む
// 3. PDF にする   : Playwright(Chromium)
// 4. 見た目の検査 : 細切れ折り返し・時刻のはみ出し
// 5. PNG にする   : scripts/pdf2png.py（PyMuPDF）
// あわせて Googleドキュメント用の _doc.html も出す（カレンダー添付用）
// 検査でエラーがあれば PDF を出さずに止まる。--force で強行。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const force = args.includes('--force');
const tripPath = args.find(a => !a.startsWith('--'));
if (!tripPath) {
  console.error('使い方: node scripts/build.mjs trips/<name>.json [--force]');
  process.exit(2);
}
const trip = JSON.parse(readFileSync(tripPath, 'utf8'));

// ---------- 共通 ----------
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const TYPES = {
  train: '電車', bus: 'バス', walk: '徒歩', sight: '観光', meal: '食事', stay: '宿',
};
// "06:40頃" のような目安表記も読む
const toMin = t => { const [, h, m] = String(t).match(/(\d{1,2}):(\d{2})/); return +h * 60 + +m; };
const weekday = iso => { const [y, m, d] = iso.split('-').map(Number); return WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const dayLabel = iso => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}(${weekday(iso)})`; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 本文中の **太字** だけ許す
const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// ---------- 1. 中身の検査 ----------
const errors = [];
const warns = [];
const MIN_TRANSFER = 5;

for (const day of trip.days) {
  const wd = weekday(day.date);
  const expected = (wd === '土' || wd === '日' || day.holiday) ? '土休日' : '平日';
  const where = `${dayLabel(day.date)}`;
  if (day.dayType !== expected) errors.push(`${where}: dayType が「${day.dayType}」だが、曜日からは「${expected}」`);

  let prevTransport = null;
  let prevTime = -1;
  for (const it of day.items) {
    const at = `${where} ${it.time} ${it.title}`;
    if (!TYPES[it.type]) errors.push(`${at}: 種別 "${it.type}" が不明`);
    if (toMin(it.time) < prevTime) warns.push(`${at}: 時刻が前の行より早い`);
    prevTime = toMin(it.time);

    if (it.type === 'train' || it.type === 'bus') {
      if (!it.dayType) errors.push(`${at}: 交通の行に dayType（平日/土休日/毎日）がない`);
      else if (it.dayType !== '毎日' && it.dayType !== day.dayType) errors.push(`${at}: ${it.dayType}ダイヤを${day.dayType}に使っている`);
      if (!it.until) warns.push(`${at}: 到着時刻(until)がない`);
      if (prevTransport?.until) {
        const gap = toMin(it.time) - toMin(prevTransport.until);
        if (gap < 0) errors.push(`${at}: 前の便の到着(${prevTransport.until})より前に出発している`);
        else if (gap < MIN_TRANSFER && !it.alt) errors.push(`${at}: 乗り継ぎ ${gap}分（${MIN_TRANSFER}分未満）なのに代替案(alt)がない`);
        else if (gap < MIN_TRANSFER) warns.push(`${at}: 乗り継ぎ ${gap}分。代替案あり`);
      }
      prevTransport = it;
    }

    if (it.spot) {
      const sp = trip.spots[it.spot];
      if (!sp) { errors.push(`${at}: spots に "${it.spot}" がない`); continue; }
      if ((sp.closedDays ?? []).includes(wd) && !(day.holiday && sp.openOnHoliday)) {
        errors.push(`${at}: ${sp.name} は${wd}曜定休`);
      }
      if (sp.open && toMin(it.time) < toMin(sp.open)) errors.push(`${at}: ${sp.name} の開店(${sp.open})より前`);
      const last = sp.lastEntry ?? sp.close;
      if (last && toMin(it.time) > toMin(last)) errors.push(`${at}: ${sp.name} の受付終了(${last})より後`);
      if (sp.close && it.until && toMin(it.until) > toMin(sp.close)) warns.push(`${at}: 滞在終了 ${it.until} が閉店 ${sp.close} を過ぎる`);
      if (sp.irregular) warns.push(`${at}: ${sp.name} は不定休（当日休みの可能性）`);
      if (sp.unverified) warns.push(`${at}: ${sp.name} の営業情報は未確認`);
    }
  }
}

console.log(`\n[中身の検査] エラー ${errors.length} 件 / 注意 ${warns.length} 件`);
errors.forEach(e => console.log('  ✗ ' + e));
warns.forEach(w => console.log('  △ ' + w));
if (errors.length && !force) {
  console.error('\nエラーがあるため PDF を出さずに止めました（--force で強行）');
  process.exit(1);
}

// ---------- 2. HTML を組む ----------
const wxClass = t => /雨|雪/.test(t) ? 'tp-wx-rain' : /晴/.test(t) ? 'tp-wx-sun' : '';

const cover = `
<section class="tp-page tp-cover">
  <p class="tp-cover-kicker">TRAVEL SCHEDULE</p>
  <h1 class="tp-cover-title">${esc(trip.title)}</h1>
  <p class="tp-cover-dates">${trip.days.map(d => dayLabel(d.date)).join(' 〜 ')}</p>
  <div class="tp-cover-grid">
    <div class="tp-cover-key">出発</div><div>${esc(trip.origin)}</div>
    <div class="tp-cover-key">宿</div><div>${esc(trip.lodging.name)}</div>
    <div class="tp-cover-key">チェックイン</div><div>${esc(trip.lodging.checkin)}</div>
    <div class="tp-cover-key">チェックアウト</div><div>${esc(trip.lodging.checkout)}</div>
    ${trip.lodging.transfer ? `<div class="tp-cover-key">送迎</div><div>${rich(trip.lodging.transfer)}</div>` : ''}
    <div class="tp-cover-key">移動手段</div><div>${esc(trip.transport)}</div>
  </div>
  <p class="tp-cover-foot">情報取得: ${esc(trip.fetchedAt)}　／　営業時間・時刻は変わることがあります。出典は最終ページ。</p>
</section>`;

const weather = `
<section class="tp-page">
  <h1 class="tp-h1">天気</h1>
  ${trip.weather.map(w => `
  <div class="tp-wx-day">
    <div class="tp-wx-head">
      <span class="tp-wx-date">${dayLabel(w.date)}</span>
      <span class="tp-wx-sum">${rich(w.summary)}</span>
    </div>
    ${w.hourly?.length ? `<div class="tp-wx-hours">${w.hourly.map(h => `
      <div class="tp-wx-h ${wxClass(h.text)}"><span class="tp-wx-h-time">${esc(h.time)}</span>${esc(h.text)}</div>`).join('')}
    </div>` : ''}
    ${w.plan ? `<p class="tp-note">→ ${rich(w.plan)}</p>` : ''}
  </div>`).join('')}
  <p class="tp-note">出典: ${esc(trip.weatherSource)}</p>
</section>`;

const days = trip.days.map(day => `
<section class="tp-page">
  <h1 class="tp-day-title">${dayLabel(day.date)}　${esc(day.title)}</h1>
  <p class="tp-day-sub">${esc(day.dayType)}ダイヤ${day.sub ? '　／　' + esc(day.sub) : ''}</p>
  <table class="tp-tl">
    <colgroup><col class="tp-tl-col-time"><col class="tp-tl-col-type"><col></colgroup>
    ${day.items.map(it => `
    <tr class="tp-tl-row">
      <td class="tp-tl-cell tp-tl-time">${esc(it.time)}${it.until ? `<span class="tp-tl-until">→ ${esc(it.until)}</span>` : ''}</td>
      <td class="tp-tl-cell"><span class="tp-tag tp-tag-${it.type}">${TYPES[it.type]}</span></td>
      <td class="tp-tl-cell tp-tl-body">
        <span class="tp-tl-title">${rich(it.title)}</span>
        ${it.detail ? `<span class="tp-tl-detail">${rich(it.detail)}</span>` : ''}
        ${it.warn ? `<span class="tp-tl-warn">${rich(it.warn)}</span>` : ''}
        ${it.alt ? `<span class="tp-tl-alt">代替: ${rich(it.alt)}</span>` : ''}
      </td>
    </tr>`).join('')}
  </table>
</section>`).join('');

const pill = { unk: '未確認', alt: '代替案', tip: '注意' };
const todo = `
<section class="tp-page">
  <h1 class="tp-h1">事前にやること</h1>
  <ul class="tp-list tp-check">
    ${trip.todo.map(t => `<li class="tp-list-item">${rich(t)}</li>`).join('')}
  </ul>
  <h1 class="tp-h1" style="margin-top:8mm">当日の注意点</h1>
  <ul class="tp-list">
    ${trip.cautions.map(c => `<li class="tp-list-item"><span class="tp-pill tp-pill-${c.kind}">${pill[c.kind]}</span>${rich(c.text)}</li>`).join('')}
  </ul>
</section>`;

// 取得日時が全体と違う出典があるときだけ列を出す
const perSourceAt = trip.sources.some(s => s.fetchedAt && s.fetchedAt !== trip.fetchedAt);
const sources = `
<section class="tp-page">
  <h1 class="tp-h1">出典一覧</h1>
  <p class="tp-note">情報取得: ${esc(trip.fetchedAt)}${perSourceAt ? '（個別に異なるものは右列）' : '（全出典共通）'}</p>
  <table class="tp-src">
    <colgroup><col class="tp-src-col-no"><col>${perSourceAt ? '<col class="tp-src-col-at">' : ''}</colgroup>
    ${trip.sources.map((s, i) => `
    <tr>
      <td class="tp-src-cell">${i + 1}</td>
      <td class="tp-src-cell">${esc(s.label)}<br><span class="tp-src-url">${esc(s.url)}</span></td>
      ${perSourceAt ? `<td class="tp-src-cell">${esc(s.fetchedAt ?? trip.fetchedAt)}</td>` : ''}
    </tr>`).join('')}
  </table>
</section>`;

const fontDir = pathToFileURL(join(here, 'fonts')).href;
const html = readFileSync(join(here, 'template.html'), 'utf8')
  .replace('{{TITLE}}', esc(trip.title))
  .replaceAll('{{FONT_DIR}}', fontDir)
  .replace('{{BODY}}', cover + weather + days + todo + sources);

const outDir = join(root, 'output');
mkdirSync(outDir, { recursive: true });
const stem = `${trip.title}_${trip.days[0].date.replaceAll('-', '')}`;
const htmlPath = join(outDir, `${stem}.html`);
const pdfPath = join(outDir, `${stem}.pdf`);
writeFileSync(htmlPath, html);

// ---------- 2b. Googleドキュメント用 HTML ----------
// Docs の取り込みはクラスの CSS や grid が効かないので、インラインの表だけで組む。
// ローカルのパス（フォント）は入れない。カレンダー添付用。
const docRow = it => `<tr><td>${esc(it.time)}${it.until ? '→' + esc(it.until) : ''}</td><td>${TYPES[it.type]}</td><td><b>${rich(it.title)}</b>${it.detail ? '<br>' + rich(it.detail) : ''}${it.warn ? `<br><span style="color:#a61b1b">${rich(it.warn)}</span>` : ''}${it.alt ? '<br>代替: ' + rich(it.alt) : ''}</td></tr>`;
const docHtml = `<html><head><meta charset="utf-8"></head><body style="font-size:10pt">
<h1>${esc(trip.title)}　${trip.days.map(d => dayLabel(d.date)).join('〜')}</h1>
<p><b>出発</b> ${esc(trip.origin)}<br><b>宿</b> ${esc(trip.lodging.name)}（チェックイン${esc(trip.lodging.checkin)}／チェックアウト${esc(trip.lodging.checkout)}）${trip.lodging.transfer ? `<br><b>送迎</b> ${rich(trip.lodging.transfer)}` : ''}<br><b>移動手段</b> ${esc(trip.transport)}</p>
<p style="color:#7b8794">情報取得: ${esc(trip.fetchedAt)}。営業時間・時刻は変わることがあります。</p>
<h2>天気（${esc(trip.weatherSource)}）</h2>
${trip.weather.map(w => `<p><b>${dayLabel(w.date)}</b>　${rich(w.summary)}<br>${(w.hourly ?? []).map(h => `${esc(h.time)} ${esc(h.text)}`).join('／')}${w.plan ? '<br>→ ' + rich(w.plan) : ''}</p>`).join('\n')}
${trip.days.map(day => `<h2>${dayLabel(day.date)}　${esc(day.title)}（${esc(day.dayType)}ダイヤ）</h2>
<table style="border-collapse:collapse;width:100%" border="1" cellpadding="4"><tr><th>時刻</th><th>種別</th><th>内容・補足</th></tr>
${day.items.map(docRow).join('\n')}</table>`).join('\n')}
<h2>事前にやること</h2><ul>${trip.todo.map(t => `<li>☐ ${rich(t)}</li>`).join('')}</ul>
<h2>当日の注意点</h2><ul>${trip.cautions.map(c => `<li><b>[${pill[c.kind]}]</b> ${rich(c.text)}</li>`).join('')}</ul>
<h2>出典（取得: ${esc(trip.fetchedAt)}）</h2><ol>${trip.sources.map(s => `<li>${esc(s.label)} ${esc(s.url)}</li>`).join('')}</ol>
</body></html>`;
const docPath = join(outDir, `${stem}_doc.html`);
writeFileSync(docPath, docHtml);
// 外に出すドキュメントに、予約番号・メールアドレス・ローカルパスが紛れていたら止める
const leaks = [/予約番号|確認番号|会員番号/, /[\w.+-]+@[\w-]+\.[\w.]+/, /[A-Z]:[\\/]|file:\/\//].filter(re => re.test(docHtml));
if (leaks.length) {
  console.error(`\n個人情報・ローカルパスらしき文字列があります: ${leaks.join(' ')}`);
  process.exit(1);
}

// ---------- 3. PDF / 4. 見た目の検査 ----------
const browser = await chromium.launch();
const page = await browser.newPage();
await page.emulateMedia({ media: 'print' });
await page.goto(pathToFileURL(htmlPath).href);
await page.evaluate(() => document.fonts.ready);

const fontOk = await page.evaluate(() => document.fonts.check('12px "Noto Sans JP"', 'あ'));
const layout = await page.evaluate(() => {
  const issues = [];
  // 時刻・ラベルのはみ出し
  for (const el of document.querySelectorAll('.tp-tl-time, .tp-tag, .tp-wx-h')) {
    if (el.scrollWidth > el.clientWidth + 1) issues.push(`はみ出し: "${el.textContent.trim()}"`);
  }
  // 1〜2文字ずつの細切れ折り返し（1行あたりの文字数で判定）
  for (const el of document.querySelectorAll('.tp-tl-title, .tp-tl-detail, .tp-tl-alt, .tp-tl-warn, .tp-list-item, .tp-cover-grid > div, .tp-src-cell, .tp-wx-sum')) {
    const text = el.textContent.trim();
    if (text.length < 6) continue;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    const lines = Math.max(1, Math.round(el.getBoundingClientRect().height / lh));
    if (lines >= 3 && text.length / lines < 4) issues.push(`細切れ折り返し(${lines}行/${text.length}字): "${text.slice(0, 20)}…"`);
  }
  return issues;
});
await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
await browser.close();

console.log(`\n[見た目の検査] フォント読込 ${fontOk ? 'OK' : 'NG'} / 問題 ${layout.length} 件`);
layout.forEach(l => console.log('  ✗ ' + l));

// ---------- 5. PNG ----------
const pngDir = join(outDir, `${stem}_png`);
execFileSync('python', [join(here, 'pdf2png.py'), pdfPath, pngDir], { stdio: 'inherit' });

console.log(`\nPDF : ${pdfPath}`);
console.log(`PNG : ${pngDir}`);
console.log(`DOC : ${docPath}（カレンダー添付用）`);
if (!fontOk || layout.length) process.exit(1);
