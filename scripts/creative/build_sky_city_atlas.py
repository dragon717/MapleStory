"""One source for the block diagram, route diagram and Blender prototype.
Run: python3 scripts/creative/build_sky_city_atlas.py
All positions are proposed metres, glTF Y-up; not server navigation.
"""
import json
import math
import base64
import struct
import sys
import heapq
from collections import Counter
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'resources/scenes/sky-voyage-v3/prototypes'
SOURCE = ROOT / 'resources/scenes/sky-voyage-v3/references/orbis-map-topology-tms273.json'

BLOCKS = [
    ('A', '空港与入城', [-180, 0, 300], [350, 18, 160], '#c4a079'),
    ('B', '生活·工艺·研习', [-310, 24, 70], [270, 24, 290], '#90b997'),
    ('C', '三色庭园', [0, 42, 100], [430, 14, 230], '#d7b468'),
    ('D', '云彩公园外环', [340, 54, -10], [155, 12, 330], '#91bacb'),
    ('E', '天空阶梯与黑光园', [-80, 92, -180], [280, 16, 240], '#bdabc9'),
    ('F', '女神圣域与旧房间', [160, 110, -295], [250, 55, 170], '#abc1e1'),
    ('G', '天空塔及地下', [-100, -62, 190], [46, 156, 46], '#9cabc0'),
    ('H', '克里塞侧岛', [510, 70, -340], [180, 24, 150], '#c6b6a1'),
]
# P landscape envelopes: terrain is fitted below the approved roads, not a new route graph.
ISLANDS = [
    ('A01','A','空港主岛',[-198,0,307],[82,55],42,'town'),
    ('A02','A','临港市集台地',[-185,6,260],[48,32],28,'town'),
    ('A03','A','城门台地',[-130,12,245],[58,30],34,'garden'),
    ('B01','B','生活工坊主岛',[-330,24,94],[124,108],70,'town'),
    ('B02','B','英雄殿山丘',[-348,38,-72],[63,58],55,'garden'),
    ('B03','B','住宅林地',[-427,24,-4],[48,50],40,'woodland'),
    ('C01','C','三色入园岛',[15,20,185],[74,48],48,'garden'),
    ('C02','C','红光下庭',[-170,28,165],[60,47],46,'red'),
    ('C03','C','红光上庭',[-205,42,34],[64,52],52,'red'),
    ('C04','C','黄光下庭',[-44,30,108],[55,48],48,'yellow'),
    ('C05','C','黄光上庭',[-108,42,58],[66,48],52,'yellow'),
    ('C06','C','蓝光下庭',[198,25,158],[65,56],48,'blue'),
    ('C07','C','蓝光上庭',[242,52,20],[62,48],58,'blue'),
    ('C08','C','水庭小岛',[77,28,107],[45,42],36,'blue'),
    ('D01','D','云园西入口',[-32,16,216],[85,30],32,'garden'),
    ('D02','D','云园内街',[133,23,217],[58,30],32,'garden'),
    ('D03','D','云园Ⅰ景观岛',[283,26,161],[47,37],42,'garden'),
    ('D04','D','云园Ⅱ林水岛',[361,38,124],[75,59],55,'woodland'),
    ('D05','D','云园Ⅲ旧园岛',[418,54,-64],[72,54],62,'ruin'),
    ('D06','D','云园Ⅳ老妪居所',[364,62,-151],[68,46],56,'woodland'),
    ('D07','D','云园Ⅴ高岛',[264,76,-232],[57,43],56,'garden'),
    ('D08','D','云园Ⅵ上庭',[222,84,-167],[50,43],54,'garden'),
    ('E01','E','古柱下庭',[-225,65,-102],[58,38],38,'ruin'),
    ('E02','E','上层共享庭',[102,80,-110],[70,54],62,'garden'),
    ('E03','E','天空阶梯Ⅰ岛',[7,92,-181],[53,46],56,'garden'),
    ('E04','E','天空阶梯Ⅱ岛',[-99,106,-250],[70,53],62,'garden'),
    ('E05','E','黑光古林',[-151,112,-315],[64,47],62,'ruin'),
    ('E06','E','艾利杰遗迹',[-218,100,-208],[44,41],48,'ruin'),
    ('F01','F','女神圣域主岛',[160,94,-300],[98,91],72,'sanctuary'),
    ('F02','F','下层阅览岛',[34,94,-309],[38,34],38,'garden'),
    ('F03','F','旧层外岛',[-28,82,-272],[30,30],32,'ruin'),
    ('F04','F','城腹秘密岛',[-3,68,-183],[28,24],30,'ruin'),
    ('H01','H','克里塞聚落主岛',[532,72,-392],[116,94],76,'town'),
    ('H02','H','竞技高台岛',[620,85,-340],[37,40],32,'ruin'),
    ('H03','H','侧岛高塔峰',[538,99,-480],[42,35],40,'garden'),
]
NODES = [
    ('P01', '码头', 'A', [-200, 0, 340]), ('P02', '入城广场', 'A', [-150, 12, 240]),
    ('P03', '生活研习庭', 'B', [-270, 24, 145]), ('P04', '相遇丘·英雄殿', 'B', [-350, 38, -70]),
    ('P05', '三色分岔', 'C', [0, 20, 190]), ('P06', '红Ⅰ', 'C', [-170, 28, 170]),
    ('P07', '红Ⅱ', 'C', [-210, 42, 30]), ('P08', '黄Ⅰ', 'C', [-40, 30, 110]),
    ('P09', '黄Ⅱ', 'C', [-130, 39, 80]), ('P10', '蓝Ⅰ', 'C', [190, 25, 160]),
    ('P11', '蓝Ⅱ', 'C', [240, 52, 20]), ('J01', '换路庭院①', 'C', [-80, 45, 55]),
    ('P12', '红路高桥', 'E', [-140, 70, -80]), ('P13', '黄路下廊', 'E', [-140, 48, -80]),
    ('P14', '内螺旋', 'E', [-20, 65, -70]), ('J02', '换路庭院②', 'E', [100, 80, -110]),
    ('P15', '天空阶梯Ⅰ', 'E', [10, 92, -180]), ('P16', '天空阶梯Ⅱ', 'E', [-90, 106, -240]),
    ('P17', '黑光Ⅰ', 'E', [-180, 108, -260]), ('P18', '黑光Ⅱ', 'E', [-120, 115, -330]),
    ('P19', '艾利杰旧庭园', 'E', [-220, 100, -200]), ('P20', '圣域入口庭', 'F', [80, 110, -240]),
    ('P21', '圣域中央厅', 'F', [160, 122, -300]), ('P22', '暗路入口', 'C', [-30, 34, 90]),
    ('P23', '桥腹旧廊', 'E', [-140, 38, -80]), ('P24', '城腹旧层', 'F', [0, 68, -180]),
    ('P25', '天空塔入口', 'G', [-72, 12, 190]),
    ('P26', '云园Ⅰ', 'D', [260, 26, 150]), ('P27', '云园Ⅱ', 'D', [340, 38, 100]),
    ('P28', '散步Ⅰ', 'D', [400, 46, 20]), ('P29', '云园Ⅲ', 'D', [390, 54, -70]),
    ('P30', '云园Ⅳ', 'D', [340, 62, -140]), ('P31', '散步Ⅱ', 'D', [300, 68, -210]),
    ('P32', '云园Ⅴ', 'D', [260, 76, -240]), ('P33', '云园Ⅵ', 'D', [220, 84, -170]),
    ('P34', '侧岛入口', 'H', [450, 70, -310]), ('P35', '克里塞聚落', 'H', [520, 72, -380]),
]
ROUTES = [
    ('arrival', '入城', '#8a7964', ['P01', 'A01', 'P02', 'D00', 'P05']),
    ('life', '生活区环路', '#709b79', ['P02', 'P03', 'P04', 'P02']),
    ('red', '红路', '#c87568', ['P05', 'P06', 'P07', 'J01', 'P12', 'J02', 'P15']),
    ('yellow', '黄路', '#b79b43', ['P05', 'P08', 'P09', 'J01', 'P13', 'P14', 'J02', 'P15']),
    ('blue', '蓝路', '#5b93b7', ['P05', 'P10', 'P11', 'J02', 'P15']),
    ('crown', '上层汇合', '#8b78a3', ['P15', 'P16', 'P20', 'F-C14', 'F-C13', 'F-C12', 'F-C11', 'F-C10', 'F-C19', 'P21']),
    ('hidden', '隐藏第四路', '#665a81', ['J01', 'P22', 'P23', 'P24', 'P19', 'P16']),
    ('outer', '外缘云园环', '#81aebb', ['D00', 'D01', 'P26', 'P27', 'P28', 'P29', 'P30', 'P31', 'P32', 'P33', 'J02']),
    ('dark', '黑光园支环', '#9d8bae', ['P16', 'P17', 'P18', 'P16']),
    ('tower', '古塔入口', '#8392a7', ['P02', 'P25']),
    ('chryse', '侧岛连接', '#ac9472', ['P20', 'P34', 'P35']),
]

