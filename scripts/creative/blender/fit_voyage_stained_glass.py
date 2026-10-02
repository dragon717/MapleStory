# Live Blender MCP: pointed-arch windows built from the generated glass silhouettes.
import bpy, math
from mathutils import Vector
BASE='/Users/muniao/Code/MapleStory/resources/scenes/sky-voyage-v3/'
scene=bpy.data.scenes['SV3_ProductionRig'];bpy.context.window.scene=scene
cabin=bpy.data.objects['SV3_CabinInterior']
archive=bpy.data.scenes.get('SV3_BeforeStainedGlass') or bpy.data.scenes.new('SV3_BeforeStainedGlass')
for o in list(cabin.children_recursive):
    if 'CabinFrontWall' in o.name or 'CabinWindowFrame' in o.name or 'CabinWindowSill' in o.name:
        if not bpy.data.objects.get('BeforeGlass_'+o.name):
            old=o.copy();old.data=o.data.copy();old.name='BeforeGlass_'+o.name;archive.collection.objects.link(old);old.parent=None;old.matrix_world=o.matrix_world
        bpy.data.objects.remove(o,do_unlink=True)
    elif o.get('stained_glass_revision'):bpy.data.objects.remove(o,do_unlink=True)
wood=bpy.data.materials['SV3_CabinWalnut'];gold=bpy.data.materials['SV3_Board_Brass']

def mesh(name,verts,faces,mat,parent=cabin):
    data=bpy.data.meshes.new(name);data.from_pydata(verts,[],faces);data.update();data.materials.append(mat)
    o=bpy.data.objects.new(name,data);scene.collection.objects.link(o);o.parent=parent;o['stained_glass_revision']=1
    return o

def box(name,x0,x1,z0,z1):
    if x1-x0<.001 or z1-z0<.001:return
    v=[(x,y,z) for y in [-31.57,-31.99] for z in [z0,z1] for x in [x0,x1]]
    return mesh(name,v,[(0,1,3,2),(4,6,7,5),(0,4,5,1),(2,3,7,6),(0,2,6,4),(1,5,7,3)],wood)

width,height,bottom=3.6,4.7,1.0
box('SV3_GlassWall_Base',-13.5,13.5,0,bottom)
box('SV3_GlassWall_Crown',-13.5,13.5,bottom+height,6)
previous=-13.5
for index,(name,x) in enumerate(zip(['warrior','mage','archer','rogue'],[-8.1,-2.7,2.7,8.1]),1):
    root=bpy.data.objects['SV2_CabinFrontWindow_%02d'%index];root.location=(x,-31.78,bottom+height/2);root.scale=(1,1,1)
    root['glass_width']=width;root['glass_height']=height;root['glass_class']=name
    box('SV3_GlassWall_Pier_'+str(index),previous,x-width/2,0,6);previous=x+width/2
    image=bpy.data.images.load(BASE+'textures/stained-glass-'+name+'.png',check_existing=True)
    w,h=image.size;pixels=list(image.pixels)
    rows=[]
    for row in range(0,h,16):
        xs=[i for i in range(w) if pixels[(row*w+i)*4+3]>.6]
        if xs:rows.append((row/(h-1),min(xs)/(w-1),max(xs)/(w-1)))
    assert len(rows)>50
    # Bottom-to-top row scan follows the alpha edge; outer frame is real geometry.
    left=[((a-.5)*width,(y-.5)*height) for y,a,b in rows]
    right=[((b-.5)*width,(y-.5)*height) for y,a,b in reversed(rows)]
    outline=left+right;n=len(outline)
    center=(0,-.245,0)
    v=[center]+[(a,-.245,b) for a,b in outline]
    faces=[(0,i+1,(i+1)%n+1) for i in range(n)]
    mat=bpy.data.materials.get('SV3_StainedGlass_'+name) or bpy.data.materials.new('SV3_StainedGlass_'+name)
    mat.use_nodes=True;nodes=mat.node_tree.nodes;nodes.clear()
    sh=nodes.new('ShaderNodeBsdfPrincipled');sh.inputs['Roughness'].default_value=.28;sh.inputs['Metallic'].default_value=.04
    sh.inputs['Emission Strength'].default_value=1.25
    tex=nodes.new('ShaderNodeTexImage');tex.image=image
    out=nodes.new('ShaderNodeOutputMaterial');mat.node_tree.links.new(tex.outputs['Color'],sh.inputs['Base Color']);mat.node_tree.links.new(tex.outputs['Color'],sh.inputs['Emission Color']);mat.node_tree.links.new(sh.outputs['BSDF'],out.inputs['Surface'])
    glass=mesh('SV3_StainedGlass_'+name,v,faces,mat,root);glass['stained_glass_class']=name
    uv=glass.data.uv_layers.new(name='GlassUV')
    for poly in glass.data.polygons:
        for loop in poly.loop_indices:
            co=glass.data.vertices[glass.data.loops[loop].vertex_index].co;uv.data[loop].uv=(co.x/width+.5,co.z/height+.5)
    v=[];f=[]
    for depth in [-.34,-.13]:
        for offset in [0,.13]:
            for a,b in outline:
                direction=Vector((a,b)).normalized();v.append((a+direction.x*offset,depth,b+direction.y*offset))
    for i in range(n):
        j=(i+1)%n
        f.extend([(i,j,n+j,n+i),(2*n+i,3*n+i,3*n+j,2*n+j),(i,2*n+i,2*n+j,j),(n+i,n+j,3*n+j,3*n+i)])
    frame=mesh('SV3_PointArchFrame_'+name,v,f,gold,root)
    # Fill the wall up to the curved aperture, leaving a real through-opening.
    for side in [-1,1]:
        points=left if side<0 else list(reversed(right));v=[];f=[]
        for depth in [-31.57,-31.99]:
            for a,b in points:v.extend([(x+side*width/2,depth,b+bottom+height/2),(x+a,depth,b+bottom+height/2)])
        count=len(points)*2
        for j in range(len(points)-1):
            q=j*2;f.extend([(q,q+1,q+3,q+2),(count+q,count+q+2,count+q+3,count+q+1),(q+1,count+q+1,count+q+3,q+3)])
        mesh('SV3_GlassArchWall_'+name+'_'+str(side),v,f,wood)
    root['glass_source']='built-in image_gen; prompt preserved under textures/; P profession illustration'
box('SV3_GlassWall_Pier_End',previous,13.5,0,6)
scene['stained_glass_revision']='2026-10-03: four generated pointed-arch profession windows, real frames and wall openings'
bpy.ops.export_scene.gltf(filepath=BASE+'models/sky-voyage.glb',export_format='GLB',use_active_scene=True,export_yup=True,export_extras=True,export_apply=False,export_animations=True)
bpy.ops.file.pack_all();bpy.ops.wm.save_as_mainfile(filepath=BASE+'models/sky-voyage.blend',compress=True)
print('FOUR_STAINED_WINDOWS_READY')
