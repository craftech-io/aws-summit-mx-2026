#!/usr/bin/env python3
"""Genera las fotos de ejemplo del laboratorio.

Son ilustraciones sintéticas, no fotos reales: alcanzan para que el modelo
multimodal tenga algo concreto que describir y para que el ejercicio del
reclamo con adjunto se pueda hacer sin que cada asistente consiga una imagen.

    python3 scripts/generar-fotos.py
"""

from pathlib import Path
import random

from PIL import Image, ImageDraw, ImageFilter

DEST = Path(__file__).resolve().parent.parent / "data" / "fotos"
ANCHO, ALTO = 1024, 768


def fondo(color_pared="#E8E4DC", color_mesa="#C8A882"):
    """Escena base: pared y mesa, para que parezca una foto de interior."""
    im = Image.new("RGB", (ANCHO, ALTO), color_pared)
    d = ImageDraw.Draw(im)
    d.rectangle([(0, int(ALTO * 0.62)), (ANCHO, ALTO)], fill=color_mesa)
    # veta suave de la mesa
    for i in range(0, ANCHO, 7):
        tono = random.randint(-8, 8)
        c = tuple(max(0, min(255, int(color_mesa[j : j + 2], 16) + tono)) for j in (1, 3, 5))
        d.line([(i, int(ALTO * 0.62)), (i - 60, ALTO)], fill=c, width=3)
    return im, d


def grietas(d, cx, cy, largo, n=9, color="#FFFFFF"):
    """Patrón radial de grietas, como un vidrio golpeado."""
    for _ in range(n):
        x, y = cx, cy
        ang = random.uniform(0, 6.28)
        for _ in range(random.randint(3, 6)):
            dx = int(random.uniform(0.3, 1.0) * largo * random.choice([-1, 1]))
            dy = int(random.uniform(0.3, 1.0) * largo * random.choice([-1, 1]))
            d.line([(x, y), (x + dx, y + dy)], fill=color, width=random.choice([2, 3]))
            x, y = x + dx, y + dy


def monitor_roto(destino):
    """Monitor con la pantalla agrietada — el caso del PED-1078."""
    random.seed(7)
    im, d = fondo()
    # pie y cuerpo
    d.rectangle([(430, 600), (600, 620)], fill="#2A2A2E")
    d.rectangle([(495, 500), (535, 605)], fill="#3A3A40")
    d.rounded_rectangle([(180, 120), (850, 520)], radius=10, fill="#1A1A1E")
    d.rectangle([(200, 140), (830, 495)], fill="#0E1420")
    # el golpe
    cx, cy = 560, 300
    grietas(d, cx, cy, 90, n=11, color="#8FA8C8")
    grietas(d, cx, cy, 45, n=7, color="#FFFFFF")
    d.ellipse([(cx - 26, cy - 26), (cx + 26, cy + 26)], fill="#050810")
    # manchas de píxeles muertos
    for _ in range(70):
        x = random.randint(cx - 190, cx + 190)
        y = random.randint(cy - 130, cy + 130)
        if 200 < x < 830 and 140 < y < 495:
            d.rectangle([(x, y), (x + random.randint(2, 9), y + random.randint(2, 7))], fill="#141C2E")
    d.text((210, 505), "LG 27UP850", fill="#6A6A72")
    im.filter(ImageFilter.GaussianBlur(0.4)).save(destino, quality=88)
    return "monitor con la pantalla agrietada"


def caja_golpeada(destino):
    """Caja de envío abollada y con el precinto abierto."""
    random.seed(11)
    im, d = fondo(color_pared="#DEDAD2")
    d.polygon([(250, 250), (760, 250), (800, 320), (290, 320)], fill="#C99A63")
    d.polygon([(290, 320), (800, 320), (800, 640), (290, 640)], fill="#B8894F")
    d.polygon([(250, 250), (290, 320), (290, 640), (250, 570)], fill="#9E7340")
    # abolladura
    d.polygon([(560, 330), (700, 350), (690, 470), (545, 440)], fill="#9B7442")
    d.line([(560, 330), (690, 470)], fill="#7E5C34", width=4)
    d.line([(700, 350), (545, 440)], fill="#7E5C34", width=3)
    # precinto despegado
    d.rectangle([(430, 320), (500, 640)], fill="#D8D2C4")
    d.polygon([(430, 320), (500, 320), (520, 250), (450, 240)], fill="#E4DED0")
    # etiqueta
    d.rectangle([(320, 380), (470, 470)], fill="#FBFAF6")
    for i in range(6):
        d.line([(335, 400 + i * 11), (455, 400 + i * 11)], fill="#3A3A3A", width=2)
    for i in range(26):
        x = 335 + i * 4
        d.line([(x, 448), (x, 462)], fill="#111", width=random.choice([1, 2]))
    im.filter(ImageFilter.GaussianBlur(0.5)).save(destino, quality=88)
    return "caja de envío abollada, con el precinto abierto"


def teclado_incompleto(destino):
    """Teclado al que le faltan teclas — sirve para «falta_pieza»."""
    random.seed(3)
    im, d = fondo(color_pared="#E2E0DA", color_mesa="#8E8E96")
    d.rounded_rectangle([(150, 260), (880, 560)], radius=14, fill="#26262C")
    faltantes = {(1, 3), (1, 4), (2, 7)}
    for fila in range(4):
        for col in range(12):
            x = 178 + col * 58
            y = 285 + fila * 66
            if (fila, col) in faltantes:
                d.rounded_rectangle([(x, y), (x + 48, y + 52)], radius=5, fill="#0E0E12")
                d.rectangle([(x + 14, y + 18), (x + 34, y + 34)], fill="#2E2E36")
            else:
                d.rounded_rectangle([(x, y), (x + 48, y + 52)], radius=5, fill="#3A3A44")
                d.rounded_rectangle([(x + 3, y + 3), (x + 45, y + 46)], radius=4, fill="#4A4A56")
    d.text((160, 570), "Keychron K2 Pro", fill="#55555E")
    im.filter(ImageFilter.GaussianBlur(0.4)).save(destino, quality=88)
    return "teclado mecánico al que le faltan tres teclas"


def main():
    DEST.mkdir(parents=True, exist_ok=True)
    casos = [
        ("monitor-pantalla-rota.jpg", monitor_roto),
        ("caja-golpeada.jpg", caja_golpeada),
        ("teclado-sin-teclas.jpg", teclado_incompleto),
    ]
    for nombre, fn in casos:
        descripcion = fn(DEST / nombre)
        print(f"  {nombre:28s} {descripcion}")
    print(f"\n{len(casos)} imágenes en {DEST}")


if __name__ == "__main__":
    main()
