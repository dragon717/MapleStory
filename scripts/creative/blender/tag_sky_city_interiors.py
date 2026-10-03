"""Add explicit cutaway volumes to existing authored rooms, retaining editable geometry."""
import bpy
from pathlib import Path
from mathutils import Vector

def tag_interiors(scene, layout):
    namespace={}
    source=Path(__file__).with_name('split_sky_city_tower_shell.py')
    exec(compile(source.read_text(encoding='utf-8'),str(source),'exec'),namespace)
    print('TOWER_SHELL_SPLIT',namespace['split_tower_surroundings'](scene,layout))
    def volume(name, center, size, island):
        obj=bpy.data.objects.get('SC_Interior_'+name)
        if obj is None:
            obj=bpy.data.objects.new('SC_Interior_'+name,None);scene.collection.objects.link(obj)
        obj.location=(center[0],-center[2],center[1]);obj['island_binding']=island
        obj['interior_bounds']=[-size[0]/2,-.5,-size[2]/2,size[0]/2,size[1],size[2]/2]
        return obj.name
    def shell(obj, room, height=None):
        rooms=obj.get('cutaway_rooms','').split(',');obj['cutaway_rooms']=','.join(sorted(set(rooms+[room])-{''}))
        if height is not None:
            above=obj.get('cutaway_above_rooms','').split(',');obj['cutaway_above_rooms']=','.join(sorted(set(above+[room])-{''}))
            p=obj.matrix_world.inverted()@Vector((0,0,height))
            obj['cutaway_level']=[p.x,p.z,-p.y]
    for obj in scene.objects:
        for key in ('cutaway_rooms','cutaway_above','cutaway_above_rooms','cutaway_level'):
            if key in obj:del obj[key]
    bpy.context.view_layer.update()
    for spec in layout['rooms']:
        root=bpy.data.objects['SC_'+spec['id']]
        root['interior_bounds']=[-9,-.5,-9,9,8,9]
        for obj in root.children:
            if not obj.name.endswith('_Floor'):shell(obj,root.name)
    for spec in layout['sideRooms']:
        room=volume(spec['id'],spec['center'],spec['size'],'A03')
        for obj in scene.objects:
            if obj.name.startswith('SC_'+spec['id']+'_'):
                if not obj.get('motion_node'):obj['island_binding']='A03';obj['zone']='G'
                if not obj.name.endswith(('_Floor','_Landing')):shell(obj,room)
    # A floor defines the real interior footprint; only its known wall/roof pieces are shells.
    for floor in list(scene.objects):
        if not floor.name.endswith('_Floor') or floor.parent or floor.type!='MESH':continue
        prefix=floor.name[:-6]
        if prefix.startswith('SC_G-'):continue
        bounds=[floor.matrix_world@Vector(c) for c in floor.bound_box]
        lo=[min(p[i] for p in bounds) for i in range(3)];hi=[max(p[i] for p in bounds) for i in range(3)]
        walls=[o for o in scene.objects if o.name.startswith(prefix+'_') and any(s in o.name[len(prefix):] for s in ('_Back','_Side','_Roof'))]
        if not walls:continue
        height=max((o.matrix_world@Vector(c)).z for o in walls for c in o.bound_box)-hi[2]
        room=volume(prefix[3:],[(lo[0]+hi[0])/2,hi[2],-(lo[1]+hi[1])/2],[hi[0]-lo[0],height,hi[1]-lo[1]],floor.get('island_binding','F01'))
        for obj in walls:shell(obj,room)
        if prefix=='SC_F_CentralHall':
            for obj in scene.objects:
                if obj.name.startswith('SC_F_EastDoor'):shell(obj,room)
    tower=layout['tower'];bottom=tower['center'][1]-(len(tower['levels'])-1)*tower['floorHeight']
    room=volume('Tower',[tower['center'][0],bottom,tower['center'][2]],[34,tower['center'][1]-bottom+8,34],'A03')
    nodes={n['id']:n for n in layout['nodes']}
    for obj in list(scene.objects):
        if obj.name.startswith('SC_G_Column') or obj.get('tower_adjacent_shell') or obj.get('carrier') == 'tower entrance foundation with an open central shaft':shell(obj,room)
        if 'original_floor' in obj:
            level=tower['center'][1]-tower['levels'].index(obj['original_floor'])*tower['floorHeight'];shell(obj,room,level)
        elif obj.name.startswith('SC_G_FlatLanding_'):
            shell(obj,room,max((obj.matrix_world@Vector(c)).z for c in obj.bound_box))
        elif obj.get('motion_node') in nodes and nodes[obj['motion_node']]['id'].startswith('G-'):
            shell(obj,room,nodes[obj['motion_node']]['position'][1])
        elif obj.get('edge_id'):
            edge=next(e for e in layout['edges'] if e['id']==obj['edge_id'])
            if edge.get('continuous')=='tower-spiral':shell(obj,room,min(p[1] for p in edge['points']))
    # Lower sanctuary rooms need the upper storeys lifted out of view as well.
    sanctuary=volume('Sanctuary',[160,94,-300],[152,42,152],'F01')
    for obj in list(scene.objects):
        if obj.get('map_id'):shell(obj,sanctuary,obj.location.z)
        elif obj.name.startswith(('SC_F_CentralHall_','SC_F_EastDoor')):
            # The upper hall's shell and floor are above the lower cloister.
            # Current-storey cutaway is still governed by the hall's own footprint.
            shell(obj,sanctuary,122)
        elif obj.name.startswith(('SC_F_Cloister_','SC_F_FlatLanding_','SC_F_Hall','SC_F_UpperHall')):
            shell(obj,sanctuary,min((obj.matrix_world@Vector(c)).z for c in obj.bound_box))
