import pymupdf, os, glob
os.makedirs('web', exist_ok=True)
n=0
for f in glob.glob('images/*'):
    base=os.path.splitext(os.path.basename(f))[0]
    try:
        p=pymupdf.Pixmap(f)
        if p.n>4: p=pymupdf.Pixmap(pymupdf.csRGB,p)
        # downscale preview copies for viewing
        p.save(f'web/{base}.png')
        n+=1
    except Exception as e:
        print('FAIL',f,e)
print('converted',n)
