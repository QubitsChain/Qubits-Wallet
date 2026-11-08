# The toolbar icons, from the brand kit's glowing drop (drop-glow-2048.png; KIT names the kit's folder):
# a square crop around the drop, the halo faded to nothing by the crop's edge so no box shows.
# 16 and 32 are cropped tighter: there the drop's size matters more than the halo.
#   python3 scripts/icons.py [preview.png]
import os
import sys
from pathlib import Path
from PIL import Image, ImageChops

HERE = Path(__file__).resolve().parent
KIT = Path(os.environ.get("KIT", HERE.parents[1] / "qubits-brand-d3"))
OUT = HERE.parent / "public" / "icons"
SIDE = {16: 1320, 32: 1320, 48: 1500, 128: 1500}  # the crop, in source pixels

src = Image.open(KIT / "drop-glow-2048.png").convert("RGBA")
left, top, right, bottom = src.getchannel("A").point(lambda v: 255 if v >= 250 else 0).getbbox()
cx, cy = (left + right) // 2, (top + bottom) // 2
HALF_DROP = (bottom - top) // 2  # the fade stops short of the drop

def fade(n, over):
    ramp = Image.new("L", (n, 1))
    ramp.putdata([round(255 * (t := min(min(i, n - 1 - i) / over, 1)) * t * (3 - 2 * t)) for i in range(n)])
    across = ramp.resize((n, n), Image.NEAREST)
    return ImageChops.multiply(across, across.transpose(Image.Transpose.ROTATE_90))

def icon(px_):
    side = SIDE[px_]
    crop = src.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    crop.putalpha(ImageChops.multiply(crop.getchannel("A"), fade(side, side // 2 - HALF_DROP)))
    return crop.resize((px_, px_), Image.LANCZOS)

icons = {px_: icon(px_) for px_ in SIDE}
OUT.mkdir(parents=True, exist_ok=True)
for px_, im in icons.items():
    im.save(OUT / f"{px_}.png", optimize=True)
print("icons in", OUT)

if len(sys.argv) > 1:
    # the icons on Chrome's light and dark toolbars, 4× (nearest)
    S, PAD = 4, 24
    cell = 128 * S + PAD
    sheet = Image.new("RGBA", (cell * 4 + PAD, (cell + PAD) * 2), (0, 0, 0, 255))
    for row, bg in enumerate(((0xF1, 0xF3, 0xF4, 255), (0x35, 0x36, 0x3A, 255))):
        band = Image.new("RGBA", (sheet.width, cell), bg)
        for col, (px_, im) in enumerate(icons.items()):
            up = im.resize((px_ * S, px_ * S), Image.NEAREST)
            band.paste(up, (PAD + col * cell + (128 * S - px_ * S) // 2, (cell - px_ * S) // 2), up)
        sheet.paste(band, (0, row * (cell + PAD)))
    sheet.convert("RGB").save(sys.argv[1])
    print("preview", sys.argv[1])
