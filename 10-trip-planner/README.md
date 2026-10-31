# trip-planner

旅行スケジュールを調べて組み、A4縦のPDFにする Claude Code スキルの作業フォルダ。
頼めば Googleカレンダーの予定に旅程表（Googleドキュメント）を添付する。
手順は [.claude/skills/trip-planner/SKILL.md](../.claude/skills/trip-planner/SKILL.md)。

```
npm i && npm run setup                       # 新しい環境で1回だけ
node scripts/build.mjs trips/<slug>.json     # → output/<旅行名>_<開始日>.pdf ほか
```

| パス | 内容 |
|---|---|
| `scripts/build.mjs` | 中身の検査 → HTML → PDF（Playwright）→ 見た目の検査 → PNG、カレンダー添付用の `_doc.html` |
| `scripts/template.html` | A4縦テンプレート |
| `scripts/pdf2png.py` | PDF→PNG とフォント埋め込みの確認（PyMuPDF） |
| `scripts/make_fonts.py` | Noto Sans JP Regular/Bold を用意（SIL OFL。リポジトリには入れない） |
| `trips/*.json` | 旅行データ。**Git に入れない** |
| `output/` | 出力。**Git に入れない** |
