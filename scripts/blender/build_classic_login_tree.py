#!/usr/bin/env python3
"""Classic MapleStory login-tree art study. Run inside Blender 4.3+."""
import bpy, math, random, os
from mathutils import Vector
from math import sin,cos,pi,sqrt
random.seed(28)
import argparse, sys
from pathlib import Path
parser=argparse.ArgumentParser(description="Rebuild the classic login-tree Blender art study.")
parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[2]/"resources/blender/classic-login-tree"))
parser.add_argument("--render", action="store_true", help="Also render the final 1400x1650 PNG (CPU rendering can take several minutes).")
args=parser.parse_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
OUT=os.path.abspath(args.output_dir)
os.makedirs(OUT, exist_ok=True)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
for d in bpy.data.materials: bpy.data.materials.remove(d)
# --- material palette ---
def mat(name, color, rough=.6, metallic=0):
 m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
 p=m.node_tree.nodes.get('Principled BSDF');p.inputs['Base Color'].default_value=(*color,1);p.inputs['Roughness'].default_value=rough;p.inputs['Metallic'].default_value=metallic
 return m
bark=mat('Living olive bark | sculpted moss & grain',(.31,.38,.055),.82)
n=bark.node_tree.nodes;l=bark.node_tree.links;p=n.get('Principled BSDF')
tc=n.new('ShaderNodeTexCoord');mp=n.new('ShaderNodeVectorMath');mp.operation='MULTIPLY';mp.inputs[1].default_value=(3.5,3.5,.37);l.new(tc.outputs['Generated'],mp.inputs[0]);noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=12;noise.inputs['Detail'].default_value=4;l.new(mp.outputs[0],noise.inputs['Vector']);r=n.new('ShaderNodeValToRGB');r.color_ramp.elements[0].position=.19;r.color_ramp.elements[0].color=(.055,.095,.009,1);r.color_ramp.elements[1].position=.79;r.color_ramp.elements[1].color=(.52,.61,.10,1);e=r.color_ramp.elements.new(.47);e.color=(.22,.32,.026,1);l.new(noise.outputs['Fac'],r.inputs[0]);l.new(r.outputs[0],p.inputs['Base Color']);b=n.new('ShaderNodeBump');b.inputs['Strength'].default_value=.24;b.inputs['Distance'].default_value=.16;l.new(noise.outputs['Fac'],b.inputs['Height']);l.new(b.outputs[0],p.inputs['Normal'])
bark_light=mat('Raised golden-green grain',(.40,.48,.077),.83)
bark_dark=mat('Deep warm bark creases',(.095,.13,.019),.92)
leaves=[mat('Foliage %02d'%i,c,.7) for i,c in enumerate([(.12,.34,.025),(.18,.43,.036),(.28,.53,.055),(.38,.61,.083),(.11,.30,.052),(.34,.51,.038),(.46,.61,.10)])]
for m in leaves: m.node_tree.nodes.get('Principled BSDF').inputs['Subsurface Weight'].default_value=.04
moss=mat('Velvety moss',(.32,.49,.035),1)
grassmat=[mat('Meadow grass %d'%i,c,.95) for i,c in enumerate([(.26,.44,.046),(.39,.52,.076),(.19,.34,.035),(.50,.60,.11)])]
earth=mat('Forest earth',(.21,.15,.062),.93)
pathmat=mat('Warm winding footpath',(.54,.41,.20),.94)
wood=mat('Honey weathered timber',(.30,.13,.039),.65)
woodlight=mat('Plank top edge',(.53,.28,.067),.6)
cream=mat('Ivory mushroom stems',(.78,.66,.36),.8)
gillmat=mat('Mushroom gill shadows',(.47,.37,.16),.8)
orange=mat('Classic orange cap',(.92,.205,.012),.32)
yellow=mat('Golden yellow cap',(1,.56,.016),.36)
red=mat('Burnt vermilion cap',(.68,.105,.012),.37)
window=mat('Warm window glow',(1,.61,.13),.28);p=window.node_tree.nodes.get('Principled BSDF');p.inputs['Emission Color'].default_value=(1,.38,.035,1);p.inputs['Emission Strength'].default_value=.6
black=mat('Dark door recess',(.045,.049,.012),1)
stone=mat('Soft moss stones',(.31,.36,.17),.86)
# Helpers
colls={}
def put(o,c):
 if c not in colls:
  colls[c]=bpy.data.collections.new(c);bpy.context.scene.collection.children.link(colls[c])
 for cc in list(o.users_collection):cc.objects.unlink(o)
 colls[c].objects.link(o);return o

def mesh(name,verts,faces,ma,collection):
 me=bpy.data.meshes.new(name);me.from_pydata(verts,[],faces);me.update();o=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(o);o.data.materials.append(ma)
 for f in me.polygons:f.use_smooth=True
 return put(o,collection)

def curve(name,pts,radius,ma,coll='03 · Bark detail',res=2):
 cu=bpy.data.curves.new(name,'CURVE');cu.dimensions='3D';cu.resolution_u=12;cu.bevel_depth=radius;cu.bevel_resolution=res
 sp=cu.splines.new('BEZIER');sp.bezier_points.add(len(pts)-1)
 for p,co in zip(sp.bezier_points,pts):p.co=co;p.handle_left_type='AUTO';p.handle_right_type='AUTO'
 o=bpy.data.objects.new(name,cu);bpy.context.collection.objects.link(o);o.data.materials.append(ma);return put(o,coll)

