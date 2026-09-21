# -*- coding: utf-8 -*-
"""リッチメニュー画像を生成する。

2列×4行。1タイル＝角丸のカードで、左に線画アイコン、右に見出し。
色の役割は次のとおり。
  ペールブルー／青 … 左列（買い物リスト表示／追加／削除・材料確認）
  緑               … 右列の在庫まわり（在庫確認・期限登録・使用済）
  グレー           … 取消（在庫にも買い物リストにも属さないので中間色）

配色は2通りある。使う人ごとにどちらを貼るかを選べるよう、2枚を別々に作る。

  python richmenu.py                 → richmenu.png       + RichMenuImage.gs
  python richmenu.py --theme light   → richmenu-light.png + RichMenuImageLight.gs

下地は LINE のトーク画面そのものの色に合わせてある。リッチメニューは
下のメニューバーと接して出るので、そこと同じ色にすると継ぎ目が見えない。
実機のスクリーンショットから拾った値は次のとおり。
  ダーク: トーク背景 #121212 ／ メニューバー #1E1E1E ／ ヘッダ #2A2A2A
  ライト: メニューバー #FFFFFF ／ 面 #F7F8FA
"""
import base64
import io
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686
COLS = 2
ROWS = 4

THEMES = {
    # 下地は LINE のメニューバーと同じ #1E1E1E。タイルはヘッダと同じ #2A2A2A に置き、
    # LINE 自身が使っている明るさの段差にそのまま乗せる
    'dark': {
        'bg': (30, 30, 30),
        'tile': (42, 42, 42),
        'edge': (58, 58, 58),        # 面との差は小さく、輪郭だけ分かる程度
        'text': (237, 237, 237),
        'green': (74, 222, 128),     # 暗い地では LINE 緑は沈むので、明るい緑を使う
        'blue': (147, 197, 253),
        'gray': (156, 163, 175),
    },
    # 白地では明るい緑や水色は飛んでしまうので、濃いほうへ振る。
    # LINE のブランド緑 #06C755 は白の上では 2.3:1 しかなく、線画では細って見えるため使わない。
    # ここの緑は 5.4:1、青は 5.0:1。どちらも文字と同じ基準（4.5:1）を満たす濃さ
    'light': {
        'bg': (255, 255, 255),
        'tile': (243, 245, 248),
        'edge': (214, 219, 226),
        'text': (23, 27, 33),
        'green': (7, 122, 62),
        'blue': (29, 111, 208),
        'gray': (75, 85, 99),
    },
}

# ---- 引数。--theme のほかに、出力先を1つだけ位置引数で渡せる
argv = sys.argv[1:]
THEME = 'dark'
if '--theme' in argv:
    i = argv.index('--theme')
    THEME = argv[i + 1]
    del argv[i:i + 2]
if THEME not in THEMES:
    raise SystemExit('--theme は %s のいずれか' % ' / '.join(sorted(THEMES)))

pal = THEMES[THEME]
BG = pal['bg']
TILE = pal['tile']
TILE_EDGE = pal['edge']
TEXT = pal['text']
GREEN = pal['green']
PALE_BLUE = pal['blue']      # 左列。買い物リストと材料確認をひとまとまりに見せる
GRAY = pal['gray']

MARGIN = 26                  # タイルどうしの隙間
RADIUS = 34

FONT = "C:/Windows/Fonts/YuGothB.ttc"
label_font = ImageFont.truetype(FONT, 96, index=0)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


# ---------------------------------------------------------------- アイコン
#
# すべて線画。lw は線の太さで、タイルの大きさに対して一定の比率になるよう
# 呼び出し側から渡す。cx, cy は中心、s は一辺の目安。

def icon_camera(cx, cy, s, c, lw):
    """カメラ＝材料確認（押すと写真選択画面が開く）"""
    w, h = s, s * 0.76
    x0, y0 = cx - w / 2, cy - h / 2 + s * 0.06
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.14, outline=c, width=lw)
    # 上部のポップアップ（ファインダー部分）
    bw = w * 0.28
    d.line([(cx - bw * 0.5, y0), (cx - bw * 0.34, y0 - s * 0.11),
            (cx + bw * 0.18, y0 - s * 0.11), (cx + bw * 0.34, y0)],
           fill=c, width=lw, joint="curve")
    r = h * 0.26
    d.ellipse([cx - r, cy + s * 0.06 - r, cx + r, cy + s * 0.06 + r], outline=c, width=lw)


