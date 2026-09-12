#!/usr/bin/env python3
"""Render authored dialogue and behavior JSON as reviewable Mermaid trees."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'resources/creative/windbell/narrative'
OUT = ROOT / 'docs/design/windbell/BRANCH_ATLAS.md'


def label(value, limit=100):
    return str(value)[:limit].replace('&','&amp;').replace('"','&quot;').replace('\n',' ').replace('<','&lt;').replace('>','&gt;').replace('|','／')


def build():
    dialogue=json.loads((DATA/'dialogue.json').read_text(encoding='utf-8'))
    behavior=json.loads((DATA/'behavior_trees.json').read_text(encoding='utf-8'))
    text=['# 风铃桥／岛：文案分支与行为树图册', '', '从实际叙事 JSON 自动生成；用于内容审阅，不是游戏已经执行这些规则的证明。完整条件、效应、对白和重放边界以 [叙事数据](../../../resources/creative/windbell/narrative/) 为准。', '', '刷新命令：`python3 scripts/creative/build_windbell_trees.py`。', '']
    for tree in dialogue['trees']:
        text += ['## '+tree['id'], '', '```mermaid','flowchart TD']
        ids={node['id']:'n'+str(i) for i,node in enumerate(tree['nodes'])}
        for node in tree['nodes']:
            content=node.get('text') or node['id']
            text.append('  {}["{}: {}"]'.format(ids[node['id']],label(node['type']),label(content)))
            edges=[]
            if node.get('next'):edges.append((node['next'],'继续'))
            if node.get('default'):edges.append((node['default'],'其他情况'))
            for case in node.get('cases',[]):
                edges.append((case['next'],json.dumps(case['when'],ensure_ascii=False,separators=(',',':'))))
            for choice in node.get('choices',[]):
                if choice.get('next'):edges.append((choice['next'],choice.get('label',choice['id'])))
                if choice.get('onFailure'):edges.append((choice['onFailure'],choice.get('label',choice['id'])+'：失败'))
            for target,edge in edges:
                assert target in ids, (tree['id'],target)
                text.append('  {} -->|"{}"| {}'.format(ids[node['id']],label(edge,150),ids[target]))
        text += ['```','']
    for tree in behavior['trees']:
        text += ['## '+tree['id'],'',tree.get('purpose',''),'','```mermaid','flowchart TD']
        count=[0]
        def walk(node):
            alias='b'+str(count[0]);count[0]+=1
            content=node.get('actionId') or json.dumps(node.get('condition',{}),ensure_ascii=False,separators=(',',':')) if node['type'] in ('action','condition') else node['id']
            text.append('  {}["{}: {}"]'.format(alias,label(node['type']),label(content,160)))
            for child in node.get('children',[]):
                child_alias=walk(child)
                text.append('  {} --> {}'.format(alias,child_alias))
            return alias
        walk(tree['root'])
        text += ['```','']
    OUT.write_text('\n'.join(text)+'\n',encoding='utf-8')
    print('Rendered {} dialogue and {} behavior trees'.format(len(dialogue['trees']),len(behavior['trees'])))

if __name__=='__main__':
    build()
