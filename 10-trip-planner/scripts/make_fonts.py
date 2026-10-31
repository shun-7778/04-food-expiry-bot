"""Noto Sans JP の静的フォント（Regular/Bold）を用意する。

    python scripts/make_fonts.py

可変フォントのままだと Chromium が PDF に Type3（輪郭化）で埋め込むので、
Google Fonts の可変フォントから fontTools で 400/700 を切り出す。
すでに scripts/fonts/ にあれば何もしない（リポジトリには入れていないので、新しい環境で1回だけ実行）。
"""
import sys
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

URL = "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
fonts = Path(__file__).parent / "fonts"
var = fonts / "NotoSansJP.ttf"
targets = {400: "Regular", 700: "Bold"}

if all((fonts / f"NotoSansJP-{n}.ttf").exists() for n in targets.values()):
    print("フォントは用意済み")
    sys.exit(0)

fonts.mkdir(exist_ok=True)
if not var.exists():
    print("可変フォントをダウンロード:", URL)
    urllib.request.urlretrieve(URL, var)

for weight, name in targets.items():
    f = TTFont(var)
    instantiateVariableFont(f, {"wght": weight}, inplace=True, updateFontNames=False)
    # 名前表を Regular/Bold に直す（そのままだと既定インスタンスの Thin を名乗る）
    nm = f["name"]
    for rec in list(nm.names):
        if rec.nameID in (2, 3, 4, 6, 16, 17):
            nm.removeNames(nameID=rec.nameID)
    for pid, eid, lid in [(3, 1, 0x409), (1, 0, 0)]:
        nm.setName(name, 2, pid, eid, lid)
        nm.setName(f"Noto Sans JP {name}", 4, pid, eid, lid)
        nm.setName(f"NotoSansJP-{name}", 6, pid, eid, lid)
        nm.setName(f"NotoSansJP-{name}", 3, pid, eid, lid)
    f["OS/2"].usWeightClass = weight
    f.save(fonts / f"NotoSansJP-{name}.ttf")
    print("作成:", f"NotoSansJP-{name}.ttf")