# Local streets, not links between district centres. Door positions match the existing craft shells.
LOCAL_NODES = [
    ('A01','售票前庭','A',[-180,0,310]), ('A02','候船庭','A',[-220,0,295]),
    ('A03','港口市集','A',[-205,6,255]), ('A04','入城小园','A',[-90,12,250]),
    ('A05','泊位一','A',[-230,0,380]), ('A06','泊位二','A',[-200,0,395]),
    ('A07','泊位三','A',[-165,0,390]), ('A08','泊位四','A',[-145,0,375]),
    ('B01','阅览入口','B',[-360,24,81]), ('B02','铁匠入口','B',[-312,24,81]),
    ('B03','布艺入口','B',[-264,24,81]), ('B04','木匠入口','B',[-360,24,139]),
    ('B05','炼金入口','B',[-312,24,139]), ('B06','住宅后庭','B',[-400,24,0]),
    ('C01','水庭换路','C',[70,28,100]), ('C02','花坛前庭','C',[-105,33,145]),
    ('D00','云园Ⅰ城镇侧','D',[-80,16,215]), ('D01','云园Ⅰ内街','D',[140,23,200]),
    ('D02','小公园','D',[330,38,165]), ('D03','暗影旧园','D',[460,54,-60]),
    ('D04','老妪之家前庭','D',[400,62,-160]), ('D05','静谧散步庭','D',[420,45,120]),
    ('E01','古柱折返庭','E',[-255,65,-100]),
    ('F01','旧层外庭','F',[-30,82,-280]), ('F02','下层阅览前庭','F',[45,94,-305]),
    ('H01','总部前庭','H',[520,72,-435]), ('H02','外缘庭','H',[590,72,-380]),
    ('H03','无法地带','H',[570,85,-440]), ('H04','竞技庭','H',[620,85,-340]),
    ('H05','侧岛高塔','H',[530,99,-480]),
]
LOCAL_ROUTES = [
    ('port','港口街网','#8a7964',['P01','A02','A03','P02','A01','A02']),
    ('port-park','入城回路','#8a7964',['P02','A04','P25']),
    ('berths','泊位支路','#8a7964',['P01','A05','P01','A06','P01','A07','P01','A08']),
    ('craft','工坊街环','#709b79',['B01','B02','B03','P03','B05','B04','B01']),
    ('residence','住宅回路','#709b79',['B04','B06','P04','P03']),
    ('garden-net','庭园内街','#b79b43',['P06','C02','P08','C01','P10']),
    ('garden-hidden','水庭暗口','#665a81',['C01','P22']),
    ('park-net','公园内街','#81aebb',['P26','D02','P27','D05','P28']),
    ('old-park','旧园支环','#81aebb',['P29','D03','D04','P30']),
    ('old-stair','古柱回主路','#8b78a3',['P23','E01','P19']),
    ('old-hall','旧层研习回路','#8b78a3',['P24','F01','F02','F-C05']),
    ('chryse-net','侧岛内街','#ac9472',['P35','H01','H03','H04','H02','P35']),
    ('chryse-tower','高塔支环','#ac9472',['H03','H05','H01']),
]
# Bend locations are deliberate street corners / bridge approaches, never a random curve for a graph edge.
BENDS = {
    ('P01','A01'):[[-200,318]], ('A01','P02'):[[-175,285],[-150,265]],
    ('P01','A02'):[[-225,325]], ('A02','A03'):[[-235,275]],
    ('A03','P02'):[[-185,245]], ('P02','P03'):[[-215,215],[-270,175]],
    ('P04','P02'):[[-420,-25],[-425,155],[-235,220]],
    ('B01','B02'):[[-360,88],[-312,88]], ('B02','B03'):[[-312,88],[-264,88]],
    ('B05','B04'):[[-312,146],[-360,146]],
    ('B04','B01'):[[-360,146],[-383,146],[-383,88],[-360,88]],
    ('B04','B06'):[[-360,146],[-410,146],[-422,40]],
    ('B06','P04'):[[-410,-40]], ('P03','P04'):[[-235,60],[-260,-35]],
    ('P02','D00'):[[-110,235]], ('D00','P05'):[[-40,215]],
    ('P02','P25'):[[-140,195],[-140,150],[-60,150],[-60,190]],
    ('A04','P25'):[[-55,250],[-55,190]],
    ('D00','D01'):[[0,245],[100,235]], ('D01','P26'):[[190,205],[240,185]],
    ('P05','P06'):[[-60,175],[-125,180]], ('P06','P07'):[[-230,130],[-245,75]],
    ('P07','J01'):[[-155,10],[-110,35]], ('P05','P08'):[[0,140]],
    ('P08','P09'):[[-75,110],[-110,105]], ('P09','J01'):[[-130,60]],
    ('P05','P10'):[[90,205],[150,190]], ('P10','P11'):[[245,115],[270,60]],
    ('P11','J02'):[[230,-40],[165,-80]], ('J01','P12'):[[-105,10],[-165,-20]],
    ('J01','P13'):[[-70,0],[-100,-45]], ('P12','J02'):[[-100,-125],[25,-145]],
    ('P13','P14'):[[-110,-65]], ('P14','J02'):[[35,-65],[75,-85]],
    ('J02','P15'):[[80,-155]], ('P15','P16'):[[0,-215],[-45,-240]],
    ('P16','P20'):[[-45,-205],[25,-205]], ('P16','P17'):[[-120,-285]],
    ('P18','P16'):[[-70,-300]], ('P22','P23'):[[-5,35],[-45,-15],[-110,-35]],
    ('P23','P24'):[[-95,-130],[-40,-160]], ('P24','P19'):[[-90,-205],[-170,-195]],
    ('P19','P16'):[[-190,-230]], ('P23','E01'):[[-190,-55],[-255,-65]],
    ('P27','P28'):[[380,80],[415,55]], ('P28','P29'):[[430,-15]],
    ('P30','P31'):[[310,-160]], ('P31','P32'):[[290,-250]],
    ('P32','P33'):[[205,-230]], ('P33','J02'):[[180,-130]],
    ('D03','D04'):[[455,-135]], ('F01','F02'):[[-25,-315]],
    ('P20','P34'):[[230,-205],[365,-250]], ('P34','P35'):[[465,-350]],
    ('H03','H04'):[[625,-425],[650,-380]], ('H05','H01'):[[485,-470],[485,-435]],
}


def horizontal_length(points):
    return sum(math.hypot(b[0]-a[0],b[2]-a[2]) for a,b in zip(points,points[1:]))


def point_at(points, distance):
    for a,b in zip(points,points[1:]):
        span=math.hypot(b[0]-a[0],b[2]-a[2])
        if distance<=span:
            return [a[k]+(b[k]-a[k])*max(0,distance)/span for k in range(3)]
        distance-=span
    return list(points[-1])


def path_slice(points, start, end):
    result=[point_at(points,start)]; distance=0
    for a,b in zip(points,points[1:]):
        distance+=math.hypot(b[0]-a[0],b[2]-a[2])
        if start<distance<end: result.append(list(b))
    result.append(point_at(points,end))
    return result


def street_path(a,b):
    p,q=a['position'],b['position']; key=(a['id'],b['id'])
    bends=BENDS.get(key)
    if bends is None: bends=list(reversed(BENDS.get((key[1],key[0]),[])))
    raw=[p]+[[x,0,z] for x,z in bends]+[q]
    # Small corner fillets keep a continuous road strip; the route still follows planned street corners.
    result=[list(p)]
    for previous,corner,following in zip(raw,raw[1:],raw[2:]):
        incoming=math.hypot(corner[0]-previous[0],corner[2]-previous[2])
        outgoing=math.hypot(following[0]-corner[0],following[2]-corner[2])
        cut=min(12,incoming*.25,outgoing*.25)
        left=[corner[k]+(previous[k]-corner[k])*cut/incoming for k in range(3)]
        right=[corner[k]+(following[k]-corner[k])*cut/outgoing for k in range(3)]
        result.append(left)
        for i in range(1,7):
            t=i/6; result.append([(1-t)**2*left[k]+2*t*(1-t)*corner[k]+t*t*right[k] for k in range(3)])
    result.append(list(q))
    run=horizontal_length(result)
    for i,point in enumerate(result): point[1]=p[1]+(q[1]-p[1])*horizontal_length(result[:i+1])/run
    return result


def shortest_path(layout,start,end):
    graph={n['id']:[] for n in layout['nodes']}; edges={e['id']:e for e in layout['edges']}
    for e in layout['edges']:
        graph[e['start']].append((e['end'],e['id'],e['length']))
        graph[e['end']].append((e['start'],e['id'],e['length']))
    queue=[(0,start,[])]; best={start:0}
    while queue:
        cost,node,path=heapq.heappop(queue)
        if cost!=best[node]: continue
        if node==end:
            points=[]; current=start
            for eid in path:
                e=edges[eid]; segment=e['points'] if e['start']==current else list(reversed(e['points']))
                points.extend(segment if not points else segment[1:]); current=e['end'] if current==e['start'] else e['start']
            return dict(start=start,end=end,edges=path,points=points,length=round(cost,2))
        for target,eid,length in graph[node]:
            if cost+length<best.get(target,float('inf')):
                best[target]=cost+length; heapq.heappush(queue,(cost+length,target,path+[eid]))
    raise ValueError((start,end,'unreachable'))