def tube(name,points,radii,ma=bark,coll='01 · Ancient tree',sides=24,steps=8,ripple=.09):
 # Catmull-Rom interpolation; custom sweeping surface with fluted cross-sections
 pp=[Vector(x) for x in points]; vv=[];rr=[]
 for k in range(len(pp)-1):
  p0=pp[max(0,k-1)];p1=pp[k];p2=pp[k+1];p3=pp[min(len(pp)-1,k+2)]
  for j in range(steps):
   t=j/steps;vv.append(.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t));rr.append(radii[k]*(1-t)+radii[k+1]*t)
 vv.append(pp[-1]);rr.append(radii[-1]);v=[];f=[]
 for i,(p,r) in enumerate(zip(vv,rr)):
  tangent=(vv[min(i+1,len(vv)-1)]-vv[max(i-1,0)]).normalized();ref=Vector((0,1,0))
  if abs(ref.dot(tangent))>.94:ref=Vector((1,0,0))
  u=tangent.cross(ref).normalized();w=tangent.cross(u).normalized()
  for j in range(sides):
   a=2*pi*j/sides;rf=r*(1+ripple*sin(7*a+i*.07)+.035*cos(11*a-i*.035));v.append(p+rf*(cos(a)*u+sin(a)*w))
 for i in range(len(vv)-1):
  for j in range(sides):a=i*sides+j;b=i*sides+(j+1)%sides;f.append((a,b,b+sides,a+sides))
 f.append(tuple(range(sides-1,-1,-1)));f.append(tuple((len(vv)-1)*sides+j for j in range(sides)))
 return mesh(name,v,f,ma,coll)

def uv(name,loc,scale,ma,coll='05 · Forest details',seg=24,rings=12):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=seg,ring_count=rings,location=loc);o=bpy.context.object;o.name=name;o.scale=scale;o.data.materials.append(ma)
 for p in o.data.polygons:p.use_smooth=True
 return put(o,coll)

def cube(name,loc,scale,ma,bev=.06,coll='06 · Mushroom dwelling'):
 bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.dimensions=scale;bpy.ops.object.transform_apply(location=False,rotation=False,scale=True);o.data.materials.append(ma)
 if bev:mod=o.modifiers.new('Soft carved edges','BEVEL');mod.width=bev;mod.segments=3;o.modifiers.new('Weighted normals','WEIGHTED_NORMAL')
 return put(o,coll)

def groundz(x,y):return .12+.19*sin(x*.35)*cos(y*.43)+.1*sin(y*.8)+.014*y
# Broad endless forest ground
v=[];f=[];N=80
for iy in range(N+1):
 y=-17+iy*.55
 for ix in range(N+1):
  x=-22+ix*.55;v.append((x,y,groundz(x,y)))
for iy in range(N):
 for ix in range(N):a=iy*(N+1)+ix;f.append((a,a+1,a+N+2,a+N+1))
g=mesh('Undulating mossy forest floor',v,f,grassmat[0],'04 · Forest floor')
# shader ground broad color mottles
n=grassmat[0].node_tree.nodes;l=grassmat[0].node_tree.links;p=n.get('Principled BSDF');noise=n.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=1.8;noise.inputs['Detail'].default_value=3;r=n.new('ShaderNodeValToRGB');r.color_ramp.elements[0].color=(.055,.12,.016,1);r.color_ramp.elements[1].color=(.36,.48,.072,1);l.new(noise.outputs['Fac'],r.inputs[0]);l.new(r.outputs[0],p.inputs['Base Color'])
# winding dirt trail on right
v=[];f=[]
for i in range(100):
 y=-16+i*.4;center=3.6+2*sin(y*.16);width=1.4+0.32*cos(y*.2)
 for side in [-1,1]:
  x=center+side*width;v.append((x,y,groundz(x,y)+.027))
for i in range(99):a=i*2;f.append((a,a+1,a+3,a+2))
mesh('Sinuous sunlit path',v,f,pathmat,'04 · Forest floor')
# monumental trunk with spiral braided columns
TX,TY=-2.2,1.3
main=tube('Ancient trunk · irregular longitudinal sculpt',[(TX,TY,-.2),(TX-.15,TY,2),(TX+.2,TY+.05,5),(TX-.25,TY+.12,8),(TX+.05,TY+.25,11),(TX+.5,TY+.4,14),(TX+.25,TY+.5,17.3)],[2.05,1.88,1.54,1.45,1.22,.94,.44],sides=64,steps=14,ripple=.14)
# bark flowing ribs are substantial irregular ridges rather than texture only
for i in range(15):
 a=2*pi*i/15;pts=[];rads=[]
 for j in range(10):
  z=j*1.75;ang=a+.20*sin(z*.45+a)+.033*z;rad=1.99-z*.069+.13*sin(z*.7+a)
  pts.append((TX+cos(ang)*rad+.14*sin(z*.5),TY+sin(ang)*rad,z));rads.append((.29-.010*z)*(.85+.25*sin(z+i)))
 tube('Twisting cambium ridge %02d'%i,pts,rads,bark,'03 · Bark detail',16,5,.045)
# large buttress roots, roots flattened against earth at tips
for i in range(10):
 a=2*pi*i/10+.15;reach=random.uniform(3.8,5.5);startz=random.uniform(1.5,3.5)
 pts=[(TX+1.1*cos(a),TY+1.1*sin(a),startz),(TX+1.9*cos(a+.05),TY+1.9*sin(a+.05),.85),(TX+3*cos(a-.04),TY+3*sin(a-.04),.32),(TX+reach*cos(a+.12),TY+reach*sin(a+.12),groundz(TX+reach*cos(a+.12),TY+reach*sin(a+.12))+.07)]
 tube('Buttress root %02d'%i,pts,[.68,.61,.33,.028],bark,sides=28,steps=12,ripple=.1)
 for j in [-1,1]:
  pp=[(p[0]+j*.13,p[1]-.065,p[2]+r*.68) for p,r in zip(pts,[.6,.48,.25,.005])]
  curve('Raised grain on root',pp,.035,bark_light)
