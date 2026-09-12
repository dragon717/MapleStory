"""Run one staged build through the existing official independent Blender MCP."""
import sys,json,time
from pathlib import Path
from mcp_build_client import MCPClient
ROOT=Path(__file__).resolve().parents[3]
stage=sys.argv[1]
map_filter=[sys.argv[2]] if len(sys.argv)>2 else ['island','bridge']
assert set(map_filter)<= {'island','bridge'}
assert stage=='textured' or len(map_filter)==2
assert stage in ['whitebox','textured']
c=MCPClient();e={'stage':stage,'started':time.time(),'calls':[]}
try:
    e['initialize']=c.request('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'windbell-grand-staged','version':'1'}});c.notify('notifications/initialized')
    r=c.call_tool('execute_blender_code',{'code':'STAGE = '+repr(stage)+'\nMAP_FILTER = '+repr(map_filter)+'\nDATA = '+repr(json.loads((ROOT/'shared/windbell.json').read_text(encoding='utf-8')))+'\n'+(ROOT/'scripts/creative/blender/build_windbell_grand.py').read_text(encoding='utf-8'),'user_prompt':'Build the reviewed concept-derived grand Windbell '+stage+' assets in the independent project scene and save stage before further work.'});e['calls'].append(r)
    text='\n'.join(b.get('text','') for b in r.get('result',{}).get('content',[]));print(text[-2400:])
    if 'WINDBELL_GRAND_'+stage.upper()+'_COMPLETE' not in text:raise RuntimeError('stage completion marker missing')
finally:
    (ROOT/'resources/blender/windbell/logs'/f'mcp-{stage}.json').write_text(json.dumps(e,ensure_ascii=False,indent=2),encoding='utf-8');c.close()
