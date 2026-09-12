"""One offline runnable check: actual GLB mesh coordinates, layer roots, states, textures."""
import json,struct,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
DATA=json.loads((ROOT/'shared/windbell.json').read_text(encoding='utf-8'))
OUT=ROOT/'resources/blender/windbell'
def read(path):
    b=path.read_bytes();assert b[:4]==b'glTF';length=struct.unpack_from('<I',b,12)[0]
    d=json.loads(b[20:20+length]);offset=20+length;blen=struct.unpack_from('<I',b,offset)[0]
    return d,b[offset+8:offset+8+blen]
def positions(d,b,index):
    a=d['accessors'][index];v=d['bufferViews'][a['bufferView']];assert a['componentType']==5126 and a['type']=='VEC3'
    start=v.get('byteOffset',0)+a.get('byteOffset',0);stride=v.get('byteStride',12)
    return [struct.unpack_from('<fff',b,start+i*stride) for i in range(a['count'])]
results=[]
for stage in ['whitebox','textured']:
    folder=OUT/'whitebox' if stage=='whitebox' else OUT
    for kind in ['island','bridge']:
        d,b=read(folder/'glb'/f'{kind}.glb');nodes=d['nodes'];byname={n['name']:n for n in nodes}
        layers=[n for n in nodes if 'render_layer' in n.get('extras',{})]
        assert len(layers)==4 and {n['extras']['render_layer'] for n in layers}=={'foreground','middle','background','far'}
        seen=set()
        def visit(index,layer):
            n=nodes[index]
            if n.get('extras',{}).get('motion'):seen.add(layer)
            for c in n.get('children',[]):visit(c,layer)
        for n in layers:visit(nodes.index(n),n['extras']['render_layer'])
        assert seen=={'foreground','middle','background','far'},seen
        checks=[]
        for fh in DATA['maps'][kind]['footholds']:
            n=byname[f'{kind}_Foothold{fh["id"]}'];mesh=d['meshes'][n['mesh']]
            ps=positions(d,b,mesh['primitives'][0]['attributes']['POSITION'])
            for x,y in [(fh['x1'],-fh['y1']),(fh['x2'],-fh['y2'])]:
                assert any(abs(p[0]-x)<.001 and abs(p[1]-y)<.001 and p[2]<0 for p in ps)
                assert any(abs(p[0]-x)<.001 and abs(p[1]-y)<.001 and p[2]>0 for p in ps)
            assert max(p[2] for p in ps)-min(p[2] for p in ps)>=200
            checks.append(fh['id'])
        required=['TreeBridgeHeld','TreeBridgeFalling','TreeBridgeLanded','HeatFire','Leafwing'] if kind=='island' else ['BridgeSegment1','BridgeSegment2','BridgeSegment3','BridgeBroken','Cart']
        assert all(n in byname for n in required)
        if kind=='island':
            assert byname['TreeBridgeLanded']['translation']==[650,-650,0]
            n=byname['TreeBridgeLanded_Deck'];ps=positions(d,b,d['meshes'][n['mesh']]['primitives'][0]['attributes']['POSITION'])
            assert any(abs(p[0]-900)<.001 and abs(p[1]-100)<.001 for p in ps)
        else:assert byname['Cart']['translation']==[450,-700,0]
        if stage=='textured':
            assert len(d.get('images',[]))>=6 and all('bufferView' in im for im in d['images'])
            assert any('baseColorTexture' in m.get('pbrMetallicRoughness',{}) for m in d['materials'])
            trunk=next(n for n in nodes if n.get('name','').startswith('AncientTree_Trunk'))
            uv=d['accessors'][d['meshes'][trunk['mesh']]['primitives'][0]['attributes']['TEXCOORD_0']]
            view=d['bufferViews'][uv['bufferView']];start=view.get('byteOffset',0)+uv.get('byteOffset',0)
            values=[struct.unpack_from('<ff',b,start+i*view.get('byteStride',8)) for i in range(uv['count'])]
            assert max(abs(v) for pair in values for v in pair)>2, 'bark UV must repeat at fixed world scale'
        results.append({'stage':stage,'map':kind,'nodes':len(nodes),'footholds_verified':checks,'depth_layers_with_motion':sorted(seen),'embedded_images':len(d.get('images',[]))})
(OUT/'logs/export-validation.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(results,ensure_ascii=False))
