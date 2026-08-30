from PIL import Image
import numpy as np
im = Image.open('web/p11_x485_717x371.png').convert('RGB')
a = np.asarray(im).astype(np.int16)
# luminance
lum = (0.299*a[...,0] + 0.587*a[...,1] + 0.114*a[...,2])
# saturation-ish: white ink is neutral & very bright
mx = a.max(axis=2); mn = a.min(axis=2)
sat = mx - mn
mask = (lum > 175) & (sat < 45)
print('ink pixels:', mask.sum(), 'of', mask.size)
# crop to lettering bounding box
ys, xs = np.where(mask)
print('bbox', xs.min(), ys.min(), xs.max(), ys.max())
alpha = np.clip((lum - 150) * (255/80), 0, 255).astype(np.uint8)
alpha[~mask] = 0
out = np.zeros((*mask.shape,4), np.uint8)
out[...,0:3] = 255
out[...,3] = alpha
img = Image.fromarray(out,'RGBA')
img.save('ink_raw.png')
# preview on dark bg
bg = Image.new('RGB', img.size, (11,10,12)); bg.paste(img,(0,0),img); bg.save('ink_preview.png')
print('saved')