def zone_for(m):
    n, group = int(m['id']), m['group']
    if group == '城镇与港口':
        return 'B' if 200000200 <= n <= 200000301 else 'A'
    if group == '云彩公园与庭园':
        if n in (200010100, 200010110, 200010111, 200010120, 200010121, 200010130, 200010131):
            return 'C'
        return 'E' if 200010200 <= n <= 200010303 else 'D'
    if group == '天空之城塔': return 'G'
    if group == '雅典娜禁地／女神之塔': return 'F'
    if '克里塞' in group: return 'H'
    if group in ('航行地图（含相邻地区航线）', '跨地区移动地图'): return 'A'
    raise ValueError(m)


def projection(p):
    x, y, z = p
    return 450 + .60*x - .40*z, 385 + .19*x + .25*z - 1.15*y


def landing_radius(node_id):
    if node_id.startswith(('F-','G-')): return 2
    if node_id.startswith(('GX','GI')): return 3
    sizes={'P01':20,'P02':24,'A01':14,'A02':14,'A03':14,'A04':12,'P03':22,'P04':28,'P05':20,
        'P06':22,'P07':22,'P08':22,'P09':22,'P10':22,'P11':22,'C01':14,'C02':12,'J01':22,'J02':26,
        'D00':14,'D01':18,'D02':14,'D03':14,'D04':14,'D05':14,'P26':18,'P27':18,'P28':10,'P29':18,
        'P30':18,'P31':10,'P32':18,'P33':18,'P15':22,'P16':22,'P17':20,'P18':20,'P19':18,
        'P20':18,'P24':12,'F01':14,'F02':14,'P35':55}
    return sizes.get(node_id,8 if node_id.startswith('P') else 6)


def svg(layout, mode):
    if mode=='lines': return network_svg(layout)
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="980" viewBox="0 0 1500 980">',
        '<rect width="1500" height="980" fill="#f7f6f1"/>',
        '<g font-family="PingFang SC, sans-serif" fill="#343b45">',
        f'<text x="55" y="62" font-size="31">天空之城 · {"分区体量总图" if mode == "blocks" else "道路与标高总图"}</text>',
        '<text x="55" y="96" font-size="16" fill="#68717d">同一份空间草案 · 米 / Y向上 · 原创P连接 · 尚非服务端导航</text>']
    for block in sorted(layout['blocks'], key=lambda b: b['center'][2]-b['center'][0]):
        x,y,z = block['center']; sx,sy,sz = block['size']
        corners = [[x-sx/2,y,z-sz/2],[x+sx/2,y,z-sz/2],[x+sx/2,y,z+sz/2],[x-sx/2,y,z+sz/2]]
        top = [projection(p) for p in corners]
        bottom = [projection([p[0],p[1]-sy,p[2]]) for p in corners]
        alpha = '.62' if mode == 'blocks' else '.16'
        for a,b in ((1,2),(2,3)):
            points = top[a:a+1]+top[b:b+1]+bottom[b:b+1]+bottom[a:a+1]
            parts.append(f'<polygon points="{" ".join(f"{u:.1f},{v:.1f}" for u,v in points)}" fill="{block["color"]}" opacity="{alpha}" stroke="#ffffff"/>')
        parts.append(f'<polygon points="{" ".join(f"{u:.1f},{v:.1f}" for u,v in top)}" fill="{block["color"]}" opacity="{alpha}" stroke="#ffffff" stroke-width="2"/>')
        if mode == 'blocks':
            u,v = projection(block['center'])
            parts.append(f'<text x="{u:.1f}" y="{v-12:.1f}" text-anchor="middle" font-size="24" font-weight="600">{block["id"]}</text>')
    nodes = {n['id']:n for n in layout['nodes']}
    route_colors = {r['id']:r['color'] for r in layout['routes']}
    for edge in layout['edges']:
        if edge['interior'] or edge['route'] not in {r[0] for r in ROUTES}: continue
        points = [projection(p) for p in edge['points']]
        color = route_colors[edge['route']] if len(edge['routes'])==1 else '#8b78a3'
        dash = 'stroke-dasharray="9 7"' if edge['route']=='hidden' else ''
        parts.append(f'<polyline points="{" ".join(f"{u:.1f},{v:.1f}" for u,v in points)}" fill="none" stroke="{color}" stroke-width="{4 if mode=="lines" else 2}" stroke-linejoin="round" {dash}/>')
    label_boxes=[]
    projected_nodes=[projection(n['position']) for n in layout['nodes']]
    for node in layout['nodes']:
        if mode=='blocks' and node['id'] not in ('P01','P21','J01','J02'): continue
        u,v = projection(node['position']); junction = node['id'].startswith('J')
        parts.append(f'<circle cx="{u:.1f}" cy="{v:.1f}" r="{6 if junction else 3.5}" fill="#fff" stroke="#444f5e" stroke-width="{2 if junction else 1}"/>')
        if mode=='lines':
            for dx,dy in ((8,-8),(8,18),(-34,-8),(-34,18),(8,-22),(8,32),(-34,-22),(-34,32)):
                rect=(u+dx-2,v+dy-12,u+dx+27,v+dy+3)
                if any(rect[0]<b[2] and rect[2]>b[0] and rect[1]<b[3] and rect[3]>b[1] for b in label_boxes): continue
                if any(rect[0]-3<x<rect[2]+3 and rect[1]-3<y<rect[3]+3 for x,y in projected_nodes): continue
                break
            label_boxes.append(rect)
            parts.append(f'<text x="{u+dx:.1f}" y="{v+dy:.1f}" font-size="12">{node["id"]}</text>')
    parts.append('<line x1="1015" y1="135" x2="1015" y2="904" stroke="#d8dbe0"/>')
    if mode=='blocks':
        for i,b in enumerate(layout['blocks']):
            y=175+i*75; count=sum(m['zone']==b['id'] for m in layout['mapAssignments'])
            parts.append(f'<rect x="1045" y="{y-18}" width="18" height="18" rx="3" fill="{b["color"]}"/><text x="1078" y="{y}" font-size="20">{b["id"]} · {b["label"]}</text>')
            parts.append(f'<text x="1078" y="{y+25}" font-size="13" fill="#68717d">{count}个地图身份 · {b["center"][1]}m基准</text>')
        parts.append('<text x="1045" y="825" font-size="16">生活 / 工艺 / 研习 ≈ 一半</text><text x="1045" y="856" font-size="16">神殿 / 遗迹 / 探索 ≈ 一半</text>')
    else:
        for i,r in enumerate(layout['routes']):
            y=159+i*34
            parts.append(f'<line x1="1045" y1="{y-5}" x2="1080" y2="{y-5}" stroke="{r["color"]}" stroke-width="4"/><text x="1094" y="{y}" font-size="16">{r["label"]}</text>')
        parts.extend(['<text x="1045" y="574" font-size="18">真实共享节点：J01 / J02</text>',
            '<text x="1045" y="609" font-size="15">红高桥 P12：70m</text>',
            '<text x="1045" y="640" font-size="15">黄下廊 P13：48m</text>',
            '<text x="1045" y="671" font-size="15">暗廊 P23：38m</text>',
            '<text x="1045" y="704" font-size="14">同一平面位置，三层穿过，不自动相连</text>',
            '<text x="1045" y="770" font-size="16">古塔另用20层内部螺旋楼梯</text>',
            '<text x="1045" y="805" font-size="14">室内27房间由F区房间清单展开</text>'])
    parts.append('<text x="55" y="926" font-size="16" fill="#68717d">体量框是构图范围；房间与路面在白模中展开。旧图全部保留；未知原版连接与新增P路线分别记录。</text></g></svg>')
    return '\n'.join(parts)


