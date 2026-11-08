# The pictures for the Chrome Web Store listing: real screens of the wallet on the wallet's own
# ground. Takes the output of tests/shots.mjs and tests/site.mjs, and writes to release/store/.
#   python3 scripts/store-images.py SHOTS_DIR SITE_DIR
import os
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
KIT = Path(os.environ.get("KIT", ROOT.parent / "qubits-brand-d3"))
OUT = ROOT / "release" / "store"
FONTS = ROOT / "node_modules" / "@fontsource"
NIGHT, INK, BONE, SOFT = (5, 5, 8), (18, 30, 120), (245, 245, 250), (140, 146, 170)
title_font = ImageFont.truetype(str(FONTS / "poiret-one/files/poiret-one-latin-400-normal.woff"), 62)
text_font = ImageFont.truetype(str(FONTS / "jura/files/jura-latin-400-normal.woff"), 25)

shots, site = Path(sys.argv[1]), Path(sys.argv[2])
PAGES = [
    (shots / "02-home.png", ["Your keys,", "quantum-safe"], "ML-DSA and SLH-DSA signatures, the NIST post-quantum standards."),
    (shots / "08-review.png", ["See it", "before it leaves"], "What goes, what it costs and what stays, before anything is signed."),
    (shots / "12a-tokens-found.png", ["Your tokens,", "already here"], "What you hold shows up by itself. Tap one to send it."),
    (site / "04-swap.png", ["The chain says", "what a call does"], "Qubits sites ask, you approve. The wallet shows what really changes."),
    (site / "05-approve-everything.png", ["Nothing goes", "without you"], "A permission to spend everything is called what it is."),
]


def ground(width, height, cx, cy, r):
    base = Image.new("RGB", (width, height), NIGHT)
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(r / 5))
    base.paste(Image.new("RGB", (width, height), INK), (0, 0), mask)
    return base


def wrapped(text, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if text_font.getlength(trial) > width:
            lines.append(line)
            line = word
        else:
            line = trial
    return [*lines, line]


OUT.mkdir(parents=True, exist_ok=True)
for number, (source, title, line) in enumerate(PAGES, 1):
    page = ground(1280, 800, 300, 620, 330)
    shot = Image.open(source).convert("RGB")
    height = 720
    width = round(shot.width * height / shot.height)
    shot = shot.resize((width, height), Image.LANCZOS)
    x, y = 1280 - width - 110, 40
    draw = ImageDraw.Draw(page)
    draw.rectangle([x - 1, y - 1, x + width, y + height], outline=(40, 44, 60))
    page.paste(shot, (x, y))
    top = 250
    for row in title:
        draw.text((90, top), row, font=title_font, fill=BONE)
        top += 78
    top += 22
    for row in wrapped(line, 560):
        draw.text((90, top), row, font=text_font, fill=SOFT)
        top += 36
    page.save(OUT / f"screenshot-{number}.png")

# drawn large and brought down, or small type comes out unevenly spaced
LARGE = 3
tile = ground(440 * LARGE, 280 * LARGE, 330 * LARGE, 150 * LARGE, 120 * LARGE)
drop = Image.open(KIT / "drop-glow-2048.png").convert("RGBA").crop((144, 0, 1977, 2048))
drop.thumbnail((210 * LARGE, 210 * LARGE), Image.LANCZOS)
tile.paste(drop, (215 * LARGE, 40 * LARGE), drop)
draw = ImageDraw.Draw(tile)
big = ImageFont.truetype(str(FONTS / "poiret-one/files/poiret-one-latin-400-normal.woff"), 58 * LARGE)
small = ImageFont.truetype(str(FONTS / "jura/files/jura-latin-400-normal.woff"), 17 * LARGE)
draw.text((32 * LARGE, 96 * LARGE), "qubits", font=big, fill=BONE)
draw.text((34 * LARGE, 170 * LARGE), "post-quantum wallet", font=small, fill=(170, 180, 230))
tile.resize((440, 280), Image.LANCZOS).save(OUT / "promo-440x280.png")
Image.open(ROOT / "public" / "icons" / "128.png").save(OUT / "icon-128.png")
print("images in", OUT)
