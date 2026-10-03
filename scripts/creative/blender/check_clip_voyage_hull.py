"""Regression for the on-plane vertex loss that opened triangular hull holes."""
import importlib.util
from pathlib import Path
from mathutils import Vector
p=Path(__file__).with_name('clip_voyage_hull.py');spec=importlib.util.spec_from_file_location('clip',p);clip=importlib.util.module_from_spec(spec);spec.loader.exec_module(clip)
def vertex(x,y):return (Vector((x,y,0)),[Vector((x*.3,y*.2))],Vector((0,0,1)))
def area(poly):return sum((poly[i][0]-poly[0][0]).cross(poly[i+1][0]-poly[0][0]).length/2 for i in range(1,len(poly)-1))
planes=[(Vector((1,0,0)),0),(Vector((0,1,0)),0)]
for poly in [[vertex(-2,-1),vertex(2,-1),vertex(0,3)],[vertex(0,0),vertex(2,0),vertex(0,2)],[vertex(-2,0),vertex(2,0),vertex(0,3)]]:
 inside,outside=clip.partition(poly,planes)
 assert abs(area(poly)-area(inside)-sum(map(area,outside)))<1e-7,'multiple cuts must conserve source area'
 for part in [inside,*outside]:
  for co,uv,n in part:
   assert (uv[0]-Vector((co.x*.3,co.y*.2))).length<1e-7,'source UV interpolation'
   assert abs(n.length-1)<1e-7,'source normal interpolation'
print('PASS exact clipping: on-plane vertices, repeated orthogonal cuts, conserved area, source UV and normals')
