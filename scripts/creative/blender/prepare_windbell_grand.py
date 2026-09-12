"""Concept-derived engineering input, authored before the 3D whitebox."""
import json, shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
ROOT=Path(__file__).resolve().parents[3]
OUT=ROOT/'resources/blender/windbell'
ART=ROOT/'resources/scenes/windbell/images'
DATA=json.loads((ROOT/'shared/windbell.json').read_text(encoding='utf-8'))
font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',18)
small=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',14)
for kind in ['island','bridge']:
    im=Image.new('RGB',(1800,1200),'#eee9dc'); d=ImageDraw.Draw(im)
    d.text((36,24),f'WINDBELL {kind.upper()} / ENGINEERING DIMENSION DRAFT',fill='#263731',font=font)
    d.text((36,54),'INPUT TO WHITEBOX. Front: X / -game Y. Top: X / depth Z. Side: depth Z / -game Y. Units: game pixels.',fill='#455047',font=small)
    d.rectangle((35,100,1220,700),outline='#829487',width=2)
    def p(x,y): return (170+x*.35,225+y*.24)
    d.text((50,108),'FRONT / authority foothold lines in red',fill='#263731',font=font)
    # Silhouettes transcribed from reviewed original concepts, not from a 3D render.
    trunk=[(-180,1500),(-80,900),(-140,300),(60,-180),(470,-260),(220,350),(300,780),(700,1250),(430,1420)]
    d.polygon([p(x,y) for x,y in trunk],fill='#ad9d7a',outline='#514e3d')
    d.ellipse((50,148,850,235),fill='#8f9c79',outline='#526849')
    for fh in DATA['maps'][kind]['footholds']:
        a,b=p(fh['x1'],fh['y1']),p(fh['x2'],fh['y2']); depth=50 if kind=='bridge' and fh['id'] in [2,3,4] else 80
        d.polygon([a,b,(b[0]-15,b[1]+depth),(a[0]+15,a[1]+depth)],fill='#a4aa9c',outline='#596353')
        d.line([a,b],fill='#b74636',width=4);d.text((a[0]+5,a[1]-22),str(fh['id']),fill='#9b2c24',font=small)
    hy=550 if kind=='island' else 700
    d.rectangle((*p(2170,hy-400),*p(2470,hy)),fill='#c4ad83',outline='#62573d')
    d.polygon([p(2100,hy-400),p(2320,hy-580),p(2540,hy-400)],fill='#738975')
    d.text((50,666),'Tree trunk 600-900 wide; canopy extends beyond camera; cliffs 450-800 thick; hut 360 x 440.',fill='#3d4e42',font=small)
    d.rectangle((35,730,1220,1140),outline='#829487',width=2)
    d.text((50,743),'TOP / real depth bands and traversable deck',fill='#263731',font=font)
    for z,col,label in [(1000,'#bacfd6','FAR mountains/clouds Z -1800..-3000'),(910,'#8ba597','BACKGROUND trees Z -500..-1600'),(830,'#b79d79','MIDDLE deck Z -120..120; feet Z 0'),(780,'#566e49','FOREGROUND leaves Z 180..500')]:
        d.rectangle((100,z,1110,z+38),fill=col); d.text((120,z+9),label,fill='#20372e',font=small)
    d.text((65,1095),'World extension: X -1800..4400, Y -2200..1600. Collision retains shared/windbell.json only.',fill='#3d4e42',font=small)
    d.rectangle((1250,100,1765,700),outline='#829487',width=2)
    d.text((1270,115),'SIDE / depth and thickness',fill='#263731',font=font)
    for x,top,bottom,col in [(1300,230,630,'#bccdd0'),(1400,300,625,'#8b9b88'),(1510,425,580,'#ad9d7a'),(1640,230,650,'#4f6948')]:d.rectangle((x,top,x+50,bottom),fill=col)
    d.line((1475,425,1595,425),fill='#b74636',width=4)
    d.text((1460,405),'foot Y fixed',fill='#9b2c24',font=small)
    concept=Image.open(ART/('island-keyart.png' if kind=='island' else 'bridge-restored.png')).convert('RGB');concept.thumbnail((500,340));im.paste(concept,(1255,760))
    d.text((1260,1120),'Reviewed original concept / preserved unchanged',fill='#3d4e42',font=small)
    im.save(ART/'three-views'/f'{kind}-engineering-three-views.png')
# Copy verified localized source-art texture patches, retaining provenance.
patch=json.loads((ROOT/'resources/blender/windbell/textures/source-patches.json').read_text(encoding='utf-8'))
for src in (ROOT/'resources/blender/windbell/textures').glob('*.png'):
    dest=OUT/'textures'/src.name
    if not dest.exists():shutil.copy2(src,dest)
(OUT/'textures/source-patches.json').write_text(json.dumps(patch,ensure_ascii=False,indent=2),encoding='utf-8')
for kind,box in [('island',(590,345,1260,625)),('bridge',(470,55,1110,350))]:
    source=ART/('island-keyart.png' if kind=='island' else 'bridge-restored.png')
    dest=OUT/'textures'/f'{kind}-distant-valley.png'
    if not dest.exists():Image.open(source).crop(box).save(dest)
(OUT/'three-view-input.json').write_text(json.dumps({'source':'reviewed original concept images, manual silhouette transcription plus authoritative footholds','stage':'authored before whitebox','maps':DATA['maps'],'depth_bands':{'foreground':[180,500],'middle':[-120,120],'background':[-1600,-500],'far':[-3000,-1800]}},ensure_ascii=False,indent=2),encoding='utf-8')
print('ENGINEERING_THREE_VIEWS_READY')

# Artist-refined material atlas supersedes initial source-art crop studies.
atlas=ART/'material-atlas.png'
if atlas.exists():
    im=Image.open(atlas);w,h=im.size
    regions={'bark':[0,0,w//2,h//2],'wood':[w//2,0,w,h//2],'stone':[0,h//2,w//2,h],'grass':[w//2,h//2,w,h]}
    provenance={}
    for role,box in regions.items():
        for kind in ['island','bridge']:
            name=f'windbell_{kind}_{role}_patch.png';im.crop(box).save(OUT/'textures'/name)
            provenance[name]={'source':str(atlas.relative_to(ROOT)),'crop_xyxy':box,'world_units_per_repeat':320 if role in ['bark','stone'] else 200}
    (OUT/'textures/pure-material-provenance.json').write_text(json.dumps(provenance,ensure_ascii=False,indent=2),encoding='utf-8')
for kind in ['island','bridge']:
    background=ART/f'{kind}-distant-background.png'
    if background.exists():shutil.copy2(background,OUT/'textures'/f'{kind}-distant-valley.png')
