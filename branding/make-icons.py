"""Build mdv's icons from branding/logo.png (black cat on cream).

Run from the repo root:  python branding/make-icons.py   (needs Pillow)

Two looks:
  dark  - black cat with a light outline on a dark tile (dark themes, installed app)
  light - the original artwork on a cream tile (light theme)
"""
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFilter

src = sys.argv[1] if len(sys.argv) > 1 else "branding/logo.png"
out = sys.argv[2] if len(sys.argv) > 2 else "web/public"

INK = (10, 10, 10)
PAPER = (250, 248, 242)
DARK = dict(tile=(30, 30, 30), rim=(236, 232, 247))
LIGHT = dict(tile=(245, 240, 228), rim=None)

im = Image.open(src).convert("L")
bbox = ImageChops.invert(im).point(lambda v: 255 if v > 40 else 0).getbbox()
art = im.crop(bbox)
w, h = art.size
side = int(max(w, h) * 1.08)
sq = Image.new("L", (side, side), 252)
sq.paste(art, ((side - w) // 2, (side - h) // 2))
art = sq

# Outside = light pixels connected to the border. Thicken the dark lines first
# so small gaps (where the tail crosses the pages) don't let the fill leak in.
light = art.point(lambda v: 255 if v > 200 else 0)
sealed = light.filter(ImageFilter.MinFilter(25)).convert("RGB")
ImageDraw.floodfill(sealed, (0, 0), (255, 0, 0))
reached = ImageChops.subtract(sealed.split()[0], sealed.split()[1])
outside = ImageChops.multiply(reached.filter(ImageFilter.MaxFilter(27)), light)
shape = ImageChops.invert(outside).filter(ImageFilter.GaussianBlur(1.5))  # cat + pages


def make(size, tile, rim, pad=0.08, radius=0.22, transparent=False):
    inner = int(size * (1 - 2 * pad))
    a = art.resize((inner, inner), Image.LANCZOS)
    s = shape.resize((inner, inner), Image.LANCZOS)
    chan = [a.point(lambda v, i=i: int(INK[i] + (PAPER[i] - INK[i]) * v / 255)) for i in range(3)]
    layer = Image.merge("RGBA", (*chan, s))
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0) if transparent else tile + (255,))
    off = (size - inner) // 2
    if rim:
        k = max(3, int(size * 0.025)) | 1
        halo = s.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.GaussianBlur(0.6))
        rl = Image.new("RGBA", (inner, inner), rim + (255,))
        rl.putalpha(halo)
        base.alpha_composite(rl, (off, off))
    base.alpha_composite(layer, (off, off))
    if not transparent and radius:
        mask = Image.new("L", (size * 4, size * 4), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, size * 4 - 1, size * 4 - 1), int(size * 4 * radius), fill=255)
        base.putalpha(mask.resize((size, size), Image.LANCZOS))
    return base


# Installed app (manifest / Apple): dark look, matching the default theme.
make(512, **DARK).save(f"{out}/icon-512.png")
make(192, **DARK).save(f"{out}/icon-192.png")
make(512, **DARK, pad=0.16, radius=0).save(f"{out}/icon-maskable-512.png")  # art in the safe zone
make(180, **DARK, pad=0.10, radius=0).save(f"{out}/apple-touch-icon.png")

# Favicons and the in-app logo, per theme (switched by settings.ts).
for name, look in (("", DARK), ("-light", LIGHT)):
    make(64, **look, pad=0.04, radius=0.2).save(f"{out}/favicon{name}-64.png")
    make(32, **look, pad=0.02, radius=0.18).save(f"{out}/favicon{name}-32.png")
    make(256, **look, pad=0.02, transparent=True).save(f"{out}/logo-mark{name}.png")
print("ok")
