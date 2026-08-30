from PIL import Image
import numpy as np, os
DEST = r'C:\Users\joche\OneDrive\D Drive\Josie BHS 11th Grade\Tony Website\site\img'
os.makedirs(DEST, exist_ok=True)

# --- 1. ink logo: crop keyed lettering to bbox + padding ---
ink = Image.open('ink_raw.png')
a = np.asarray(ink)[...,3]
ys, xs = np.where(a > 8)
pad = 12
box = (max(0,xs.min()-pad), max(0,ys.min()-pad), min(ink.width,xs.max()+pad), min(ink.height,ys.max()+pad))
logo = ink.crop(box)
logo.save(os.path.join(DEST,'ink-overthinking.webp'), lossless=True)
print('ink logo', logo.size)

# --- 2. photos -> webp, capped on long edge ---
jobs = [
 ('web/p01_x916_2039x2331.png', 'hero-portrait',      1600),
 ('web/p02_x53_2131x1208.png',  'portrait-orange',    1800),
 ('web/p10_x413_557x779.png',   'portrait-dark',       900),
 ('web/p10_x411_558x780.png',   'portrait-golden',     900),
 ('web/p03_x119_709x710.png',   'album-overthinking',  800),
 ('web/p03_x118_718x713.png',   'album-saturn',        800),
 ('web/p08_x366_934x917.png',   'live-hardrock',      1000),
 ('web/p07_x361_1889x858.png',  'live-stage',         1600),
]
for src, name, cap in jobs:
    im = Image.open(src).convert('RGB')
    if max(im.size) > cap:
        r = cap/max(im.size)
        im = im.resize((round(im.width*r), round(im.height*r)), Image.LANCZOS)
    p = os.path.join(DEST, name+'.webp')
    im.save(p, quality=86, method=6)
    print(f'{name:22} {im.size[0]}x{im.size[1]}  {os.path.getsize(p)//1024}KB')