def network_svg(layout, zone=None):
    nodes={n['id']:n for n in layout['nodes']}; colors={r['id']:r['color'] for r in layout['routes']}
    selected=[e for e in layout['edges'] if (not zone or nodes[e['start']]['zone']==nodes[e['end']]['zone']==zone)
        and (zone!='F' or nodes[e['start']].get('interior') or nodes[e['end']].get('interior'))]
    ids={n for e in selected for n in (e['start'],e['end'])}
    points=[p for e in selected for p in e['points']]
    # Interior plans are unfolded by floor; the tower uses height in a section, not stacked top-down circles.
    def plane(p):
        if zone=='F': return p[0]+(p[1]-94)/14*175,p[2]
        if zone=='G': return p[0]+(p[2]-190)*.3,-p[1]*2
        return p[0],p[2]
    planar=[plane(p) for p in points]; xs=[p[0] for p in planar]; zs=[p[1] for p in planar]
    x0,x1=min(xs)-35,max(xs)+35; z0,z1=min(zs)-40,max(zs)+40
    scale=min(1080/(x1-x0),710/(z1-z0)); ox=70+(1080-(x1-x0)*scale)/2; oy=140+(710-(z1-z0)*scale)/2
    def project(p):
        x,z=plane(p); return ox+(x-x0)*scale,oy+(z-z0)*scale
    def polyline(points): return ' '.join(f'{x:.2f},{y:.2f}' for x,y in [project(p) for p in points])
    title='全城真实街道路网' if not zone else 'F区 · 三层环廊与旧房间（展开图）' if zone=='F' else f'{zone}区 · '+next(b['label'] for b in layout['blocks'] if b['id']==zone)
    parts=['<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="980" viewBox="0 0 1500 980">',
        '<rect width="1500" height="980" fill="#f7f6f1"/><g font-family="PingFang SC,sans-serif" fill="#343b45">',
        f'<text x="55" y="62" font-size="30">{title}</text>',
        '<text x="55" y="97" font-size="16" fill="#68717d">沿真实路面中心线 · 分区内支路 / 回路 · 区界成对出入口 · 标高单位米</text>']
    if zone in (None,'B'):
        for i,label in enumerate(layout['crafts']):
            p=[-360+(i%3)*48,24,65+(i//3)*58]; u,v=project([p[0]-16,24,p[2]-16])
            parts.append(f'<rect x="{u:.2f}" y="{v:.2f}" width="{32*scale:.2f}" height="{32*scale:.2f}" rx="3" fill="#dfe4da" stroke="#8e9f91"/>')
            if zone=='B':
                u,v=project(p); parts.append(f'<text x="{u:.2f}" y="{v:.2f}" text-anchor="middle" font-size="14">{label}</text>')
    if zone=='F':
        for room in layout['rooms']:
            u,v=project(room['center']); parts.append(f'<rect x="{u-9*scale:.2f}" y="{v-9*scale:.2f}" width="{18*scale:.2f}" height="{18*scale:.2f}" fill="#e1e7ed" stroke="#a2b3c6"/>')
    for e in selected:
        stroke=max(1.1 if not zone and e['interior'] else 2,e['width']*scale); dash='stroke-dasharray="9 5"' if e['route']=='hidden' else ''
        parts.append(f'<polyline points="{polyline(e["points"])}" fill="none" stroke="#fff" stroke-width="{stroke+3:.2f}" stroke-linejoin="round"/>')
        parts.append(f'<polyline points="{polyline(e["points"])}" fill="none" stroke="{colors[e["route"]]}" stroke-width="{stroke:.2f}" stroke-linejoin="round" {dash}/>')
    if not zone:
        for i,walk in enumerate(layout['walkExamples']):
            parts.append(f'<polyline points="{polyline(walk["points"])}" fill="none" stroke="{("#273c50","#be6d2d")[i]}" stroke-width="3" stroke-linejoin="round"/>')
    labels=[]
    for nid in sorted(ids):
        n=nodes[nid]; u,v=project(n['position']); r=4 if n.get('gate') else 5 if n['id'].startswith('J') else 3
        parts.append(f'<circle cx="{u:.2f}" cy="{v:.2f}" r="{r}" fill="#fff" stroke="#516271"/>')
        show=bool(zone) or nid in ('P01','P02','P03','P04','P05','P15','P16','P20','P21','P25','P26','P35','J01','J02','D00')
        if not show: continue
        text=nid if n.get('gate') or n.get('interior') else n['label']+f' · {n["position"][1]:g}'
        width=max(30,len(text)*12)
        for dx,dy in ((8,-10),(8,19),(-width-8,-10),(-width-8,19),(8,-30),(8,39)):
            box=(u+dx,v+dy-15,u+dx+width,v+dy+3)
            if not any(box[0]<b[2] and box[2]>b[0] and box[1]<b[3] and box[3]>b[1] for b in labels): break
        labels.append(box)
        parts.append(f'<text x="{u+dx:.2f}" y="{v+dy:.2f}" font-size="{12 if n.get("gate") or n.get("interior") else 15}" paint-order="stroke" stroke="#f7f6f1" stroke-width="4" stroke-linejoin="round">{escape(text)}</text>')
    parts.append('<line x1="1170" y1="140" x2="1170" y2="860" stroke="#d8dbe0"/>')
    rows=layout['gates'] if zone else layout['blocks']
    if zone: rows=[g for g in rows if zone in (g['fromZone'],g['toZone'])]
    for i,row in enumerate(rows):
        text=f'{row["exit"]} ↔ {row["entry"]}' if zone else row['id']+' · '+row['label']
        parts.append(f'<text x="1190" y="{160+i*28}" font-size="14">{escape(text)}</text>')
    foot=430 if len(rows)<9 else 180+len(rows)*28
    explanation=['圆点 = 可停留 / 选路处','双端门口接入各自区内网','交叉无圆点 = 不自动换路','陡段有台阶和平坦恢复平台']
    if zone=='F': explanation=['三层环廊展开表示','房间编号保留27个旧图身份','上下层由真实内部螺旋衔接','门外环廊按圆弧行走']
    if zone=='G': explanation=['天空塔按高度展开','20—1层、地下1/2层','每层休息平台接内部螺旋','秘密房间与实验室为支路']
    for i,text in enumerate(explanation): parts.append(f'<text x="1190" y="{foot+i*29}" font-size="14">{text}</text>')
    if not zone:
        for i,walk in enumerate(layout['walkExamples']):
            parts.append(f'<text x="1190" y="{650+i*56}" font-size="14">{walk["label"]}</text><text x="1190" y="{674+i*56}" font-size="13" fill="#68717d">沿路面 {walk["length"]}m</text>')
    parts.append('<text x="55" y="926" font-size="16" fill="#68717d">P三维改编；原版地图门户另存。线与Blender路面同源；尚未接角色碰撞、正式导航。</text></g></svg>')
    return '\n'.join(parts)


def write_atlas(layout):
    picture_count=0
    def picture(filename, caption):
        nonlocal picture_count
        picture_count+=1
        p=OUT/filename; mime='image/svg+xml' if p.suffix=='.svg' else 'image/png'
        data=base64.b64encode(p.read_bytes()).decode('ascii')
        return f'<figure><img src="data:{mime};base64,{data}" alt="{escape(caption)}"><figcaption>{escape(caption)}</figcaption></figure>'
    counts=Counter(m['zone'] for m in layout['mapAssignments'])
    content=[
        ('A','空港、候船、售票、入城广场；航线与交通实例挂靠港口，不重复造160座建筑。'),
        ('B','住宅庭院、商店、相遇丘与英雄殿；新增阅览、铁匠、布艺、木匠、魔法炼金五类空间。'),
        ('C','三色分岔、红黄蓝各Ⅰ/Ⅱ庭园、第一共享换路庭院。'),
        ('D','云彩公园Ⅰ—Ⅵ、两段散步路、小公园、荒废/暗影庭园、老妪之家、人少的散步道。'),
        ('E','两段天空阶梯、两段黑光庭园、艾利杰旧庭园、高桥/下廊、第二共享换路庭院。'),
        ('F','女神塔全部27个旧地图身份：中央塔、休息室、封印室、庭园、仓库、监狱、宝物库与相关阶段空间。'),
        ('G','天空塔20—1层、地下1/2层、实验室及秘密之室；缺层保留，内部螺旋作为P补连接。'),
        ('H','克里塞村落、总部、外缘、无法地带、竞技场与高塔；保留两版本和实例身份，本轮白模只预留侧岛入口/庭。'),
    ]
    rows=''.join(f'<tr><td>{z}</td><td>{escape(t)}</td><td>{counts[z]}</td></tr>' for z,t in content)
    map_rows=''.join(f'<tr><td>{m["zone"]}</td><td>{m["mapId"]}</td><td>{escape(m["name"])}</td><td>{escape(m["sourceStatus"])}</td></tr>' for m in layout['mapAssignments'])
    node_rows=''.join(f'<tr><td>{n["id"]}</td><td>{escape(n["label"])}</td><td>{n["zone"]}</td><td>{n["position"][1]}m</td></tr>' for n in layout['nodes'])
    road_rows=''.join(f'<tr><td>{e["id"]}</td><td>{e["start"]} ↔ {e["end"]}</td><td>{e["width"]}m</td><td>{e["gradeDegrees"]}°</td><td>{"阶梯" if e["kind"]=="stairs" else "坡道" if e["kind"]=="ramp" else "平路"}</td></tr>' for e in layout['edges'])
    sections=[
        '<section id="blocks"><span class="eyebrow">01 / 总 · 分块</span><h2>先看全城的层级和空间用途</h2><p>从低处空港进入，生活与研习城区向三色庭园抬升，再经共享庭院通往上层女神圣域；天空塔向下延伸，克里塞作为侧岛。生活与遗迹各半指用途比例。</p>'+picture('city-blocks.svg','八个分区与同一套空间草案；体量框表示构图范围，不是已完成的建筑。')+'<table><thead><tr><th>区</th><th>内容与功能</th><th>地图身份数</th></tr></thead><tbody>'+rows+'</tbody></table><details><summary>展开已认可的整体氛围参考</summary>'+picture('city-overall-v1.png','首版美术原型：用于气质和目标地标，具体路径以分线数据为准。')+'</details></section>',
        '<section id="life"><span class="eyebrow">02 / 分 · A—B</span><h2>生活、工艺与研习</h2>'+picture('district-ab-life.png','空港与生活庭院局部研究；五类工艺/研习室标原创P，图像中的尺寸与可走性不视为实测。')+'<p>泊位 → 候船与入城广场 → 工坊/住宅庭 → 相遇丘与英雄殿。工艺沿庭院组织，阅览与炼金更安静；生活环路能返回入城广场。</p></section>',
        '<section id="gardens"><span class="eyebrow">03 / 分 · C—D—E</span><h2>三条明路、共享庭院和隐藏第四路</h2>'+picture('district-cde-gardens.png','三色各两段庭园、六段外围云彩公园和两层天空阶梯；跨层穿过与真正换路分别处理。')+'<p>红路走高桥，黄路走内侧下廊，蓝路经水庭。J01/J02是实际共享节点；P12/P13/P23同平面、不同高度，分别是70/48/38米，不能直接换层。隐藏路由桥腹与城腹旧廊返回主路，六段云园保留往返并补上层出口。</p></section>',
        '<section id="interior"><span class="eyebrow">04 / 分 · F—G—H</span><h2>圣域内部、古塔与侧岛</h2>'+picture('district-fg-interior.png','女神圣域与向下天空塔的剖切研究；旧地图保留身份，房间连接采用这次P改编。')+'<p>F区27个房间在白模内有独立地图身份、门洞与楼层；G区保留二十层和地下两层，休息平台衔接内部螺旋。H区内容清单已纳入，当前只建立侧岛入口和聚落庭的体量占位，尚未细建克里塞各内容空间。</p></section>',
        '<section id="lines"><span class="eyebrow">05 / 总 · 分线</span><h2>用同一套编号把空间串起来</h2>'+picture('city-lines.svg','37个连接点、43条独立道路；三路共用的段落只建一次。标高与房间编号进入Blender。')+'<p>所有路线均为P空间改编。原版固定门户另存；旧图连接未知时保留内容身份并补新关系。各路径有可回出的连接，图论连通尚不等于角色导航通过。</p><details><summary>连接点与标高</summary><table><tr><th>编号</th><th>内容</th><th>区</th><th>标高</th></tr>'+node_rows+'</table></details><details><summary>道路宽度、坡度与类型</summary><table><tr><th>道路</th><th>连接</th><th>宽</th><th>坡度</th><th>类型</th></tr>'+road_rows+'</table></details></section>',
        '<section id="roads"><span class="eyebrow">06 / 断面与余量</span><h2>先落到平处，再转向、换路或返回</h2><p>每条路两端设置同标高的平坦接路段，延伸至落脚平台外侧；坡道从平台外开始，避免从平台下面钻入。普通节点半径8米、共享庭院半径14米；生活大庭院和侧岛庭单独加大。陡段先拉长接近距离，再做台阶，梯下封实体，不留误导性的钻行空隙。</p><p>本轮P参数为连续坡道不超过12°、净空目标至少3.2米、台阶最大18厘米且踏面至少28厘米；这些是此图集的设计草案，正式角色规则接入后再核定。三层共轴平台剖面净空为21.2/9.2米，检查范围仅该剖面，不代表全地图碰撞或净空通过。</p></section>',
        '<section id="blender"><span class="eyebrow">07 / 可编辑几何</span><h2>图的脉络已进入Blender</h2>'+picture('city-blender-massing.png','真实Blender路网与室内体量白模：平坦落脚/接路、陡梯封底、开放螺旋井、房间墙和门。不是最终美术场景。')+'<p>已建立37处平台、43条独立道路、27个房间、22层古塔和工艺房体量。地图全部287个身份保留在数据中；尚未接角色行走、服务器导航与正式场景。美术图负责氛围，白模负责结构，两者不能互相代替。</p><p class="files"><a href="sky-city-spatial-prototype.blend">可编辑Blender源</a> · <a href="sky-city-spatial-prototype.glb">GLB白模</a> · <a href="sky-city-spatial-layout.json">同源空间数据</a> · <a href="city-connections.md">连接编号表</a> · <a href="../references/orbis-map-topology-tms273.md">原版名称与门户全表</a></p><details><summary>全部287个地图身份与归属</summary><table><tr><th>区</th><th>地图ID</th><th>名称</th><th>源状态</th></tr>'+map_rows+'</table></details></section>',
    ]
    studies={
        'A':[],
        'B':[('district-B-craft-cutaway.png','五类工艺与研习室剖开屋顶'),('district-B-hero-model.png','英雄殿山丘与庭院')],
        'C':[(f'district-C-{part}-model.png',caption) for part,caption in [('lower','三色下庭与水庭'),('upper','三色上庭与换路庭院')]],
        'D':[(f'district-D-park-{i}-model.png',f'云彩公园 {i} · 独立景观岛') for i in range(1,7)],
        'E':[(f'district-E-{part}-model.png',caption) for part,caption in [('crossing','高桥、下廊与旧路穿插'),('stairs','天空阶梯与折返平台'),('dark','黑光庭园与古林')]],
        'F':[(f'district-F-level-{i}-model.png',f'女神圣域第 {i} 层 · 独立房间与环廊') for i in range(1,4)],
        'G':[(f'district-G-section-{i}-model.png',caption) for i,caption in enumerate(['天空塔 20—14 层','天空塔 13—7 层','天空塔 6 层—地下 2 层'],1)],
        'H':[('district-H-high-model.png','侧岛高台与探索庭院')],
    }
    gallery=picture('city-blender-massing.png','同一份真实 Blender 模型：35 座主浮岛、碎岛承托、吊桥与彩虹桥。建筑仍处于体量与内容建模阶段。')
    for block in layout['blocks']:
        zone=block['id']
        gallery+='<details id="model-'+zone+'"><summary>'+zone+' · '+escape(block['label'])+' · 区域与分层模型</summary>'
        gallery+=picture('district-'+zone+'-model.png',zone+' 区独立模型全貌；隔离展示会在区界截断跨区连接，完整承托关系见全城预览。')
        for filename,caption in studies[zone]: gallery+=picture(filename,caption+'；来自同一模型，非生成概念图。')
        gallery+='</details>'
    gallery+=picture('city-rainbow-model.png','圣域入口彩虹桥：七条发光色带，动态预览中有沿桥流动的亮纹。')
    gallery+=picture('city-carriers-model.png','碎岛链与阶梯承托近景，塔口绕行支路接回外缘入口。')
    sections.insert(0,'<section id="models"><span class="eyebrow">3D / 实际建模</span><h2>先看浮岛与各层各区的真实模型</h2><p><a href="city-walk-preview.html">打开可转动、可浮动的全城三维预览</a> · 可调能量强度，或暂停浮动；选择起终点后可沿实际中心线跟随。</p><p>道路沿已认可的区内网生成。外部道路采用主岛/碎岛承托、悬索桥或圣域彩虹桥；岛上建筑与植被跟随岛体，道路和载体跟随连接两端。模型已检查静态承托与岩体净空，角色碰撞和多人导航仍待接入。</p>'+gallery+'</section>')
    html='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>天空之城 · 总分总空间原型图集</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f2eb;color:#27323d;font:17px/1.75 "PingFang SC",sans-serif}header,main,footer{max-width:1300px;margin:auto;padding:40px 42px}header{padding-top:65px;border-bottom:1px solid #d6d7d1}h1{font-size:43px;line-height:1.3;font-weight:600}h2{font-size:29px;font-weight:550;margin:8px 0 20px}p{max-width:1000px}nav{display:flex;gap:25px;flex-wrap:wrap}a{color:#486582;text-underline-offset:5px}section{padding:50px 0;border-bottom:1px solid #d6d7d1;scroll-margin-top:15px}.eyebrow{color:#7c887f;font-size:14px;letter-spacing:2px}figure{margin:25px 0}img{display:block;width:100%;height:auto;border-radius:8px;background:#e7e6de}figcaption{color:#69737a;font-size:14px;margin-top:10px}table{width:100%;border-collapse:collapse;margin:18px 0;font-size:15px}td,th{border-bottom:1px solid #d6d7d1;text-align:left;padding:12px;vertical-align:top}th{background:#e8ece9}details{margin:20px 0}summary{cursor:pointer;color:#486582}footer{font-size:14px;color:#69737a}@media(max-width:650px){header,main,footer{padding:24px}h1{font-size:31px}h2{font-size:24px}table{font-size:12px}td,th{padding:7px}}
    </style><header><span class="eyebrow">SKY CITY / 空间原型 01</span><h1>天空之城 · 总分总空间原型</h1><p>明亮的生活城区与女神遗迹，在高低交织的庭院和螺旋道路中相遇。先确认全城分块，再看分区内容，最后沿编号道路走回完整脉络。</p><nav><a href="#blocks">分块总图</a><a href="#life">生活与工艺</a><a href="#gardens">庭园与阶梯</a><a href="#interior">圣域与古塔</a><a href="#lines">分线总图</a><a href="#roads">道路断面</a><a href="#blender">Blender白模</a></nav></header><main>'''+''.join(sections)+'''</main><footer>2026-10-02 · TMS273原版来源与原创P空间设计分别保留 · 图集图片内嵌，可离线打开；源文件链接需与原目录一同保留。</footer></html>'''
    html=html.replace('<section id="roads">','<section id="roads">'+picture('city-road-landing.png','真实Blender道路近景：平坦接路后进入阶梯；梯下封实体，落脚平台能转向并回主路。'))
    road_plans=''.join('<details><summary>'+b['id']+' · '+b['label']+'</summary>'+picture('district-'+b['id']+'-roads.svg','区内街道网与成对入口；室内按楼层展开，完整高度关系见可转动白模。')+'</details>' for b in layout['blocks'])
    html=html.replace('<section id="lines">','<section id="lines"><p><a href="city-walk-preview.html">转动全城、选择起终点、沿路跟随预览</a></p>')
    html=html.replace('<details><summary>连接点与标高</summary>',road_plans+'<details><summary>连接点与标高</summary>')
    html=html.replace('37个连接点、43条独立道路',f'{len(layout["nodes"])}个连接点、{len(layout["edges"])}条独立道路、{len(layout["gates"])}组成对区界入口')
    html=html.replace('已建立37处平台、43条独立道路',f'已建立{len(layout["nodes"])}处平台、{len(layout["edges"])}条独立道路')
    html=html.replace('普通节点半径8米、共享庭院半径14米；生活大庭院和侧岛庭单独加大','普通地标节点半径8米、共享庭院半径14米；生活庭院22米、侧岛庭55米，区界门口3米、室内2米')
    html=html.replace('H区内容清单已纳入，当前只建立侧岛入口和聚落庭的体量占位，尚未细建克里塞各内容空间','H区已补聚落、总部、外缘、无法地带、竞技庭与高塔之间的内街环路；建筑、居民与探索内容仍待细化')
    html=html.replace('所有路线均为P空间改编。原版固定门户另存；','每区内部是街道、院廊和坡阶的网，区界用成对门口相接。示例路线沿points实际路面计算，不跨区块中心画弦。所有路线均为P空间改编。原版固定门户另存；')
    html=html.replace('<nav>','<nav><a href="#models">各区各层建模</a>')
    html=html.replace('三层共轴平台剖面净空为21.2/9.2米，检查范围仅该剖面，不代表全地图碰撞或净空通过','外部普通道路承托采样和所有道路的岩体净空采样已通过；吊桥/彩虹桥采用各自桥体。检查范围不包括正式角色碰撞或导航')
    html=html.replace('GLB白模','GLB模型').replace('Blender白模','Blender模型')
    assert html.count('<section ')==8 and html.count('data:image/')==picture_count
    (OUT/'city-atlas.html').write_text(html,encoding='utf-8')


def check_model():
    layout=json.loads((OUT/'sky-city-spatial-layout.json').read_text(encoding='utf-8'))
    raw=(OUT/'sky-city-spatial-prototype.glb').read_bytes()
    assert struct.unpack_from('<4sII',raw)==(b'glTF',2,len(raw))
    size,kind=struct.unpack_from('<I4s',raw,12); assert kind==b'JSON'
    gltf=json.loads(raw[20:20+size]); props=[n.get('extras',{}) for n in gltf['nodes']]
    assert json.loads(gltf['scenes'][0]['extras']['spatial_layout'])==layout
    assert sum('node_id' in p for p in props)==len(layout['nodes'])
    assert sum('edge_id' in p for p in props)==len(layout['edges'])
    roads={p['edge_id']:p for p in props if 'edge_id' in p}
    for e in layout['edges']: assert json.loads(roads[e['id']]['path_centerline'])==e['points']
    assert {p['map_id'] for p in props if 'map_id' in p}=={r['mapId'] for r in layout['rooms']}
    assert sum('original_floor' in p for p in props)==22
    pads={n['extras']['node_id']:n for n in gltf['nodes'] if 'node_id' in n.get('extras',{})}
    for node in layout['nodes']:
        expected=list(node['position']); expected[1]-=.4
        assert all(abs(a-b)<.001 for a,b in zip(pads[node['id']]['translation'],expected)),node['id']
    blend=(OUT/'sky-city-spatial-prototype.blend').read_bytes()
    assert blend[:7]==b'BLENDER' or blend[:4]==b'\x28\xb5\x2f\xfd'  # Blender 5 can save a Zstandard container.
    assert sum(p.get('collision_role','').startswith('closed under-stair') for p in props)==sum(e['kind']=='stairs' and e['surface']!='floating-stairs' for e in layout['edges'])
    assert sum(p.get('collision_role','').startswith('floating treads') for p in props)==sum(e['surface']=='floating-stairs' for e in layout['edges'])
    assert {p['island_id'] for p in props if p.get('island_id')}=={s['id'] for s in layout['landscape']['islands']}
    assert {p['bridge_edge'] for p in props if p.get('bridge_edge')}=={s['id'] for s in layout['physicalLinks'] if s['surface']=='suspension'}
    assert all(roads[e['id']]['carrier']==e['carrier'] for e in layout['edges'])
    assert sum(bool(p.get('rainbow_bridge')) for p in props)==sum(e['surface']=='rainbow' for e in layout['edges'])
    checks=gltf['scenes'][0]['extras']
    assert json.loads(checks['road_carrier_check'])['unsupported']==0
    assert json.loads(checks['terrain_clearance_check'])['conflicts']==0
    assert all(p['support_edge'] in roads for p in props if p.get('support_edge'))
    print('GLB same-source / platforms / roads / rooms / floors / stairs / carriers / rainbow: passed')


def main():
    source = json.loads(SOURCE.read_text(encoding='utf-8'))
    nodes = [dict(id=i,label=l,zone=z,position=p) for i,l,z,p in NODES+LOCAL_NODES]
    edges=[]; routes=[]; gates=[]; index={n['id']:n for n in nodes}; edge_keys={}; custom={}
    route_specs=list(ROUTES+LOCAL_ROUTES)
    assignments=[dict(mapId=m['id'],name=m['name'],zone=zone_for(m),sourceStatus=m['status'],
        use='travel-instance' if m['group'].startswith('航行') or m['group']=='跨地区移动地图' else 'content-space') for m in source['maps']]
    rooms=[]
    for i,m in enumerate(x for x in assignments if x['zone']=='F'):
        # Individual identities retained. Room placement is a prototype, not the lost PQ portal graph.
        floor=i//9; angle=2*math.pi*(i%9)/9
        rooms.append(dict(id=f'F-R{i+1:02d}',mapId=m['mapId'],label=m['name'],
            center=[round(160+65*math.cos(angle),2),94+14*floor,round(-300+65*math.sin(angle),2)],
            size=[18,8,18],door=f'F-D{i+1:02d}',connection='central-cloister-P'))
        cid=f'F-C{i+1:02d}'
        nodes.extend([dict(id=cid,label=f'环廊{i+1:02d}',zone='F',position=[160+49*math.cos(angle),94+14*floor,-300+49*math.sin(angle)],interior=True),
            dict(id=f'F-R{i+1:02d}',label=m['name'],zone='F',position=rooms[-1]['center'],interior=True)])
        route_specs.append((f'room-{i+1:02d}',m['name'],'#8b78a3',[cid,f'F-R{i+1:02d}']))
    for floor in range(3):
        ids=[f'F-C{floor*9+i+1:02d}' for i in range(9)]
        route_specs.append((f'cloister-{floor}','圣域环廊','#8b78a3',ids+[ids[0]]))
        for i in range(9):
            theta=2*math.pi*i/9
            custom[(ids[i],ids[(i+1)%9])]=[[160+49*math.cos(theta+2*math.pi*t/9),94+14*floor,-300+49*math.sin(theta+2*math.pi*t/9)] for t in [j/8 for j in range(9)]]
    def spiral(center,radius,start,end,landing):
        points=[[center[0]+landing,start,center[2]]]
        for i in range(65):
            t=i/64; height=start+(end-start)*max(0,min(1,(t-.0625)/.875))
            points.append([center[0]+radius*math.cos(t*2*math.pi),height,center[2]+radius*math.sin(t*2*math.pi)])
        points.append([center[0]+landing,end,center[2]])
        return points
    for floor in range(2):
        pair=(f'F-C{floor*9+1:02d}',f'F-C{(floor+1)*9+1:02d}')
        custom[pair]=spiral([160,0,-300],40,94+14*floor,108+14*floor,49)
        route_specs.append((f'inner-stair-{floor}','内部螺旋','#8b78a3',list(pair)))
    custom[('P20','F-C14')]=[[80,110,-240],[96,110,-252],[122.46,108,-268.5]]+[[160+49*math.cos(math.radians(t)),108,-300+49*math.sin(math.radians(t))] for t in range(140,161,4)]
    custom[('F02','F-C05')]=[[45,94,-305],[85,94,-305],[111,94,-300]]+[[160+49*math.cos(math.radians(t)),94,-300+49*math.sin(math.radians(t))] for t in range(180,159,-4)]
    levels=list(range(20,0,-1))+[-1,-2]
    gids=[]
    for i,level in enumerate(levels):
        nid=f'G-{level}' if level>0 else f'G-B{-level}'; gids.append(nid)
        nodes.append(dict(id=nid,label=f'天空塔{level}层',zone='G',position=[-86,12-7*i,190],interior=True,sourceMapId=str(200080200+i*100)))
        if i: custom[(gids[i-1],nid)]=spiral([-100,0,190],10,19-7*i,12-7*i,14)
    route_specs.append(('tower-interior','天空塔内部','#8392a7',['P25']+gids))
    side_rooms=[]
    for nid,label,host,height,map_id,z in [('G-S16','隐密的房间','G-16',-16,'200080601',190),('G-S10','秘密之室','G-10',-58,'200081201',190),('G-LAB','秀茲研究室','G-B2',-135,'200082301',190),('G-EXIT','疑问之塔·离开厅','G-20',12,'200080101',215)]:
        nodes.append(dict(id=nid,label=label,zone='G',position=[-65,height,z],interior=True,sourceMapId=map_id))
        side_rooms.append(dict(id=nid,label=label,center=[-65,height,z],size=[14,8,14],mapId=map_id))
        route_specs.append((nid,label,'#8392a7',[host,nid]))
    index={n['id']:n for n in nodes}
    index['P25']['sourceMapId']='200080100'

    def add_edge(a,b,raw,rid,width,preserve_height=False):
        run=horizontal_length(raw); rise=abs(index[b]['position'][1]-index[a]['position'][1])
        approaches=[0,0] if preserve_height else [landing_radius(a)+2,landing_radius(b)+2]
        if rise==0: approaches=[min(x,run*.2) for x in approaches]
        assert run>sum(approaches),(a,b,'no space for flat landings')
        if not preserve_height:
            raw=path_slice(raw,0,run)
            distances={0,run,approaches[0],run-approaches[1]}; d=0
            for p,q in zip(raw,raw[1:]): d+=math.hypot(q[0]-p[0],q[2]-p[2]); distances.add(d)
            points=[]
            for distance in sorted(distances):
                p=point_at(raw,distance); t=max(0,min(1,(distance-approaches[0])/(run-sum(approaches))))
                p[1]=index[a]['position'][1]+(index[b]['position'][1]-index[a]['position'][1])*t; points.append(p)
        else: points=raw
        points[0]=list(index[a]['position']); points[-1]=list(index[b]['position'])
        grades=[math.degrees(math.atan2(abs(q[1]-p[1]),math.hypot(q[0]-p[0],q[2]-p[2]))) for p,q in zip(points,points[1:])]
        grade=max(grades); eid=f'L{len(edges)+1:03d}'
        e=dict(id=eid,route=rid,routes=[rid],start=a,end=b,width=width,length=round(sum(math.sqrt(sum((q[k]-p[k])**2 for k in range(3))) for p,q in zip(points,points[1:])),2),
            points=points,origin='P',gradeDegrees=round(grade,2),undersideWalkable=False,approachLengths=approaches,
            kind='stairs' if grade>12 or preserve_height and rise>3 else 'ramp' if rise else 'walkway',interior=bool(index[a].get('interior') and index[b].get('interior')))
        edges.append(e); return eid

    for rid,label,color,ids in route_specs:
        route_edges=[]; expanded=[ids[0]]
        for a,b in zip(ids,ids[1:]):
            key=tuple(sorted((a,b)))
            if key in edge_keys:
                chain=edge_keys[key]
                for eid in chain:
                    if rid not in edges[int(eid[1:])-1]['routes']: edges[int(eid[1:])-1]['routes'].append(rid)
                oriented=chain if edges[int(chain[0][1:])-1]['start']==a else list(reversed(chain))
                current=a
                for eid in oriented:
                    e=edges[int(eid[1:])-1]; current=e['end'] if e['start']==current else e['start']; expanded.append(current)
                route_edges.extend(oriented); continue
            raw=custom.get((a,b)); preserve=raw is not None
            if raw is None and (b,a) in custom: raw=list(reversed(custom[(b,a)])); preserve=True
            if raw is None: raw=street_path(index[a],index[b])
            width=3 if a.startswith('G-') or b.startswith('G-') else 4 if rid=='hidden' or a.startswith('F-') or b.startswith('F-') else 6 if rid not in {r[0] for r in ROUTES} else 10
            if index[a]['zone']!=index[b]['zone']:
                run=horizontal_length(raw); approach_a=landing_radius(a)+2; approach_b=landing_radius(b)+2
                free=run-approach_a-approach_b; assert free>0,(a,b,'no space between district platforms')
                mid=approach_a+free/2; gap=min(8,free*.08); pair=len(gates)+1
                left=point_at(raw,mid-gap); right=point_at(raw,mid+gap)
                left[1]=right[1]=(index[a]['position'][1]+index[b]['position'][1])/2
                exit_id=f'GX{pair:02d}'; entry_id=f'GI{pair:02d}'
                for nid,p,zone,role in [(exit_id,left,index[a]['zone'],'exit'),(entry_id,right,index[b]['zone'],'entry')]:
                    n=dict(id=nid,label=f'{zone}区{role=="exit" and "出口" or "入口"}{pair:02d}',zone=zone,position=p,gate=True,
                        parentConnection=[a,b],connectionT=(mid-gap if role=='exit' else mid+gap)/run)
                    nodes.append(n); index[nid]=n
                gate=dict(id=f'GATE{pair:02d}',exit=exit_id,entry=entry_id,fromZone=index[a]['zone'],toZone=index[b]['zone'],origin='P'); gates.append(gate)
                chain=[add_edge(a,exit_id,path_slice(raw,0,mid-gap),rid,width),add_edge(exit_id,entry_id,path_slice(raw,mid-gap,mid+gap),rid,width),add_edge(entry_id,b,path_slice(raw,mid+gap,run),rid,width)]
                expanded.extend([exit_id,entry_id,b])
            else: chain=[add_edge(a,b,raw,rid,width,preserve)]; expanded.append(b)
            edge_keys[key]=chain; route_edges.extend(chain)
        routes.append(dict(id=rid,label=label,color=color,nodes=expanded,edges=route_edges))
    island_specs=[dict(id=i,zone=z,label=l,center=p,radii=r,depth=d,biome=b,
        motionPhase=j*2.399963,motionPeriod=22+j%11) for j,(i,z,l,p,r,d,b) in enumerate(ISLANDS)]
    def island_for(n):
        if n['zone']=='G': return 'A03'
        if n['zone']=='F' and n.get('interior'): return 'F01'
        candidates=[s for s in island_specs if s['zone']==n['zone']]
        def cost(s):
            p=n['position']; c=s['center']; r=s['radii']
            return math.hypot((p[0]-c[0])/r[0],(p[2]-c[2])/r[1])+abs(p[1]-c[1])*.045
        return min(candidates,key=cost)['id']
    for n in nodes:
        if not n.get('gate'): n['islandWeights']={island_for(n):1}
    for n in nodes:
        if not n.get('gate'): continue
        a,b=n['parentConnection']; t=n['connectionT']; weights={}
        for nid,w in [(a,1-t),(b,t)]:
            for sid,v in index[nid]['islandWeights'].items(): weights[sid]=weights.get(sid,0)+w*v
        n['islandWeights']=weights
    physical_links=[]
    for (a,b),chain in edge_keys.items():
        current=edges[int(chain[0][1:])-1]['start']; ids=chain if current==a else list(reversed(chain)); points=[]
        current=a
        for eid in ids:
            e=edges[int(eid[1:])-1]; part=e['points'] if e['start']==current else list(reversed(e['points']))
            points.extend(part if not points else part[1:]); current=e['end'] if e['start']==current else e['start']
        independent=index[a]['islandWeights']!=index[b]['islandWeights']
        stair=any(edges[int(eid[1:])-1]['kind']=='stairs' for eid in chain)
        surface='rainbow' if {a,b}=={'P16','P20'} else 'floating-stairs' if independent and stair else 'suspension' if independent and horizontal_length(points)>60 and not index[a].get('interior') and not index[b].get('interior') else 'terrace'
        link=dict(id='PH%03d'%(len(physical_links)+1),start=a,end=b,edges=ids,points=points,surface=surface)
        physical_links.append(link)
        for eid in chain:
            e=edges[int(eid[1:])-1]; e['surface']=surface
            e['carrier']='suspension-cables' if surface=='suspension' else 'rainbow-energy-bridge' if surface=='rainbow' else 'building-floor' if e['interior'] else 'land-or-fragment-islands'
    layout=dict(kind='sky-city-spatial-prototype',units='metres',up='Y',origin='P',stage='district-modelling',
        provenance=str(SOURCE.relative_to(ROOT)),blocks=[dict(id=i,label=l,center=p,size=s,color=c) for i,l,p,s,c in BLOCKS],
        nodes=nodes,edges=edges,routes=routes,gates=gates,mapAssignments=assignments,rooms=rooms,sideRooms=side_rooms,
        tower=dict(center=[-100,12,190],radius=16,floorHeight=7,levels=list(range(20,0,-1))+[-1,-2]),
        crafts=['阅览与图书','铁匠','布艺','木匠','魔法炼金'],
        landscape=dict(origin='P',islands=island_specs,
            assetsSource='Quaternius Stylized Nature MegaKit Standard / CC0',
            motion=dict(commonAmplitude=1.6,localAmplitude=.24,energyMax=2,commonPeriod=28),
            rockAlgorithm='tapered angular mass + bounded 4 octave fBm + ridged multifractal; fixed seed',
            roadCarriers=dict(fragmentSpacing=4,maxSurfaceGap=1.8,minDynamicClearance=4.8,
                rule='no uncarried exterior road: land/fragments, suspension or rainbow bridge'),
            clearanceScope='terrain surface rays along road width; visual study, no authoritative collision'),
        physicalLinks=physical_links,
        crossings=[dict(nodes=['P12','P13','P23'],sameXZ=True,connected=False,minClearance=3.2,
            floorThickness=.8,sectionClearances=[21.2,9.2],checkScope='at the common landing centre only')],
        landings=[dict(node=n['id'],radius=landing_radius(n['id']),level=n['position'][1]) for n in nodes],
        roadRules=dict(origin='P-prototype',maxContinuousRampDegrees=12,minHeadClearance=3.2,
            maxStepHeight=.18,minTreadDepth=.28,undersides='closed unless separately planned with verified clearance',
            platformRecovery='landings connect to main routes; no automatic drop onto lower road'),
        notes=['分区内街道网与成对出入口同源；points是实际道路中心线，图与路面沿该线生成。',
            '生活/研习与遗迹探索各约一半，指空间用途，不按地图ID数量分半。',
            '所有空间连接是当前P方案；原版固定门户另存，不被改写。',
            '房间保持全部地图身份；重复航行/PQ实例通过映射保留，不凭名字去重。',
            '体量包络可重叠；白模的实体墙面/净空/附加支室尚需定向验证。'])
    layout['districtNetworks']=[dict(zone=z,nodes=[n['id'] for n in nodes if n['zone']==z],
        edges=[e['id'] for e in edges if index[e['start']]['zone']==index[e['end']]['zone']==z],
        gates=[g['id'] for g in gates if z in (g['fromZone'],g['toZone'])]) for z in 'ABCDEFGH']
    source_maps={m['id']:m for m in source['maps']}
    layout['sourcePortalBindings']=[]
    for source_id,portal,target_id,target_portal,a,b in [
        ('200000000','east00','200010000','top00','P02','D00'),
        ('200010000','top01','200010100','under00','D00','P05'),
        ('200010100','top00','200010110','under00','P05','P06'),
        ('200010100','top01','200010120','under00','P05','P08'),
        ('200010100','top02','200010130','under00','P05','P10'),
        ('200000000','tower00','200080100','top00','P02','P25'),
        ('200010000','under00','200020000','top00','D00','P27')]:
        p=next(p for p in source_maps[source_id]['portals'] if p['name']==portal)
        q=next(p for p in source_maps[target_id]['portals'] if p['name']==target_portal)
        assert p['type']==q['type']==2 and (p['target'],p['targetPortal'])==(target_id,target_portal)
        assert (q['target'],q['targetPortal'])==(source_id,portal)
        layout['sourcePortalBindings'].append(dict(sourceMap=source_id,sourcePortal=portal,targetMap=target_id,
            targetPortal=target_portal,spaceNodes=[a,b],evidence='TMS273 fixed portal, both ends verified; 3D geometry is P'))
    layout['walkExamples']=[dict(label='码头 → 生活研习庭',**shortest_path(layout,'P01','P03')),
        dict(label='码头 → 三色分岔',**shortest_path(layout,'P01','P05'))]
    # Sub-millimetre precision is sufficient for these metre-scale surfaces and keeps the Blender data injection bounded.
    layout=json.loads(json.dumps(layout,ensure_ascii=False),parse_float=lambda s:round(float(s),4))
    nodes=layout['nodes']; edges=layout['edges']; index={n['id']:n for n in nodes}
    for e in edges:
        distinct=[]
        for p in e['points']:
            if not distinct or p!=distinct[-1]: distinct.append(p)
        e['points']=distinct
    # One runnable check: all source IDs survive, primary routes join, and grade-separated crossings stay separate.
    assert len(assignments)==len({m['mapId'] for m in assignments})==287
    assert Counter(m['zone'] for m in assignments)==dict(A=160,B=7,C=7,D=12,E=5,F=27,G=27,H=42)
    assert len(rooms)==27 and len(layout['tower']['levels'])==22
    assert len(ISLANDS)==len({i[0] for i in ISLANDS})==35
    assert all(i[1] in 'ABCDEFH' and min(i[4])>0 and i[5]>0 for i in ISLANDS)
    assert all(abs(sum(n['islandWeights'].values())-1)<.00001 for n in nodes)
    assert {eid for link in physical_links for eid in link['edges']}=={e['id'] for e in edges}
    assert {n['sourceMapId'] for n in nodes if n.get('sourceMapId')}=={m['mapId'] for m in assignments if m['zone']=='G'}
    reachable={'P01'}
    while True:
        before=len(reachable)
        for e in edges:
            if e['start'] in reachable or e['end'] in reachable: reachable.update((e['start'],e['end']))
        if len(reachable)==before: break
    assert reachable==set(index),set(index)-reachable
    for district in layout['districtNetworks']:
        connected={district['nodes'][0]}
        while True:
            before=len(connected)
            for e in edges:
                if e['id'] in district['edges'] and (e['start'] in connected or e['end'] in connected): connected.update((e['start'],e['end']))
            if len(connected)==before: break
        assert connected==set(district['nodes']),(district['zone'],set(district['nodes'])-connected)
    for g in gates:
        assert index[g['exit']]['zone']==g['fromZone'] and index[g['entry']]['zone']==g['toZone']
        assert index[g['exit']]['position'][1]==index[g['entry']]['position'][1]
    for e in edges:
        assert e['points'][0]==index[e['start']]['position'] and e['points'][-1]==index[e['end']]['position']
        assert all(all(math.isfinite(v) for v in p) for p in e['points'])
        if index[e['start']]['zone']==index[e['end']]['zone']=='B':
            # Catch the former courtyard-in-house and straight-through-back-wall errors against actual shell dimensions.
            for a,b in zip(e['points'],e['points'][1:]):
                count=max(1,math.ceil(math.hypot(b[0]-a[0],b[2]-a[2])/2))
                for j in range(count+1):
                    p=[a[k]+(b[k]-a[k])*j/count for k in range(3)]
                    if not 24<=p[1]<36: continue
                    for i in range(5):
                        x=-360+(i%3)*48; z=65+(i//3)*58; margin=e['width']/2+.5
                        assert not (abs(p[2]-(z-16))<margin and abs(p[0]-x)<16+margin),(e['id'],'craft back wall')
                        assert not (abs(p[0]-(x-16))<margin and abs(p[2]-z)<16+margin),(e['id'],'craft side wall')
    assert layout['walkExamples'][1]['length']<400  # Regression: Cloud-I entry must not detour through its east outer-ring junction.
    assert index['P12']['position'][::2]==index['P13']['position'][::2]==index['P23']['position'][::2]
    assert min(index['P12']['position'][1]-index['P13']['position'][1],index['P13']['position'][1]-index['P23']['position'][1])>=8
    assert all(e['kind']=='stairs' or e['gradeDegrees']<=12 for e in edges)
    assert all(not e['undersideWalkable'] for e in edges)
    for e in edges:
        if e['kind']=='stairs':
            p,q=index[e['start']]['position'],index[e['end']]['position']
            run=horizontal_length(e['points'])-sum(e['approachLengths'])
            assert run/math.ceil(abs(p[1]-q[1])/.18)>=.28, (e['id'],'tread too shallow')
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/'sky-city-spatial-layout.json').write_text(json.dumps(layout,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    for mode in ('blocks','lines'): (OUT/f'city-{mode}.svg').write_text(svg(layout,mode),encoding='utf-8')
    for zone in 'ABCDEFGH': (OUT/f'district-{zone}-roads.svg').write_text(network_svg(layout,zone),encoding='utf-8')
    (OUT/'city-connections.md').write_text('# 空间连接与标高草案\n\nP设计；供白模使用，不是原版或服务端导航。\n\n| 道路 | 路线 | 起点 | 终点 | 宽m | 长m |\n| --- | --- | --- | --- | --- | --- |\n'+
        '\n'.join(f'| {e["id"]} | {e["route"]} | {e["start"]} | {e["end"]} | {e["width"]} | {e["length"]} |' for e in edges)+'\n',encoding='utf-8')
    with (OUT/'city-connections.md').open('a',encoding='utf-8') as f:
        f.write('\n## 连接点\n\n| 编号 | 内容 | 分区 | X / Y / Z（m） |\n| --- | --- | --- | --- |\n')
        f.write('\n'.join(f'| {n["id"]} | {n["label"]} | {n["zone"]} | {n["position"]} |' for n in nodes)+'\n')
        f.write('\n## 成对区界入口\n\n'+ '\n'.join(f'- {g["id"]}: {g["fromZone"]}/{g["exit"]} ↔ {g["toZone"]}/{g["entry"]}' for g in gates)+'\n')
        f.write('\n## 沿实际道路的走法\n\n'+'\n'.join(f'- {w["label"]}: {" → ".join(w["edges"])}；路面弧长 {w["length"]}m。' for w in layout['walkExamples'])+'\n')
    if '--html' in sys.argv: write_atlas(layout)
    print(json.dumps(dict(maps=len(assignments),nodes=len(nodes),edges=len(edges),rooms=len(rooms),checks='passed'),ensure_ascii=False))


if __name__=='__main__':
    if '--check-model' in sys.argv: check_model()
    else: main()
