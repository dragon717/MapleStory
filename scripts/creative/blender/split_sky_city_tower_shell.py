"""Split only the imported terrain surrounding the real tower shaft for cutaway.
The rest of the neighbouring island, its material/UVs and the tower floors stay.
"""
import bpy
from mathutils import Vector

def split_tower_surroundings(scene, layout):
    tower=layout['tower'];x,y,z=tower['center'];bottom=y-(len(tower['levels'])-1)*tower['floorHeight']
    # The authored entrance carrier's radius (32m) defines the surrounding rock shell.
    lo=Vector((x-32,-z-32,bottom-2));hi=Vector((x+32,-z+32,y+8))
    report=[]
    for shell in scene.objects:
        if shell.get("tower_adjacent_shell") and "island_id" in shell:del shell["island_id"]
    def split(poly,axis,value,positive):
        inside=[];outside=[]
        for i,a in enumerate(poly):
            b=poly[(i+1)%len(poly)];da=(a[0][axis]-value)*(1 if positive else -1);db=(b[0][axis]-value)*(1 if positive else -1)
            (inside if da>=-1e-7 else outside).append(a)
            if (da>1e-7 and db<-1e-7) or (da<-1e-7 and db>1e-7):
                t=da/(da-db);v=(a[0].lerp(b[0],t),[u.lerp(v,t) for u,v in zip(a[1],b[1])]);inside.append(v);outside.append(v)
        return inside,outside
    def build(name,polys,old,inverse):
        vertices=[];faces=[];uvs=[];mats=[];smooth=[]
        for poly,mat,sm in polys:
            start=len(vertices)
            for co,uv in poly:vertices.append(inverse@co);uvs.append(uv)
            for i in range(1,len(poly)-1):faces.append((start,start+i,start+i+1));mats.append(mat);smooth.append(sm)
        data=bpy.data.meshes.new(name);data.from_pydata(vertices,[],faces);data.update()
        for mat in old.materials:data.materials.append(mat)
        for layer_index,layer in enumerate(old.uv_layers):
            new=data.uv_layers.new(name=layer.name)
            for loop in data.loops:new.data[loop.index].uv=uvs[loop.vertex_index][layer_index]
        for p,mat,sm in zip(data.polygons,mats,smooth):p.material_index=mat;p.use_smooth=sm
        return data
    scene.view_layers[0].update()
    for obj in list(scene.objects):
        if obj.type!='MESH' or not obj.data.name.startswith(('SC_D01_Terrain.007','SC_A03_Terrain.007')) or obj.get('tower_shell_split'):continue
        old=obj.data;old.calc_loop_triangles();matrix=obj.matrix_world.copy();inverse=matrix.inverted();remaining=[];shell=[]
        for tri in old.loop_triangles:
            poly=[(matrix@old.vertices[old.loops[i].vertex_index].co,[layer.data[i].uv.copy() for layer in old.uv_layers]) for i in tri.loops]
            material=old.polygons[tri.polygon_index].material_index;sm=old.polygons[tri.polygon_index].use_smooth
            for axis in range(3):
                for value,positive in [(lo[axis],True),(hi[axis],False)]:
                    if len(poly)<3:break
                    poly,outside=split(poly,axis,value,positive)
                    if len(outside)>=3:remaining.append((outside,material,sm))
            if len(poly)>=3:shell.append((poly,material,sm))
        if not shell:continue
        obj.data=build(obj.name+'_OutsideTower',remaining,old,inverse);obj['tower_shell_split']=True
        cut=obj.copy();cut.data=build(obj.name+'_TowerShell',shell,old,inverse);cut.name='SC_G_AdjacentRockShell_'+obj.name;scene.collection.objects.link(cut)
        cut['tower_adjacent_shell']=True;cut['tower_shell_split']=True
        if 'island_id' in cut:del cut['island_id']
        # Preserve the imported island binding/transform; only visibility belongs to Tower.
        report.append({'source':obj.name,'shell_faces':len(cut.data.polygons),'remaining_faces':len(obj.data.polygons)})
    return report