def icon_box(cx, cy, s, c, lw):
    """箱＝在庫確認"""
    w, h = s * 0.94, s * 0.94
    x0, y0 = cx - w / 2, cy - h / 2
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.14, outline=c, width=lw)
    d.line([(x0, y0 + h * 0.33), (x0 + w, y0 + h * 0.33)], fill=c, width=lw)
    d.line([(cx, y0 + h * 0.33), (cx, y0 + h)], fill=c, width=lw)


def icon_list(cx, cy, s, c, lw):
    """チェックリスト＝買い物リスト表示"""
    w = s * 0.98
    x0 = cx - w / 2
    for i in range(3):
        ly = cy + (i - 1) * s * 0.34
        # 左のチェック
        d.line([(x0, ly), (x0 + w * 0.10, ly + s * 0.10), (x0 + w * 0.28, ly - s * 0.12)],
               fill=c, width=lw, joint="curve")
        # 右の横線。下の行ほど短くして一覧らしく見せる
        d.line([(x0 + w * 0.44, ly), (x0 + w * (1.0 - i * 0.12), ly)], fill=c, width=lw)


def icon_calendar_plus(cx, cy, s, c, lw):
    """カレンダーに＋＝期限登録"""
    w, h = s * 0.94, s * 0.88
    x0, y0 = cx - w / 2, cy - h / 2 + s * 0.06
    d.rounded_rectangle([x0, y0, x0 + w, y0 + h], radius=s * 0.13, outline=c, width=lw)
    d.line([(x0, y0 + h * 0.30), (x0 + w, y0 + h * 0.30)], fill=c, width=lw)
    for fx in (0.28, 0.72):
        d.line([(x0 + w * fx, y0 - s * 0.10), (x0 + w * fx, y0 + s * 0.08)], fill=c, width=lw)
    # 中の＋
    px, py, pr = cx, y0 + h * 0.66, s * 0.16
    d.line([(px - pr, py), (px + pr, py)], fill=c, width=lw)
    d.line([(px, py - pr), (px, py + pr)], fill=c, width=lw)


def icon_plus_circle(cx, cy, s, c, lw):
    """丸に＋＝買い物リスト追加"""
    r = s * 0.47
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=c, width=lw)
    a = r * 0.48
    d.line([(cx - a, cy), (cx + a, cy)], fill=c, width=lw)
    d.line([(cx, cy - a), (cx, cy + a)], fill=c, width=lw)


def icon_check_circle(cx, cy, s, c, lw):
    """丸にチェック＝使用済"""
    r = s * 0.47
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=c, width=lw)
    d.line([(cx - r * 0.42, cy + r * 0.02), (cx - r * 0.10, cy + r * 0.34),
            (cx + r * 0.46, cy - r * 0.32)], fill=c, width=lw, joint="curve")


def icon_trash(cx, cy, s, c, lw):
    """ごみ箱＝買い物リスト削除"""
    w, h = s * 0.70, s * 0.78
    x0, y0 = cx - w / 2, cy - h / 2 + s * 0.10
    # 本体
    d.line([(x0, y0), (x0 + w * 0.10, y0 + h), (x0 + w * 0.90, y0 + h), (x0 + w, y0)],
           fill=c, width=lw, joint="curve")
    # ふたと取っ手
    d.line([(x0 - w * 0.14, y0), (x0 + w * 1.14, y0)], fill=c, width=lw)
    d.line([(cx - w * 0.24, y0 - s * 0.13), (cx + w * 0.24, y0 - s * 0.13)], fill=c, width=lw)
    d.line([(cx - w * 0.24, y0 - s * 0.13), (cx - w * 0.24, y0)], fill=c, width=lw)
    d.line([(cx + w * 0.24, y0 - s * 0.13), (cx + w * 0.24, y0)], fill=c, width=lw)
    # 中の縦線
    for fx in (0.36, 0.64):
        d.line([(x0 + w * fx, y0 + h * 0.22), (x0 + w * fx, y0 + h * 0.80)], fill=c, width=lw)


def icon_undo(cx, cy, s, c, lw):
    """左へ戻る円形の矢印＝取消"""
    r = s * 0.42
    # PIL の角度は 0=右, 90=下, 270=上。上を開けた円弧にする
    # （300°から600°=240°まで、右回りに描く）
    d.arc([cx - r, cy - r, cx + r, cy + r], start=300, end=600, fill=c, width=lw)

    # 円弧の左上の端に矢じりを置く
    px = cx + r * math.cos(math.radians(240))
    py = cy + r * math.sin(math.radians(240))
    a = s * 0.20
    d.polygon([(px - a * 1.05, py - a * 0.10),
               (px + a * 0.35, py - a * 1.00),
               (px + a * 0.55, py + a * 0.70)], fill=c)


