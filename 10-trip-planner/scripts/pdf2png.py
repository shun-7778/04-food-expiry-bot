"""PDF の各ページを PNG にする（目視確認用）。

    python scripts/pdf2png.py <in.pdf> <out_dir>
"""
import sys
from pathlib import Path

import pymupdf

pdf, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
doc = pymupdf.open(pdf)
for i, page in enumerate(doc, 1):
    page.get_pixmap(dpi=110).save(out / f"p{i:02d}.png")
# 埋め込みフォントの確認（文字化け防止）
fonts = {(f[3], f[2]) for p in doc for f in p.get_fonts()}
print(f"{len(doc)} ページ → {out}")
print("埋め込みフォント:", ", ".join(f"{n}({t})" for n, t in sorted(fonts)) or "なし")
# Type3 だけ＝輪郭化されている（可変フォントを使ったときなど）。文字検索・コピーが不安定になる
if fonts and all(t == "Type3" for _, t in fonts):
    print("注意: フォントが Type3 で埋め込まれている")
    sys.exit(1)
