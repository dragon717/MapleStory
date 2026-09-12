#!/usr/bin/env python3
"""离线检查风铃桥／风铃岛原创叙事数据，并演示最小关键分支。

只使用 Python 标准库；本脚本不是生产运行时，不连接服务、不写数据库。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "resources" / "scenes" / "windbell" / "narrative"
REQUIRED_CHARACTER_IDS = {
    "npc.traveler.wei",
    "npc.craftsman.mu_cen",
    "npc.bellkeeper.lan_zhi",
}
REQUIRED_ACTION_IDS = {
    "action.windbell.cart.brace",
    "action.windbell.cart.first_aid",
    "action.windbell.cart.lookout.begin",
    "action.windbell.cart.lookout.complete",
    "action.windbell.cart.lookout.cancel",
    "action.windbell.bridge.handoff.plank",
    "action.windbell.bridge.handoff.rope",
    "action.windbell.bridge.install.segment.01",
    "action.windbell.bridge.install.segment.02",
    "action.windbell.bridge.install.segment.03",
    "action.windbell.cart.self_rescue.bandage",
    "action.windbell.cart.self_rescue.secure",
    "action.windbell.cart.self_rescue.brace",
    "action.windbell.cart.depart",
    "action.windbell.cart.arrive",
    "action.windbell.bridge.establish.shelter",
    "action.windbell.island.cut.support",
    "action.windbell.island.land.bridge",
    "action.windbell.island.ignite.branch",
    "action.windbell.island.leafwing.deploy",
    "action.windbell.island.fire.spend",
    "action.windbell.island.arrive.root",
    "action.windbell.island.arrive.bridge",
    "action.windbell.island.arrive.fire",
    "action.windbell.island.bell.repair",
    "action.windbell.island.visitor.observe",
    "action.windbell.island.dragon.patrol_step",
    "action.windbell.island.dragon.wingbeat",
    "action.windbell.island.dragon.rest",
    "action.windbell.island.dragon.resume",
}
REQUIRED_DIALOGUE_NODES = {
    "dlg.cart.brace.success",
    "dlg.bridge.handoff.accepted_line",
    "dlg.reunion.brace",
    "dlg.reunion.late",
    "dlg.bridge.handoff.partial",
    "dlg.cart.leave",
    "dlg.cart.action.failed",
    "dlg.bridge.replay",
    "dlg.cart.self_rescue.braced",
    "dlg.life.active",
    "dlg.island.root_arrived",
    "dlg.island.bridge_arrived",
    "dlg.island.fire_arrived",
}
VALID_OPS = {"eq", "neq", "gte", "gt", "lte", "lt"}
VALID_NODE_TYPES = {"branch", "line", "wait"}


class CheckError(Exception):
    pass


def load_json(name: str) -> dict[str, Any]:
    path = DATA_DIR / name
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise CheckError(f"{path}: 无法按 UTF-8 解析 JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CheckError(f"{path}: 顶层必须是对象")
    if value.get("sourceClass") != "P":
        raise CheckError(f"{path}: sourceClass 必须明确为 P")
    return value


def unique_ids(items: list[dict[str, Any]], label: str) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(items):
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise CheckError(f"{label}[{index}] 缺少稳定字符串 id")
        if item_id in result:
            raise CheckError(f"{label}: 重复 id {item_id}")
        result[item_id] = item
    return result


def check_condition(condition: Any, fact_ids: set[str], where: str) -> None:
    if not isinstance(condition, dict):
        raise CheckError(f"{where}: 条件必须是对象")
    if "fact" in condition:
        fact_id = condition.get("fact")
        if fact_id not in fact_ids:
            raise CheckError(f"{where}: 未知 fact {fact_id}")
        if condition.get("op") not in VALID_OPS:
            raise CheckError(f"{where}: 未知比较操作 {condition.get('op')}")
        if "value" not in condition:
            raise CheckError(f"{where}: fact 条件缺 value")
        return
    compound = [key for key in ("all", "any") if key in condition]
    if "not" in condition:
        check_condition(condition["not"], fact_ids, f"{where}.not")
        if len(condition) != 1:
            raise CheckError(f"{where}: not 不能和其它条件并列")
        return
    if len(compound) != 1 or len(condition) != 1:
        raise CheckError(f"{where}: 只能使用 fact、all、any 或 not")
    children = condition[compound[0]]
    if not isinstance(children, list) or not children:
        raise CheckError(f"{where}.{compound[0]}: 必须是非空数组")
    for index, child in enumerate(children):
        check_condition(child, fact_ids, f"{where}.{compound[0]}[{index}]")


def collect_conditions(value: Any, fact_ids: set[str], where: str) -> None:
    """验证行为树或对白对象中所有声明式条件。"""
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"condition", "when", "requires"}:
                check_condition(child, fact_ids, f"{where}.{key}")
            elif key not in {"text", "description", "reason", "label", "portraitPrompt"}:
                collect_conditions(child, fact_ids, f"{where}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            collect_conditions(child, fact_ids, f"{where}[{index}]")


def check_facts(facts_doc: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    facts = unique_ids(facts_doc.get("facts", []), "facts")
    events = unique_ids(facts_doc.get("events", []), "events")
    effects = unique_ids(facts_doc.get("effects", []), "effects")
    actions = unique_ids(facts_doc.get("actions", []), "actions")
    fact_ids = set(facts)
    for fact_id, fact in facts.items():
        if fact.get("scope") not in {"shared", "instance", "personal", "encounter"}:
            raise CheckError(f"facts.{fact_id}: scope 不明确")
        if "initial" not in fact:
            raise CheckError(f"facts.{fact_id}: 缺 initial")
        if "values" in fact and fact["initial"] not in fact["values"]:
            raise CheckError(f"facts.{fact_id}: initial 不在 values 中")
        if fact.get("type") == "int" and not isinstance(fact["initial"], int):
            raise CheckError(f"facts.{fact_id}: int initial 必须是整数")

        # 岛屿的物理状态属于当前个人／小队实例；不能把它当成和风铃桥
        # 相同的 shared 全局物理世界。反过来，桥的碰撞和库存必须保持公共。
        if fact_id.startswith("world.windbell.island.") and fact.get("scope") != "instance":
            raise CheckError(f"facts.{fact_id}: 岛屿世界事实必须是 instance scope")
        if fact_id.startswith("world.windbell.bridge.") and fact.get("scope") != "shared":
            raise CheckError(f"facts.{fact_id}: 桥世界事实必须是 shared scope")

    for effect_id, effect in effects.items():
        event_id = effect.get("eventId")
        if event_id not in events:
            raise CheckError(f"effects.{effect_id}: 未知 eventId {event_id}")
        if not effect.get("replayRule"):
            raise CheckError(f"effects.{effect_id}: 缺 replayRule")
        for index, change in enumerate(effect.get("changes", [])):
            fact_id = change.get("fact")
            if fact_id not in facts:
                raise CheckError(f"effects.{effect_id}.changes[{index}]: 未知 fact {fact_id}")
            if facts[fact_id].get("derived"):
                raise CheckError(f"effects.{effect_id}: 不得直接写 derived fact {fact_id}")
            if change.get("op") not in {"set", "increment", "decrement"}:
                raise CheckError(f"effects.{effect_id}.changes[{index}]: 未知 op")
        for index, memory in enumerate(effect.get("memory", [])):
            key = memory.get("key")
            if key not in facts or not key.startswith("memory."):
                raise CheckError(f"effects.{effect_id}.memory[{index}]: 未知 memory key {key}")
            if memory.get("sourceEvent") != event_id:
                raise CheckError(f"effects.{effect_id}.memory[{index}]: sourceEvent 必须与 effect eventId 一致")

    for action_id, action in actions.items():
        effect_id = action.get("effectId")
        if effect_id not in effects:
            raise CheckError(f"actions.{action_id}: 未知 effectId {effect_id}")
        if not action.get("replayRule") or not action.get("requestKey"):
            raise CheckError(f"actions.{action_id}: 缺 requestKey 或 replayRule")
        check_condition(action.get("requires"), fact_ids, f"actions.{action_id}")

    if not REQUIRED_ACTION_IDS <= set(actions):
        raise CheckError(f"actions: 缺少首期动作 {sorted(REQUIRED_ACTION_IDS - set(actions))}")
    for fact_id in ("world.windbell.bridge.stage", "world.windbell.bridge.connected", "world.windbell.bridge.cart.mobility", "world.windbell.bridge.route.condition"):
        if not facts[fact_id].get("derived"):
            raise CheckError(f"facts.{fact_id}: 公共派生事实必须 derived=true")
    if facts["world.windbell.bridge.material.stock.planks"].get("initial") != 6 or facts["world.windbell.bridge.material.stock.rope"].get("initial") != 3:
        raise CheckError("桥的首轮配方必须从 6 块木板、3 条绳索开始")
    return facts, events, effects, actions


def check_characters(characters_doc: dict[str, Any], fact_ids: set[str]) -> dict[str, dict[str, Any]]:
    characters = unique_ids(characters_doc.get("characters", []), "characters")
    if not REQUIRED_CHARACTER_IDS <= set(characters):
        raise CheckError(f"characters: 缺少首期角色 {sorted(REQUIRED_CHARACTER_IDS - set(characters))}")
    for character_id, character in characters.items():
        if character.get("productionStatus") not in {"首期", "后续，未实现"}:
            raise CheckError(f"characters.{character_id}: productionStatus 不明确")
        for key in character.get("memoryKeys", []):
            if key not in fact_ids:
                raise CheckError(f"characters.{character_id}: 未知 memory key {key}")
    future = unique_ids(characters_doc.get("futureCharacters", []), "futureCharacters")
    for character_id, character in future.items():
        if character.get("productionStatus") != "后续，未实现":
            raise CheckError(f"futureCharacters.{character_id}: 后续角色必须明确未实现")
    return characters


def check_behavior_trees(doc: dict[str, Any], fact_ids: set[str], action_ids: set[str], actor_ids: set[str]) -> dict[str, dict[str, Any]]:
    trees = unique_ids(doc.get("trees", []), "behavior trees")
    if not trees:
        raise CheckError("behavior_trees.json: 至少需要一棵行为树")
    for tree_id, tree in trees.items():
        if tree.get("actorId") not in actor_ids and tree.get("actorId") != "world.physics":
            raise CheckError(f"{tree_id}: 未知 actorId {tree.get('actorId')}")
        if not isinstance(tree.get("maxActionsPerWake"), int) or tree["maxActionsPerWake"] != 1:
            raise CheckError(f"{tree_id}: 首期必须每次唤醒最多执行一个动作")
        if tree_id == "bt.npc.bellkeeper.lan_zhi.island_life" and tree.get("scope") != "instance":
            raise CheckError(f"{tree_id}: 岚织行为树必须与岛屿事实使用 instance scope")
        node_ids: set[str] = set()

        def visit(node: Any, where: str) -> None:
            if not isinstance(node, dict):
                raise CheckError(f"{where}: 节点必须是对象")
            node_id = node.get("id")
            if not isinstance(node_id, str) or not node_id:
                raise CheckError(f"{where}: 节点缺稳定 id")
            if node_id in node_ids:
                raise CheckError(f"{tree_id}: 重复节点 id {node_id}")
            node_ids.add(node_id)
            node_type = node.get("type")
            if node_type == "condition":
                check_condition(node.get("condition"), fact_ids, where)
                if tree_id == "bt.npc.bellkeeper.lan_zhi.island_life":
                    referenced = []
                    def collect_fact_ids(condition: Any) -> None:
                        if isinstance(condition, dict):
                            if "fact" in condition:
                                referenced.append(condition["fact"])
                            for key in ("all", "any"):
                                for child in condition.get(key, []):
                                    collect_fact_ids(child)
                            if "not" in condition:
                                collect_fact_ids(condition["not"])
                    collect_fact_ids(node.get("condition"))
                    if any(fact_id.startswith("world.windbell.bridge.") for fact_id in referenced):
                        raise CheckError(f"{where}: 岚织不得以公共桥事实驱动岛上生活")
            elif node_type == "action":
                if node.get("actionId") not in action_ids:
                    raise CheckError(f"{where}: 未知 actionId {node.get('actionId')}")
            elif node_type in {"sequence", "selector"}:
                children = node.get("children")
                if not isinstance(children, list) or not children:
                    raise CheckError(f"{where}: {node_type} 需要非空 children")
                for index, child in enumerate(children):
                    visit(child, f"{where}.children[{index}]")
            elif node_type == "wait":
                if not isinstance(node.get("afterMs"), int) or node["afterMs"] <= 0:
                    raise CheckError(f"{where}: wait.afterMs 必须为正整数")
            else:
                raise CheckError(f"{where}: 未知节点类型 {node_type}")

        visit(tree.get("root"), f"{tree_id}.root")
        if tree.get("entry") and tree["entry"] not in node_ids:
            raise CheckError(f"{tree_id}: entry 不存在")
    return trees


def check_dialogue(doc: dict[str, Any], fact_ids: set[str], event_ids: set[str], action_ids: set[str], actor_ids: set[str]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    trees = unique_ids(doc.get("trees", []), "dialogue trees")
    all_nodes: dict[str, dict[str, Any]] = {}
    for tree_id, tree in trees.items():
        if tree.get("actorId") not in actor_ids:
            raise CheckError(f"{tree_id}: 未知 actorId {tree.get('actorId')}")
        nodes = unique_ids(tree.get("nodes", []), f"{tree_id}.nodes")
        all_nodes.update(nodes)
        entry = tree.get("entry")
        if entry not in nodes:
            raise CheckError(f"{tree_id}: entry {entry} 不存在")
        for node_id, node in nodes.items():
            node_type = node.get("type")
            if node_type not in {"branch", "line"}:
                raise CheckError(f"{tree_id}.{node_id}: 只允许 branch 或 line")
            if node_type == "branch":
                cases = node.get("cases")
                if not isinstance(cases, list) or not cases:
                    raise CheckError(f"{tree_id}.{node_id}: branch 缺 cases")
                for index, case in enumerate(cases):
                    check_condition(case.get("when"), fact_ids, f"{tree_id}.{node_id}.cases[{index}]")
                    if case.get("next") not in nodes:
                        raise CheckError(f"{tree_id}.{node_id}: 未知 next {case.get('next')}")
                if node.get("default") is not None and node["default"] not in nodes:
                    raise CheckError(f"{tree_id}.{node_id}: 未知 default {node['default']}")
            else:
                if not isinstance(node.get("text"), str) or not node["text"].strip():
                    raise CheckError(f"{tree_id}.{node_id}: line 缺中文 text")
                if not node.get("replayRule"):
                    raise CheckError(f"{tree_id}.{node_id}: line 缺 replayRule")
                for fact_id in node.get("sourceFacts", []):
                    if fact_id not in fact_ids:
                        raise CheckError(f"{tree_id}.{node_id}: 未知 sourceFact {fact_id}")
                source_event = node.get("sourceEvent")
                if source_event is not None and source_event not in event_ids:
                    raise CheckError(f"{tree_id}.{node_id}: 未知 sourceEvent {source_event}")
                for index, choice in enumerate(node.get("choices", [])):
                    where = f"{tree_id}.{node_id}.choices[{index}]"
                    if not choice.get("id") or not choice.get("label"):
                        raise CheckError(f"{where}: choice 缺 id 或 label")
                    if choice.get("next") not in nodes:
                        raise CheckError(f"{where}: 未知 next {choice.get('next')}")
                    if choice.get("onFailure") is not None and choice["onFailure"] not in nodes:
                        raise CheckError(f"{where}: 未知 onFailure {choice['onFailure']}")
                    action_id = choice.get("actionId")
                    if action_id is not None:
                        if action_id not in action_ids:
                            raise CheckError(f"{where}: 未知 actionId {action_id}")
                        if choice.get("sourceEvent") not in event_ids:
                            raise CheckError(f"{where}: action choice 必须声明 sourceEvent")
                    for fact_id in choice.get("sourceFacts", []):
                        if fact_id not in fact_ids:
                            raise CheckError(f"{where}: 未知 sourceFact {fact_id}")
    coverage = unique_ids(doc.get("coverage", []), "dialogue coverage")
    for coverage_id, item in coverage.items():
        if item.get("treeId") not in trees:
            raise CheckError(f"coverage.{coverage_id}: 未知 treeId")
        if item.get("nodeId") not in unique_ids(next(tree for tree in trees.values() if tree["id"] == item["treeId"]).get("nodes", []), "coverage nodes"):
            raise CheckError(f"coverage.{coverage_id}: 未知 nodeId")
    if not REQUIRED_DIALOGUE_NODES <= set(all_nodes):
        raise CheckError(f"dialogue: 缺少必需节点 {sorted(REQUIRED_DIALOGUE_NODES - set(all_nodes))}")
    return trees, all_nodes


def initial_state(facts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {fact_id: fact["initial"] for fact_id, fact in facts.items()}


def refresh_derived(state: dict[str, Any]) -> None:
    segments = sum(state[f"world.windbell.bridge.segment.0{index}.status"] == "installed" for index in (1, 2, 3))
    state["world.windbell.bridge.segments_installed"] = segments
    connected = segments == 3
    state["world.windbell.bridge.connected"] = connected
    state["world.windbell.bridge.route.condition"] = "open" if connected else "blocked_by_bridge"
    state["world.windbell.bridge.cart.mobility"] = "ready" if (
        state["world.windbell.bridge.cart.pose"] == "upright"
        and state["world.windbell.bridge.cart.cargo.secured"]
        and connected
    ) else "blocked"
    if state["world.windbell.bridge.shipment.state"] == "arrived":
        state["world.windbell.bridge.stage"] = "inhabited"
    elif connected:
        state["world.windbell.bridge.stage"] = "connected"
    elif segments:
        state["world.windbell.bridge.stage"] = "restoring"
    elif state["world.windbell.bridge.material.site.planks"] or state["world.windbell.bridge.material.site.rope"]:
        state["world.windbell.bridge.stage"] = "responding"
    else:
        state["world.windbell.bridge.stage"] = "dormant"
    state["world.windbell.bridge.life.state"] = "active" if state["world.windbell.bridge.shelter.status"] == "established" else "quiet"


def condition_matches(condition: dict[str, Any], state: dict[str, Any]) -> bool:
    if "fact" in condition:
        left = state[condition["fact"]]
        right = condition["value"]
        return {
            "eq": left == right,
            "neq": left != right,
            "gte": left >= right,
            "gt": left > right,
            "lte": left <= right,
            "lt": left < right,
        }[condition["op"]]
    if "all" in condition:
        return all(condition_matches(child, state) for child in condition["all"])
    if "any" in condition:
        return any(condition_matches(child, state) for child in condition["any"])
    return not condition_matches(condition["not"], state)


def apply_action(action_id: str, actions: dict[str, dict[str, Any]], effects: dict[str, dict[str, Any]], state: dict[str, Any]) -> None:
    action = actions[action_id]
    if not condition_matches(action["requires"], state):
        raise CheckError(f"demo: action 条件不满足 {action_id}")
    effect = effects[action["effectId"]]
    for change in effect.get("changes", []):
        fact_id = change["fact"]
        if change["op"] == "set":
            state[fact_id] = change["value"]
        elif change["op"] == "increment":
            state[fact_id] += change["value"]
        else:
            state[fact_id] -= change["value"]
    for memory in effect.get("memory", []):
        key = memory["key"]
        # 叙事 demo 只需表现首期布尔记忆的最小写入；生产端仍应把它和事实放在同一事务。
        if key not in state:
            raise CheckError(f"demo: 记忆 key 不在事实状态 {key}")
        if isinstance(state[key], bool):
            state[key] = True
        # 枚举型记忆（例如岚织记得玩家从哪条路来）已由 effect.changes 写入。
    refresh_derived(state)


def resolve_dialogue(tree: dict[str, Any], state: dict[str, Any]) -> str:
    nodes = {node["id"]: node for node in tree["nodes"]}
    node_id = tree["entry"]
    for _ in range(12):
        node = nodes[node_id]
        if node["type"] == "line":
            return node_id
        for case in node["cases"]:
            if condition_matches(case["when"], state):
                node_id = case["next"]
                break
        else:
            if node.get("default") is None:
                raise CheckError(f"demo: dialogue branch 无匹配 {node_id}")
            node_id = node["default"]
    raise CheckError(f"demo: dialogue branch 超过跳转预算 {tree['id']}")


def demo(facts: dict[str, dict[str, Any]], events: dict[str, dict[str, Any]], effects: dict[str, dict[str, Any]], actions: dict[str, dict[str, Any]], dialogue_trees: dict[str, dict[str, Any]]) -> None:
    state = initial_state(facts)
    refresh_derived(state)
    apply_action("action.windbell.cart.brace", actions, effects, state)
    if state["world.windbell.bridge.cart.pose"] != "upright" or not state["player.windbell.cart.contribution.brace"]:
        raise CheckError("demo: 扶车没有留下正确事实和个人贡献")
    if resolve_dialogue(dialogue_trees["dialogue.windbell.cart.first_encounter"], state) != "dlg.cart.upright_unsecured":
        raise CheckError("demo: 扶车后的分支不一致")
    state["session.windbell.cart.last_outcome"] = "replayed"
    if resolve_dialogue(dialogue_trees["dialogue.windbell.cart.first_encounter"], state) != "dlg.cart.replay":
        raise CheckError("demo: 扶车重放分支不一致")
    state["session.windbell.cart.last_outcome"] = "failed"
    failed_tree = dict(dialogue_trees["dialogue.windbell.cart.first_encounter"], entry="dlg.cart.brace.result")
    if resolve_dialogue(failed_tree, state) != "dlg.cart.action.failed":
        raise CheckError("demo: 扶车失败分支不一致")
    state["session.windbell.cart.last_outcome"] = "success"
    state["world.windbell.bridge.shipment.state"] = "arrived"
    refresh_derived(state)
    if resolve_dialogue(dialogue_trees["dialogue.windbell.cart.reunion"], state) != "dlg.reunion.brace":
        raise CheckError("demo: 扶车重逢分支不一致")

    no_help = initial_state(facts)
    refresh_derived(no_help)
    for action_id in ("action.windbell.cart.self_rescue.bandage", "action.windbell.cart.self_rescue.secure", "action.windbell.cart.self_rescue.brace"):
        apply_action(action_id, actions, effects, no_help)
    if resolve_dialogue(dialogue_trees["dialogue.windbell.cart.first_encounter"], no_help) != "dlg.cart.self_rescue.braced":
        raise CheckError("demo: NPC 自救分支不一致")
    for action_id in ("action.windbell.bridge.install.segment.01", "action.windbell.bridge.install.segment.02", "action.windbell.bridge.install.segment.03"):
        for _ in range(1):
            # demo 只注入 NPC 可用的公共库存，证明施工动作本身不依赖玩家记忆。
            no_help["world.windbell.bridge.material.site.planks"] += 2
            no_help["world.windbell.bridge.material.site.rope"] += 1
        apply_action(action_id, actions, effects, no_help)
    apply_action("action.windbell.cart.depart", actions, effects, no_help)
    apply_action("action.windbell.cart.arrive", actions, effects, no_help)
    if resolve_dialogue(dialogue_trees["dialogue.windbell.cart.reunion"], no_help) != "dlg.reunion.late":
        raise CheckError("demo: 未参与重逢不应被感谢")

    partial = initial_state(facts)
    refresh_derived(partial)
    apply_action("action.windbell.bridge.handoff.plank", actions, effects, partial)
    if partial["world.windbell.bridge.material.stock.planks"] != 5 or partial["world.windbell.bridge.material.site.planks"] != 1:
        raise CheckError("demo: 一块木板交接没有守恒")
    bridge_tree = dialogue_trees["dialogue.windbell.bridge.material_handoff"]
    bridge_tree_for_result = dict(bridge_tree, entry="dlg.bridge.handoff.result")
    if resolve_dialogue(bridge_tree_for_result, partial) != "dlg.bridge.handoff.partial":
        raise CheckError("demo: 部分材料交接分支不一致")
    partial["session.windbell.bridge.last_handoff"] = "replayed"
    if resolve_dialogue(bridge_tree, partial) != "dlg.bridge.replay":
        raise CheckError("demo: 材料交接重放分支不一致")

    apply_action("action.windbell.bridge.establish.shelter", actions, effects, no_help)
    if resolve_dialogue(dialogue_trees["dialogue.windbell.bridge.life_after_arrival"], no_help) != "dlg.life.active":
        raise CheckError("demo: 到货后的公共生活分支不一致")

    for path, action_ids, expected in (
        ("root_path", ("action.windbell.island.arrive.root",), "dlg.island.root_arrived"),
        ("bridge_path", ("action.windbell.island.cut.support", "action.windbell.island.land.bridge", "action.windbell.island.arrive.bridge"), "dlg.island.bridge_arrived"),
        ("fire_path", ("action.windbell.island.ignite.branch", "action.windbell.island.leafwing.deploy", "action.windbell.island.arrive.fire"), "dlg.island.fire_arrived"),
    ):
        island = initial_state(facts)
        refresh_derived(island)
        for action_id in action_ids:
            apply_action(action_id, actions, effects, island)
        tree_id = "dialogue.windbell.island.arrival_paths"
        if resolve_dialogue(dialogue_trees[tree_id], island) != expected:
            raise CheckError(f"demo: {path} 到达分支不一致")

    # 根道是岛屿实例自己的稳定入口；即使公共风铃桥仍未修好，也应能抵达并
    # 由岚织读取这次岛上目击。这个断言防止把 shared bridge.connected 偷接成岛屿前置。
    root_without_bridge = initial_state(facts)
    refresh_derived(root_without_bridge)
    if root_without_bridge["world.windbell.bridge.connected"] is not False:
        raise CheckError("demo: 根道前置测试必须从未修复的公共桥开始")
    if root_without_bridge["world.windbell.island.root_path.open"] is not True:
        raise CheckError("demo: 公共桥未修复时根道仍必须开放")
    apply_action("action.windbell.island.arrive.root", actions, effects, root_without_bridge)
    if resolve_dialogue(dialogue_trees["dialogue.windbell.island.arrival_paths"], root_without_bridge) != "dlg.island.root_arrived":
        raise CheckError("demo: 桥未修复时根道抵达未进入岚织对白")
    apply_action("action.windbell.island.visitor.observe", actions, effects, root_without_bridge)
    if root_without_bridge["world.windbell.island.observation.seat.status"] != "occupied":
        raise CheckError("demo: 岚织未能在岛屿实例观察真实到达来客")

    dragon = initial_state(facts)
    refresh_derived(dragon)
    for _ in range(2):
        apply_action("action.windbell.island.dragon.patrol_step", actions, effects, dragon)
    if dragon["world.windbell.island.sky.dragon.route_progress"] != 2:
        raise CheckError("demo: 巡风龙航线步进没有到达翼拍阈值")
    apply_action("action.windbell.island.dragon.wingbeat", actions, effects, dragon)
    if dragon["world.windbell.island.sky.dragon.state"] != "wingbeat" or dragon["world.windbell.island.sky.dragon.wingbeat_force"] != "light":
        raise CheckError("demo: 巡风龙翼拍状态不一致")
    apply_action("action.windbell.island.dragon.rest", actions, effects, dragon)
    apply_action("action.windbell.island.dragon.resume", actions, effects, dragon)
    if dragon["world.windbell.island.sky.dragon.state"] != "patrolling" or dragon["world.windbell.island.sky.dragon.route_progress"] != 0:
        raise CheckError("demo: 巡风龙停歇后没有恢复巡游")

    print("DEMO OK: 扶车成功/失败/重放与重逢、无人自救、部分交接/重放、到货生活、桥未修根道与岚织、放桥/借火、巡游/翼拍/停歇/再巡游通过")


def main() -> int:
    parser = argparse.ArgumentParser(description="检查风铃桥／风铃岛叙事数据")
    parser.add_argument("--demo", action="store_true", help="在检查后执行最小事实模拟")
    args = parser.parse_args()
    try:
        characters_doc = load_json("characters.json")
        facts_doc = load_json("facts.json")
        dialogue_doc = load_json("dialogue.json")
        behavior_doc = load_json("behavior_trees.json")
        facts, events, effects, actions = check_facts(facts_doc)
        characters = check_characters(characters_doc, set(facts))
        check_behavior_trees(behavior_doc, set(facts), set(actions), set(characters))
        dialogue_trees, all_nodes = check_dialogue(dialogue_doc, set(facts), set(events), set(actions), set(characters))
        print(f"OK: 4 个 JSON；{len(facts)} facts；{len(events)} events；{len(effects)} effects；{len(actions)} actions；{len(behavior_doc['trees'])} 行为树；{len(all_nodes)} 个对白节点")
        if args.demo:
            demo(facts, events, effects, actions, dialogue_trees)
        return 0
    except CheckError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