# branches twisting outward, with crown on each end
branches=[([(TX,TY,7),(TX-2,TY,8.2),(TX-4.4,TY+.4,8.4),(TX-5.5,TY+1.1,10.1)],[1.05,.67,.37,.09]), ([(TX+.2,TY,9),(TX+1.5,TY+.4,10.5),(TX+3.6,TY+.7,10.8),(TX+5,TY+1,12)],[.92,.6,.31,.07]), ([(TX,TY,12),(TX-1.4,TY,13.2),(TX-3.5,TY+.4,13.6),(TX-4.2,TY+.5,14.5)],[.76,.51,.24,.05]), ([(TX,TY,14),(TX+1.5,TY+.5,15.8),(TX+3.3,TY+.3,16.3)],[.64,.35,.06]), ([(TX,TY+.4,15),(TX-1,TY+.3,17.1),(TX-2.2,TY+.2,18)],[.52,.3,.06])]
for k,(pts,r) in enumerate(branches):tube('Ancient spreading bough %02d'%k,pts,r,sides=32,steps=12)
# coils characteristic of original tree
for k,(basez,side) in enumerate([(4.6,-1),(7.8,1),(10.2,-1)]):
 pts=[(TX+side*1.4,TY-.55,basez-2.2),(TX+side*1.9,TY-.4,basez-.4),(TX+side*.9,TY-1.6,basez+1),(TX-side*.4,TY-1.1,basez+2.4)]
 tube('Braided outer living root %d'%k,pts,[.47,.5,.4,.15],sides=30,steps=12)
# many thin sweeping grooves along front face
for i in range(55):
 a=pi*1.06+i/(54)*pi*.82;z0=random.uniform(.4,3);z1=random.uniform(7,15.7);pts=[]
 for j in range(10):
  z=z0+(z1-z0)*j/9;ang=a+.13*sin(z*.6+i*.43)+.023*z;rad=1.96-z*.073+.07*sin(z*.8+i)
  pts.append((TX+cos(ang)*rad+.15*sin(z*.5),TY+sin(ang)*rad,z))
 curve('Fine bark incision %03d'%i,pts,random.uniform(.010,.023),bark_dark,res=1)
# knot eye outlined on face
for rrr in [1,1.24]:
 pts=[]
 for i in range(18):
  t=2*pi*i/17;pts.append((TX-.2+rrr*.32*sin(t),TY-1.56-.055*cos(t),5.2+rrr*.67*cos(t)))
 curve('Flowing bark knot',pts,.05,bark_light)
# canopy meshes, leafy clumps with detailed surface leaf cards
leafverts=[];leaffaces=[];leafmats=[]
def addleaf(center,size,ang,tilt,mi):
 c=Vector(center);u=Vector((cos(ang),sin(ang),tilt)).normalized()*size;v=Vector((-sin(ang),cos(ang),.12))*size*.47
 ids=len(leafverts)
 # pointed folded almond leaf (6 vertices)
 leafverts.extend([c-u,c-u*.48+v*.75,c+u*.48+v*.8,c+u,c+u*.5-v*.8,c-u*.45-v*.8,c+Vector((0,0,size*.17))]);leaffaces.extend([(ids+i,ids+(i+1)%6,ids+6) for i in range(6)]);leafmats.extend([mi]*6)
def crown(center,scale,seed):
 random.seed(seed);cx,cy,cz=center;sx,sy,sz=scale
 # custom silhouette clumps with lumpy surface rather than individual floating balls
 for k in range(15):
  a=k*2.39996;rr=sqrt((k+.6)/15);x=cx+cos(a)*rr*sx*.76;y=cy+sin(a)*rr*sy*.7;z=cz+sz*(.2+.64*(1-rr*rr))+random.uniform(-.25,.25)
  ss=random.uniform(.66,1.15);o=uv('Sculpted foliage mass', (x,y,z),(sx*.32*ss,sy*.34*ss,sz*.57*ss),leaves[random.choice([0,1,2,4])],'02 · Layered canopy',seg=16,rings=10)
  # leaf sprays over visible top and edges
  for j in range(88):
   az=random.uniform(0,2*pi);ct=random.uniform(-.25,1);st=sqrt(1-ct*ct)
   xx=x+cos(az)*st*sx*.32*ss;yy=y+sin(az)*st*sy*.34*ss;zz=z+ct*sz*.57*ss
   addleaf((xx,yy,zz),random.uniform(.17,.34),random.uniform(0,2*pi),random.uniform(-.5,.5),random.choices(range(7),[1,2,4,4,1,2,2])[0])
# asymmetrical tiers inspired by login map original
for i,(c,s) in enumerate([((-6.8,2.5,10.3),(3.25,2.9,1.25)),((2.6,3,12.2),(3.5,2.7,1.32)),((-5.7,2.4,14.8),(3.7,2.8,1.32)),((.2,2.2,16.6),(3.9,3.1,1.4)),((-3.1,2.1,18.5),(4.0,3.4,1.5))]):crown(c,s,60+i)
# leaf maple star patches clinging trunk characteristic reference
for i in range(90):
 z=random.uniform(.3,14.4);a=random.uniform(pi*1.1,pi*1.94);rr=2.11-z*.07;x=TX+cos(a)*rr;y=TY+sin(a)*rr
 for k in range(random.randint(3,7)):addleaf((x+random.uniform(-.2,.2),y-.05,z+random.uniform(-.3,.3)),random.uniform(.17,.35),random.uniform(0,2*pi),random.uniform(-.7,.8),random.choice([2,3,5,6]))
