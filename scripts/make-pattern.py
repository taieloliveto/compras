"""Convierte la imagen de patrón (líneas claras sobre fondo oscuro) en una máscara con transparencia.
La app la usa como `mask-image`, así el color de las líneas lo pone el tema (claro/oscuro).
Uso: python3 -I scripts/make-pattern.py <imagen-entrada.png> [web/img/pattern.png]"""
import os
import sys

from PIL import Image

src = sys.argv[1]
dst = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'img', 'pattern.png')
os.makedirs(os.path.dirname(dst), exist_ok=True)

im = Image.open(src).convert('L')
W = 1400                                    # ancho de salida: sobra para mostrarla a ~960 px en pantallas de 3x
im = im.resize((W, round(im.height * W / im.width)), Image.LANCZOS)

hist = im.histogram()
bg = max(range(256), key=lambda i: hist[i])  # el gris más frecuente es el fondo
lo, hi = bg + 8, 235                         # lo que queda cerca del fondo es ruido de compresión
alpha = im.point(lambda v: 0 if v <= lo else 255 if v >= hi else round((v - lo) * 255 / (hi - lo)))

out = Image.merge('LA', (Image.new('L', im.size, 255), alpha))
out.save(dst, optimize=True)
print(f'{dst}: {out.size[0]}x{out.size[1]}, fondo detectado={bg}, {os.path.getsize(dst) // 1024} KB')
