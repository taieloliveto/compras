"""Genera los íconos de la PWA (lista con tilde sobre fondo verde). Uso: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'web', 'icons')
os.makedirs(OUT, exist_ok=True)
GREEN = (27, 143, 90, 255)
WHITE = (255, 255, 255, 255)


def glyph(d, s, scale):
    """Dibuja el ícono centrado; `scale` achica el dibujo (para la zona segura del maskable)."""
    def P(x, y):  # coordenadas en una grilla de 100
        c = s / 2
        return (c + (x - 50) * s / 100 * scale, c + (y - 50) * s / 100 * scale)
    w = int(s / 100 * 7 * scale)
    for (x1, y1, x2, y2) in [(24, 32, 62, 32), (24, 50, 50, 50), (24, 68, 44, 68)]:
        d.line([P(x1, y1), P(x2, y2)], fill=WHITE, width=w)
        for x, y in [(x1, y1), (x2, y2)]:
            px, py = P(x, y); r = w / 2
            d.ellipse([px - r, py - r, px + r, py + r], fill=WHITE)
    pts = [P(58, 62), P(68, 72), P(84, 52)]
    d.line(pts, fill=WHITE, width=w, joint='curve')
    for px, py in [pts[0], pts[2]]:
        r = w / 2
        d.ellipse([px - r, py - r, px + r, py + r], fill=WHITE)


def render(size, rounded, scale):
    big = size * 4
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=GREEN)
    else:
        d.rectangle([0, 0, big, big], fill=GREEN)
    glyph(d, big, scale)
    return img.resize((size, size), Image.LANCZOS)


render(192, True, 1.0).save(os.path.join(OUT, 'icon-192.png'))
render(512, True, 1.0).save(os.path.join(OUT, 'icon-512.png'))
render(512, False, 0.74).save(os.path.join(OUT, 'maskable-512.png'))
# iOS no admite transparencia: fondo lleno, él mismo redondea las esquinas.
render(180, False, 0.9).convert('RGB').save(os.path.join(OUT, 'apple-touch-icon.png'))
print('íconos generados en', os.path.abspath(OUT))