lm=mesh('Individual pointed leaves · editable geometry',leafverts,leaffaces,leaves[0],'02 · Layered canopy')
for m in leaves[1:]:lm.data.materials.append(m)
for p,mi in zip(lm.data.polygons,leafmats):p.material_index=mi
# Mushrooms lathed caps, gills and tapered curved stems
def mushroom(name,loc,size,ma,lean=0):
 x,y,z=loc;h=size*1.3;r=size*.92
 tube(name+' · curved ivory stem',[(x,y,z),(x+.12*size,y,z+h*.5),(x+lean*size,y,z+h)],[size*.29,size*.22,size*.25],cream,'07 · Classic mushrooms',sides=24,steps=9,ripple=.025)
 cx=x+lean*size;cy=y
 # domed irregular cap profile
 prof=[(0,1.53),(.20,1.51),(.43,1.42),(.66,1.26),(.86,1.04),(1,.85),(1.03,.76),(.99,.70),(.87,.67),(.65,.73),(.32,.82),(0,.86)]
 vs=[];fs=[];nr=64
 for k,(rad,zz) in enumerate(prof):
  for j in range(nr):
   a=2*pi*j/nr;wav=1+.025*sin(a*5+.3)+.016*cos(a*7);vs.append((cx+rad*r*cos(a)*wav,cy+rad*r*sin(a)*wav,z+h+size*(zz-.80)+.025*size*sin(a*3)))
 for k in range(len(prof)-1):
  for j in range(nr):a=k*nr+j;b=k*nr+(j+1)%nr;fs.append((a,b,b+nr,a+nr))
 o=mesh(name+' · hand-profiled cap',vs,fs,ma,'07 · Classic mushrooms');o.data.materials.append(cream)
 for p in o.data.polygons:
  if p.index>=7*nr:p.material_index=1
 mod=o.modifiers.new('Soft cap surface','SUBSURF');mod.levels=1;mod.render_levels=1
 for j in range(28):
  a=2*pi*j/28;pts=[(cx+cos(a)*r*.25,cy+sin(a)*r*.25,z+h+.028*size),(cx+cos(a)*r*.65,cy+sin(a)*r*.65,z+h-.04*size),(cx+cos(a)*r*.91,cy+sin(a)*r*.91,z+h-.11*size)]
  curve(name+' · underside radial gill',pts,size*.013,gillmat,'07 · Classic mushrooms',1)
 return (cx,cy,z+h)
# exact orange + golden pair at foot of trunk
mushroom('Hero orange mushroom',(-4.7,-1.7,groundz(-4.7,-1.7)),1.55,orange,-.15)
mushroom('Golden companion mushroom',(-2.45,-2.35,groundz(-2.45,-2.35)),.94,yellow,.26)
mushroom('Small olive mushroom',(-5.8,-2.05,groundz(-5.8,-2.05)),.59,cream,.08)
# saprophytes cling to left side of trunk
for loc,sz,ma in [((-4,-.2,3.1),.53,orange),((-3.55,-.7,2.8),.40,cream),((-4.2,.2,8.9),.40,yellow)]:mushroom('Tree shelf mushroom',loc,sz,ma,-.16)
for i in range(17):
 x=random.uniform(-9,8);y=random.uniform(-4,10)
 if (x-TX)**2+(y-TY)**2<15:continue
 mushroom('Forest baby mushroom %02d'%i,(x,y,groundz(x,y)),random.uniform(.10,.28),orange if i%3 else yellow,.12)
# mushroom tree-house tucked into left trunk as original
hx,hy,hz=-4.08,1.0,7.75
mushroom('Orange-roof tree dwelling',(hx,hy,hz),1.08,orange,0)
# house wall below roof
uv('Ivory tree-house walls',(hx,hy-.07,hz+.59),(.77,.70,.89),cream,'06 · Mushroom dwelling')
# dark arched front door and frame
uv('Arched doorway recess',(hx,hy-.735,hz+.34),(.24,.055,.40),black,'06 · Mushroom dwelling')
cube('Door timber',(hx,hy-.785,hz+.26),(.39,.055,.54),wood,.04)
for i in [-1,0,1]:cube('Door vertical plank',(hx+i*.12,hy-.82,hz+.26),(.012,.025,.52),woodlight,.003)
uv('Door brass handle',(hx+.12,hy-.84,hz+.28),(.035,.022,.035),yellow,'06 · Mushroom dwelling')
# balcony wooden planks
for i in range(9):
 x=hx-1.13+i*.28;yy=hy-.3
 cube('Balcony plank %02d'%i,(x,yy,hz-.26),(.26,1.7,.14),woodlight,.035)
curve('Balcony curved rustic rail',[(hx-1.15,hy-.98,hz+.3),(hx-.5,hy-1.12,hz+.29),(hx+.4,hy-1.13,hz+.34),(hx+1.13,hy-1,hz+.31)],.055,wood,'06 · Mushroom dwelling')
for i in range(7):
 x=hx-1.12+i*.37;tube('Balcony branch baluster',[(x,hy-1.05,hz-.25),(x+.035,hy-1.05,hz+.31)],[.045,.035],wood,'06 · Mushroom dwelling',sides=8,steps=1,ripple=0)
# winding vine near dwelling
curve('Climbing ivy stem',[(-3.0,-.3,6.3),(-3.5,-.75,6.9),(-3.0,-.7,7.6),(-3.2,-.4,8.8),(-3.4,0,9.7)],.053,bark_light,'03 · Bark detail')
# background forest towering teal-green silhouettes
backmats=[mat('Distant tree mist %d'%i,c,.95) for i,c in enumerate([(.10,.27,.16),(.14,.35,.22),(.20,.40,.25)])]
for i in range(16):
 x=-23+i*3.1;y=random.uniform(11,20);h=random.uniform(12,22);r=random.uniform(.45,.95)
 tube('Distant forest trunk %02d'%i,[(x,y,0),(x+.4,y,h*.55),(x-.3,y,h)],[r*1.5,r,r*.32],backmats[i%3],'08 · Background forest',sides=14,steps=5)
 for j in range(3):uv('Distant soft canopy',(x+random.uniform(-2,2),y,h-j*3),(random.uniform(3,5),2,1.6),backmats[i%3],'08 · Background forest',seg=12,rings=8)
