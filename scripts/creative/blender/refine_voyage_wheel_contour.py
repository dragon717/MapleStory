"""Sweep the existing wheel cloth and its ribs, retaining pivots/topology/UV."""
import bpy, math


def refine_wheel_contour(scene):
    for side in ['Port','Starboard']:
        wheel=scene.objects['SV3_Wheel_'+side]
        for obj in [wheel,scene.objects[wheel.name+'_TimberSpokesAndHub']]:
            key='SV3_WheelContourSource_'+obj.name
            source=bpy.data.meshes.get(key)
            if source is None:
                source=obj.data.copy();source.name=key;source.use_fake_user=True
            obj.data=source.copy()
            for v in obj.data.vertices:
                y,z=v.co.y,v.co.z;r=math.hypot(y,z)
                if r<=2.4:continue
                angle=math.atan2(z,y)
                t=max(0,min(1,(r-2.4)/7))
                # Pi-periodic length changes preserve each opposite pair.
                radius=r*(1+t*(.13*math.cos(2*angle)+.075*math.sin(4*angle)))
                angle+=.14*t*t
                v.co.y=radius*math.cos(angle);v.co.z=radius*math.sin(angle)
            obj.data.update()
            assert len(obj.data.polygons)==len(source.polygons)
            assert all(tuple(a.vertices)==tuple(b.vertices) for a,b in zip(obj.data.polygons,source.polygons))
            assert all(tuple(a.uv)==tuple(b.uv) for l in source.uv_layers for a,b in zip(l.data,obj.data.uv_layers[l.name].data))
            obj['wheel_contour']='centrally symmetric swept blades'
            obj['wheel_sweep_radians']=.14
            obj['wheel_topology_uv_preserved']=True
        wheel['wheel_contour_source']='original retained wheel cloth and ribs; same centre and pivot'
    print('WHEEL_CONTOUR_READY: original topology/UV/hub retained; unequal opposite blade pairs; 0.14 rad swept tips')
