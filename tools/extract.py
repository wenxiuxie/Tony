import pymupdf, os, collections
src = r'C:\Users\joche\OneDrive\D Drive\Josie BHS 11th Grade\Tony Website\Tony-Artist Resume.pdf'
out = 'images'
os.makedirs(out, exist_ok=True)
doc = pymupdf.open(src)
rows=[]
seen=set()
for pno in range(len(doc)):
    for i, info in enumerate(doc[pno].get_images(full=True)):
        xref = info[0]
        if xref in seen: continue
        seen.add(xref)
        try:
            d = doc.extract_image(xref)
        except Exception as e:
            continue
        w,h,ext,img = d['width'], d['height'], d['ext'], d['image']
        name = f'p{pno+1:02d}_x{xref}_{w}x{h}.{ext}'
        open(os.path.join(out,name),'wb').write(img)
        rows.append((pno+1,xref,w,h,ext,len(img),name))
print(f'{len(rows)} unique images extracted from {len(doc)} pages\n')
print(f"{'pg':>3} {'WxH':>12} {'ext':>4} {'KB':>7}  name")
for r in sorted(rows, key=lambda r:(-r[2]*r[3])):
    print(f'{r[0]:>3} {r[2]}x{r[3]:>6} {r[4]:>4} {r[5]//1024:>7}  {r[6]}')