# grass blade meshes clustered naturally
v=[];f=[];mis=[];random.seed(512)
for i in range(9000):
 x=random.uniform(-16,16);y=random.uniform(-10,18);c=3.6+2*sin(y*.16);wid=1.35+.32*cos(y*.2)
 if abs(x-c)<wid and random.random()<.985:continue
 if (x-TX)**2+(y-TY)**2<3:continue
 h=random.uniform(.08,.43);w=h*random.uniform(.08,.18);a=random.uniform(0,2*pi);z=groundz(x,y);idx=len(v)
 for k in range(3):
  ak=a+k*1.1;dx=cos(ak);dy=sin(ak);le=random.uniform(.75,1.2);ii=len(v);v.extend([(x-w*dy,y+w*dx,z),(x+w*dy,y-w*dx,z),(x+h*.24*dx+w*.4*dy,y+h*.24*dy-w*.4*dx,z+h*.58*le),(x+h*.43*dx,y+h*.43*dy,z+h*le)]);f.extend([(ii,ii+1,ii+2),(ii,ii+2,ii+3)]);mis.extend([random.randrange(4)]*2)
o=mesh('Thousands of individually bent grass blades',v,f,grassmat[0],'04 · Forest floor')
for m in grassmat[1:]:o.data.materials.append(m)
for p,mi in zip(o.data.polygons,mis):p.material_index=mi
# tiny stones and forest carpet blooms
for i in range(65):
 x=random.uniform(-11,12);y=random.uniform(-7,10)
 if (x-TX)**2+(y-TY)**2<8:continue
 s=random.uniform(.06,.23);o=uv('Mossy pebble',(x,y,groundz(x,y)+s*.24),(s,s*.7,s*.4),stone,seg=12,rings=6);o.rotation_euler.z=random.random()*6.28
petal=mat('Small buttercup petals',(.98,.72,.08),.55)
for i in range(45):
 x=random.uniform(-10,10);y=random.uniform(-5,8)
 if abs(x-(3.6+2*sin(y*.16)))<1.3:continue
 z=groundz(x,y)+random.uniform(.17,.33)
 for j in range(5):a=2*pi*j/5;uv('Woodland yellow flower',(x+.055*cos(a),y+.055*sin(a),z),(.052,.033,.025),petal,'05 · Forest details',seg=8,rings=4)
# motes sparsely suspended
mote=mat('Floating pollen',(1,.73,.2),.4);p=mote.node_tree.nodes.get('Principled BSDF');p.inputs['Emission Color'].default_value=(1,.61,.17,1);p.inputs['Emission Strength'].default_value=2.2
for i in range(60):
 x=random.uniform(-8,10);y=random.uniform(-2,8);z=random.uniform(.6,12);s=random.uniform(.010,.024);uv('Sunlit drifting pollen',(x,y,z),(s,s,s),mote,'09 · Light & atmosphere',seg=8,rings=4)
# light and camera
world=bpy.data.worlds.new('Turquoise forest atmosphere');bpy.context.scene.world=world;world.use_nodes=True;world.node_tree.nodes['Background'].inputs[0].default_value=(.24,.43,.39,1);world.node_tree.nodes['Background'].inputs[1].default_value=.40

def area(name,loc,energy,color,size,target):
 data=bpy.data.lights.new(name,'AREA');data.energy=energy;data.color=color;data.shape='DISK';data.size=size;o=bpy.data.objects.new(name,data);bpy.context.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector(target)-o.location).to_track_quat('-Z','Y').to_euler();put(o,'09 · Light & atmosphere')
area('Warm woodland sun · upper right',(5,-4,17),2100,(1,.84,.50),6,(-2,0,4))
area('Cool sky fill',(-7,-5,9),950,(.62,.81,1),9,(-1,1,6))
area('Golden rim behind branches',(5,8,16),3300,(1,.88,.53),5,(-2,1,5))
# directional sun
sun=bpy.data.lights.new('Soft dappled daylight','SUN');sun.energy=1.8;sun.angle=.12;sun.color=(1,.90,.66);o=bpy.data.objects.new('Soft dappled daylight',sun);bpy.context.collection.objects.link(o);o.rotation_euler=(.40,-.46,-.52);put(o,'09 · Light & atmosphere')
# volume for distant tree layers, kept light to preserve saturated foreground
vol=bpy.data.materials.new('Thin forest haze');vol.use_nodes=True;n=vol.node_tree.nodes;n.clear();out=n.new('ShaderNodeOutputMaterial');vv=n.new('ShaderNodeVolumePrincipled');vv.inputs['Density'].default_value=.009;vv.inputs['Color'].default_value=(.58,.74,.53,1);vv.inputs['Anisotropy'].default_value=.35;vol.node_tree.links.new(vv.outputs['Volume'],out.inputs['Volume'])
o=cube('Atmospheric forest volume',(0,10,12),(50,45,30),vol,0,'09 · Light & atmosphere');o.display_type='WIRE'
# camera: unmistakable old-login lower forest with towering living tree and mushroom house
bpy.ops.object.camera_add(location=(12,-29,12.1));cam=bpy.context.object;cam.name='CAMERA · Login forest hero';target=Vector((-1.0,1.1,8.9));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=23.0;cam.data.lens=46;put(cam,'10 · Cameras');bpy.context.scene.camera=cam
# secondary closer camera internally useful
bpy.ops.object.camera_add(location=(9,-24,8.0));c=bpy.context.object;c.name='CAMERA · Original login roots detail';c.rotation_euler=(Vector((-1.2,.2,4.4))-c.location).to_track_quat('-Z','Y').to_euler();c.data.type='ORTHO';c.data.ortho_scale=15.8;put(c,'10 · Cameras')
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=48;scene.cycles.use_denoising=False;scene.cycles.max_bounces=6;scene.cycles.volume_bounces=1;scene.render.resolution_x=1600;scene.render.resolution_y=1400;scene.render.resolution_percentage=65;scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.view_settings.view_transform='AgX';scene.view_settings.look='AgX - Medium High Contrast';scene.view_settings.exposure=.25
scene.render.filepath=os.path.join(OUT,'maplestory_tree_preview.png');scene.render.threads_mode='FIXED';scene.render.threads=8
# subtle bloom via compositor
scene.use_nodes=True;n=scene.node_tree.nodes;n.clear();r=n.new('CompositorNodeRLayers');gl=n.new('CompositorNodeGlare');gl.glare_type='FOG_GLOW';gl.quality='HIGH';gl.threshold=2;gl.mix=-.92;out=n.new('CompositorNodeComposite');scene.node_tree.links.new(r.outputs['Image'],gl.inputs[0]);scene.node_tree.links.new(gl.outputs[0],out.inputs[0])
scene['Artwork']='Classic MapleStory Login Tree · fan-made editable 3D study'
scene['Reference']='https://www.inven.co.kr/board/maple/2316/2135; https://peak.nexon.com/en/post/1208'
scene['Authoring']='Original procedural mesh modeling in Blender 4.3.2. No AI-generated image used in render.'
# open file on material view and camera
for screen in bpy.data.screens:
 for a in screen.areas:
  if a.type=='VIEW_3D':a.spaces.active.region_3d.view_perspective='CAMERA'