# ---------------------------------------------------------------- 配置
#
# 並びは main.gs の RICHMENU_CELLS と一致させること。
# 左列を上から、次に右列を上から見ていく順で並べる。
# (col, row, 見出し, アイコン, 色, 文字色)

CELLS = [
    (0, 0, "買い物リスト表示", icon_list,          PALE_BLUE, TEXT),
    (0, 1, "買い物リスト追加", icon_plus_circle,   PALE_BLUE, TEXT),
    (0, 2, "買い物リスト削除", icon_trash,         PALE_BLUE, TEXT),
    (0, 3, "材料確認",       icon_camera,        PALE_BLUE, TEXT),
    (1, 0, "在庫確認",       icon_box,           GREEN,     TEXT),
    (1, 1, "期限登録",       icon_calendar_plus, GREEN,     TEXT),
    (1, 2, "使用済",         icon_check_circle,  GREEN,     TEXT),
    # 取消は在庫にも買い物リストにも属さないので、アイコンだけ中間色にする
    (1, 3, "取消",           icon_undo,          GRAY,      TEXT),
]

CELL_W = W // COLS
CELL_H = H // ROWS

for col, row, title, icon, color, text_color in CELLS:
    x0 = col * CELL_W + MARGIN
    y0 = row * CELL_H + MARGIN
    x1 = (col + 1) * CELL_W - MARGIN
    y1 = (row + 1) * CELL_H - MARGIN

    d.rounded_rectangle([x0, y0, x1, y1], radius=RADIUS,
                        fill=TILE, outline=TILE_EDGE, width=3)

    h = y1 - y0
    icon(x0 + h * 0.44, (y0 + y1) / 2, h * 0.40, color, int(h * 0.055))

    # 見出しはアイコンの右に左揃えで置く。タイルごとに文字数が違うので中央揃えにはしない
    tx = x0 + h * 0.84
    l, t, r, b = d.textbbox((0, 0), title, font=label_font)
    d.text((tx - l, (y0 + y1) / 2 - (b - t) / 2 - t), title, font=label_font, fill=text_color)

    # 文字を大きくしたときに端が切れていないか見張る。
    # 見た目では気づきにくく、リッチメニューは実機に出すまで確認しづらいため
    right_edge = tx + (r - l)
    if right_edge > x1 - MARGIN:
        print("*** はみ出し: %s が %dpx 超過（文字を小さくすること）"
              % (title, right_edge - (x1 - MARGIN)))

# ---------------------------------------------------------------- 出力

# 配色ごとに、画像も .gs も別々の名前にする。GAS 側は2つの変数を見て貼り分ける
NAMES = {
    'dark':  ('richmenu.png',       'RichMenuImage.gs',      'RICHMENU_IMAGE_BASE64'),
    'light': ('richmenu-light.png', 'RichMenuImageLight.gs', 'RICHMENU_IMAGE_LIGHT_BASE64'),
}
png_name, gs_name, var_name = NAMES[THEME]
out = argv[0] if argv else png_name

# 平坦な塗りなのでパレット化すると見た目を保ったまま半分以下になる。
# コードに base64 で埋め込むぶん、小さいほうが扱いやすい。
img.convert("P", palette=Image.ADAPTIVE, colors=64).save(
    out, "PNG", optimize=True, compress_level=9)
print("%s %dx%d %.1f KB" % (out, W, H, os.path.getsize(out) / 1024))

# GAS へ貼り付ける .gs も同時に吐く。PNG だけ更新して貼り忘れる事故を防ぐため
b64 = base64.b64encode(open(out, "rb").read()).decode()
CHUNK = 500
NL = chr(10)
gs = os.path.join(os.path.dirname(out) or ".", gs_name)
with io.open(gs, "w", encoding="utf-8") as f:
    f.write(NL.join([
        u"/**",
        u" * リッチメニューの画像（%dx%d PNG・%s）を base64 で埋め込んだもの。" % (W, H, THEME),
        u" * 手で編集しないこと。richmenu.py が %s と一緒に生成する。" % png_name,
        u" *",
        u" * Drive を使わずに済ませるためにコードへ持たせている。",
        u" * setupRichMenu() から参照する。",
        u" */",
        u"var %s = [" % var_name,
    ] + [u"  '" + b64[i:i + CHUNK] + u"'," for i in range(0, len(b64), CHUNK)]
      + [u"].join('');", u""]))
print("%s base64 %.1f KB" % (gs, len(b64) / 1024))