# Reference-specific architecture pass.
random.seed(19)
# hide overly distant primary crown and old house replaced with referenced architecture
for o in list(bpy.data.objects):
 if o.name.startswith(('Distant soft canopy','Orange-roof tree dwelling','Ivory tree-house walls','Arched doorway','Door timber','Door vertical','Door brass','Balcony')):o.hide_render=True
 if o.name.startswith('Fine bark incision') and int(o.name.split()[-1])%3!=0:o.hide_render=True
# re-color to bold mossy-gold grooves in reference
r=[n for n in bark.node_tree.nodes if n.type=='VALTORGB'][0]
r.color_ramp.elements[0].color=(.035,.073,.003,1);r.color_ramp.elements[1].color=(.16,.27,.012,1);r.color_ramp.elements[2].color=(.39,.48,.047,1)
# raise sunlight saturation, kill large coarse smoke
bpy.data.objects['Atmospheric forest volume'].hide_render=True
# giant side stem connected with roots, asymmetric open split
pts=[(-.8,1,.1),(.1,1.4,1.5),(.5,1.6,4.0),(.1,1.4,5.6),(1.2,1.7,7.4),(.7,2.0,9.2)]
tube('Secondary sinuous trunk · original fork',pts,[.9,.70,.48,.50,.34,.1],sides=36,steps=12,ripple=.11)
for k in range(5):
 pp=[(p[0]+.30*cos(k*1.3),p[1]-.24-.08*sin(k),p[2]) for p in pts];tube('Side stem deep flowing ridge',pp,[.18,.16,.15,.14,.12,.015],bark,'03 · Bark detail',14,7,.03)
# front patches of graphic pointed maple-like broad leaves
v=[];f=[];mi=[]
def starleaf(x,y,z,s,rot,material):
 idx=len(v);v.append((x,y-.06,z));
 for i in range(14):
  a=2*pi*i/14+rot;rr=s*(1 if i%2==0 else .43);v.append((x+rr*cos(a),y+.12*abs(sin(a)),z+rr*sin(a)))
 for i in range(14):f.append((idx,idx+1+i,idx+1+(i+1)%14));mi.append(material)
for j in range(55):
 z=random.uniform(.6,15.3);x=-2.2+random.choice([-1,1])*random.uniform(1.1,1.7);y=.12
 for k in range(3):starleaf(x+random.uniform(-.24,.24),y-random.uniform(.1,.3),z+random.uniform(-.2,.2),random.uniform(.21,.40),random.uniform(0,6.2),random.choice([2,3,5]))
o=mesh('Graphic maple leaf clusters on bark',v,f,leaves[0],'03 · Bark detail')
for ma in leaves[1:]:o.data.materials.append(ma)
for p,ii in zip(o.data.polygons,mi):p.material_index=ii
# architecture palette
navy=mat('Classic blue ceramic plinth',(.042,.09,.18),.38)
gold=mat('Warm golden trim',(.88,.50,.056),.34)
green=mat('Storybook emerald door',(.042,.36,.046),.57)
stonehouse=mat('Warm limestone round house',(.80,.71,.43),.72)
rope=mat('Natural flax rope',(.56,.40,.17),.88)
roof=orange
# rounded tapered cylinder and lathe tools
def lathe(name,center,profile,ma,coll='06 · Mushroom dwelling',segments=64):
 x,y,z=center;v=[];f=[]
 for rr,zz in profile:
  for i in range(segments):a=2*pi*i/segments;v.append((x+rr*cos(a),y+rr*sin(a),z+zz))
 for k in range(len(profile)-1):
  for j in range(segments):a=k*segments+j;b=k*segments+(j+1)%segments;f.append((a,b,b+segments,a+segments))
 return mesh(name,v,f,ma,coll)
def arch_shape(name,x,y,z,w,h,depth,ma):
 pts=[(-w/2,0),(w/2,0),(w/2,h-w/2)]
 for j in range(13):a=j*pi/12;pts.append((w/2*cos(a),h-w/2+w/2*sin(a)))
 pts.append((-w/2,0));v=[(x+xx,y+yy,z+zz) for yy in [0,depth] for xx,zz in pts];L=len(pts);f=[tuple(range(L-1,-1,-1)),tuple(range(L,2*L))]
 for k in range(L):f.append((k,(k+1)%L,(k+1)%L+L,k+L))
 return mesh(name,v,f,ma,'06 · Mushroom dwelling')
def house(name,x,y,z,s,kind):
 # wall shape softly swelling like old reference
 lathe(name+' · ivory plaster wall',(x,y,z),[(0,0),(.70*s,0),(.80*s,.12*s),(.86*s,.8*s),(.77*s,1.42*s),(.68*s,1.58*s),(0,1.58*s)],stonehouse)
 lathe(name+' · blue ceramic foundation',(x,y,z),[(0,-.14*s),(.88*s,-.14*s),(.96*s,-.04*s),(.96*s,.12*s),(.83*s,.18*s),(0,.18*s)],navy)
 lathe(name+' · golden base edge',(x,y,z),[(.86*s,-.09*s),(.97*s,-.04*s),(.97*s,.005*s),(.88*s,.06*s)],gold)
 # orange witch-hat-shaped mushroom roof original
 lathe(name+' · curved orange cap roof',(x,y,z),[(0,2.67*s),(.22*s,2.61*s),(.37*s,2.42*s),(.64*s,2.19*s),(.91*s,1.99*s),(1.12*s,1.79*s),(1.16*s,1.60*s),(1.08*s,1.52*s),(.86*s,1.59*s),(0,1.66*s)],roof)
 lathe(name+' · cream scalloped eave',(x,y,z),[(.65*s,1.52*s),(.94*s,1.48*s),(1.05*s,1.58*s),(.90*s,1.64*s)],cream)
 for j in range(23):
  a=2*pi*j/23;uv(name+' eave corbel',(x+.99*s*cos(a),y+.99*s*sin(a),z+1.52*s),(.10*s,.10*s,.13*s),cream,'06 · Mushroom dwelling',12,6)
 if kind=='door':
  arch_shape(name+' · green arched door',x,y-.835*s,z+.12*s,.87*s,1.22*s,.11*s,green)
  # arch surrounding timber segments
  for j in range(11):
   a=j*pi/10;xx=x+.52*s*cos(a);zz=z+.85*s+.52*s*sin(a);ob=cube(name+' · arch keystone timber',(xx,y-.87*s,zz),(.17*s,.19*s,.20*s),woodlight,.025);ob.rotation_euler.y=a-pi/2
  for i in [-1,1]:cube(name+' · doorway upright',(x+i*.51*s,y-.88*s,z+.48*s),(.17*s,.18*s,.78*s),woodlight,.025)
  for i in range(5):cube(name+' door carved seam',(x+(i-2)*.15*s,y-.853*s,z+.56*s),(.013*s,.016*s,.77*s),bark_dark,.003)
  for xx in [-.08,.08]:
   bpy.ops.mesh.primitive_torus_add(major_radius=.068*s,minor_radius=.015*s,major_segments=16,minor_segments=6,location=(x+xx*s,y-.90*s,z+.64*s),rotation=(pi/2,0,0));o=bpy.context.object;o.name='Paired iron door rings';o.data.materials.append(navy);put(o,'06 · Mushroom dwelling')
  # small attic dormer projects from orange roof
  arch_shape(name+' roof dormer dark aperture',x+.28*s,y-.65*s,z+1.9*s,.44*s,.53*s,.10*s,black)
  for xx in [-.22,.22]:cube(name+' dormer side frame',(x+.28*s+xx*s,y-.69*s,z+2.11*s),(.08*s,.12*s,.42*s),woodlight,.025)
  pts=[(x+.04*s,y-.69*s,z+2.1*s),(x+.07*s,y-.69*s,z+2.36*s),(x+.28*s,y-.69*s,z+2.48*s),(x+.49*s,y-.69*s,z+2.36*s),(x+.51*s,y-.69*s,z+2.1*s)];curve(name+' curved dormer hood',pts,.065*s,woodlight,'06 · Mushroom dwelling')
  cube(name+' dormer windowsill',(x+.28*s,y-.79*s,z+1.91*s),(.60*s,.19*s,.08*s),woodlight,.025)
 else:
  arch_shape(name+' dark arched window',x,y-.835*s,z+.43*s,.66*s,.83*s,.08*s,black)
  cube(name+' window sill',(x,y-.95*s,z+.41*s),(.86*s,.31*s,.09*s),woodlight,.025)
  cube(name+' window center mullion',(x,y-.93*s,z+.78*s),(.055*s,.05*s,.72*s),woodlight,.013)
  cube(name+' window crossbar',(x,y-.94*s,z+.73*s),(.66*s,.06*s,.055*s),woodlight,.012)
  for side in [-1,1]:
   o=cube(name+' open wood shutter',(x+side*.55*s,y-.77*s,z+.82*s),(.36*s,.08*s,.74*s),woodlight,.025);o.rotation_euler.z=side*.30
   for j in range(3):cube(name+' shutter plank',(x+side*.55*s+(j-1)*.10*s,y-.84*s,z+.82*s),(.011*s,.015*s,.66*s),wood,.002)
# lower window house partly embedded in huge main trunk
house('Lower window house',-2.75,-.6,5.7,1.1,'window')
# main middle-level arched green door house
house('Middle green-door house',-2.3,-.29,11.0,1.23,'door')
# reference long timber bridge to the right at middle house level
z=11.05;start=-1.6;end=6.3;y=-1.03
for i in range(28):
 x=start+(end-start)*i/27;zz=z-.20*sin(i*pi/27)
 tube('Bridge round cross-plank %02d'%i,[(x,y-.68,zz),(x,y+.55,zz)],[.105,.105],wood,'11 · Rope bridge',12,1,.02)
 # visible cut circular grain front discs
 tube('Endgrain light disc %02d'%i,[(x,y-.692,zz),(x,y-.706,zz)],[.081,.081],woodlight,'11 · Rope bridge',16,1,0)
 # fine annular ring in each cut end, via curve
 pts=[(x+.051*cos(a*2*pi/18),y-.714,zz+.051*sin(a*2*pi/18)) for a in range(19)];curve('Annual growth ring',pts,.007,wood,'11 · Rope bridge',1)
for yy in [y-.62,y+.51]:
 for i in [0,5,11,17,23,27]:
  x=start+(end-start)*i/27;zz=z-.20*sin(i*pi/27);tube('Bridge wooden upright',[(x,yy,zz-.15),(x+.03,yy,zz+.79)],[.082,.061],wood,'11 · Rope bridge',12,3,.02)
 # visible rope sag in three spans
 for k in range(3):
  a=start+(end-start)*k/3;b=start+(end-start)*(k+1)/3
  pts=[(a,yy,z+.75),((a+b)/2,yy,z+.35),(b,yy,z+.75)];curve('Hand twisted catenary rope',pts,.043,rope,'11 · Rope bridge')
  # helically colored fibers along rope small
 for sign in [-1,1]:tube('Bridge diagonal under-brace',[(start,yy,z-1.2),((start+end)/2,yy,z-.24),(end,yy,z-.4)],[.13,.12,.1],wood,'11 · Rope bridge',12,3,.01)
# roots blend plinth to trunk
for off in [-1,1]:tube('Living root around lower dwelling',[(-2.4+off*.8,-.35,4.7),(-2.65+off*1.0,-.38,5.6),(-2.6+off*.9,-.5,6.3)],[.22,.25,.14],bark,sides=20,steps=8)
# slightly hanging ivy beneath right branch
for j in range(12):
 x=random.uniform(-6,4);y=random.uniform(2,4);z=random.uniform(9,16);curve('Hanging tendril',[(x,y,z),(x+.07,y,z-.4),(x-.11,y,z-random.uniform(.6,1.5))],.021,bark_dark,'02 · Layered canopy')
# add detailed distant foliage rather than bare primitives
leafverts=[];leaffaces=[];leafmats=[]
for i in range(14):
 x=-20+i*3.0;y=random.uniform(15,22);z=random.uniform(8,17)
 for k in range(5):
  xx=x+random.uniform(-1.8,1.8);yy=y+random.uniform(-1,1);zz=z+random.uniform(-1.8,1.8);sc=random.uniform(1.1,2.1)
  ob=uv('Distant textured leafy cluster',(xx,yy,zz),(sc,sc*.85,sc*.7),leaves[random.choice([0,1,4])],'08 · Background forest',12,8)
  for j in range(80):
   a=random.random()*2*pi;ct=random.uniform(-1,1);st=sqrt(1-ct*ct);addleaf((xx+cos(a)*st*sc,yy+sin(a)*st*sc*.85,zz+ct*sc*.7),random.uniform(.24,.48),random.uniform(0,6.28),random.uniform(-.8,.8),random.choice([0,1,2,4]))
o=mesh('Detailed distant foliage surface',leafverts,leaffaces,leaves[0],'08 · Background forest')
for ma in leaves[1:]:o.data.materials.append(ma)
for p,ii in zip(o.data.polygons,leafmats):p.material_index=ii
# Local mist placed only BEHIND primary tree
vol=bpy.data.materials['Thin forest haze'];vv=[n for n in vol.node_tree.nodes if n.type=='PRINCIPLED_VOLUME'][0];vv.inputs['Density'].default_value=.024;vv.inputs['Color'].default_value=(.48,.70,.59,1)
o=cube('Distant mist layer',(0,19,11),(55,15,30),vol,0,'09 · Light & atmosphere');o.display_type='WIRE'
scene=bpy.context.scene;cam=scene.camera;cam.location=(7,-30,10.4);target=Vector((-.45,.7,8.0));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=19.5
scene.render.resolution_x=1350;scene.render.resolution_y=1550;scene.render.resolution_percentage=55;scene.cycles.use_denoising=False;scene.cycles.samples=48;scene.view_settings.exposure=-.30
scene.render.filepath=os.path.join(OUT,'refined_draft.png');scene.world.node_tree.nodes['Background'].inputs[1].default_value=.3
bpy.data.lights['Soft dappled daylight'].energy=1.2;bpy.data.lights['Warm woodland sun · upper right'].energy=1700;bpy.data.lights['Cool sky fill'].energy=700

# Final presentation and render settings.
s=bpy.context.scene
# The canopy is modeled with individual pointed leaf geometry; remove the smooth construction volumes.
for o in bpy.data.objects:
 if o.name.startswith('Sculpted foliage mass'):o.hide_render=True
 if o.name.startswith('Distant textured leafy cluster'):o.hide_render=True
 if o.name.startswith('Distant forest trunk'):
  # soften strong geometric background verticals
  ma=o.data.materials[0]
  ma.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value=(.18,.31,.23,1)
# A complete ground plane beneath the handcrafted foreground avoids a visible set edge.
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.12));o=bpy.context.object;o.name='Seamless forest ground continuation';o.data.materials.append(bpy.data.materials['Meadow grass 0'])
# Darker backdrop trunks recede into luminous turquoise air.
vol=bpy.data.materials['Thin forest haze'];vv=[n for n in vol.node_tree.nodes if n.type=='PRINCIPLED_VOLUME'][0];vv.inputs['Density'].default_value=.07;vv.inputs['Emission Color'].default_value=(.09,.20,.15,1);vv.inputs['Emission Strength'].default_value=.1
# shift camera to retain roots while cropping the never-seen top, as the original tall login map did
cam=s.camera;cam.location=(5.6,-31.5,10.6);target=Vector((-.65,.7,8.2));cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.ortho_scale=18.3
s.render.resolution_x=1400;s.render.resolution_y=1650;s.render.resolution_percentage=100;s.cycles.samples=256;s.cycles.use_adaptive_sampling=True;s.cycles.adaptive_threshold=.025;s.cycles.adaptive_min_samples=48;s.cycles.use_denoising=False
s.view_settings.exposure=-.13;s.render.filepath=os.path.join(OUT,'MapleStory_Classic_Login_Tree_Blender.png')
s['Verified output']='Actual Cycles render of modeled mesh scene; custom tree, mushroom roofs, wooden houses, rope bridge and individual foliage.'

# Self-contained project: no external image textures; relative preview output.
s.render.filepath="//MapleStory_Classic_Login_Tree_Blender.png"
bpy.context.preferences.filepaths.save_version=0
blend_path=os.path.join(OUT,"Classic_MapleStory_Login_Tree.blend")
bpy.ops.wm.save_as_mainfile(filepath=blend_path,compress=True)
if args.render:
    bpy.ops.render.render(write_still=True)
print("Created editable Blender art study:",blend_path)
