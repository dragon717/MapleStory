#!/usr/bin/env python3
"""Small read-only integrity check for the generated TMS273 gameplay files."""

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TMS_ROOT = ROOT / "参考/273/TMS273少爷一键端/TMS273"
OUT = ROOT / "resources/tms273-export"
SUPPORTED_EQUIPMENT = {"1002067", "1040002", "1052095", "1302000"}
FORBIDDEN_SOURCE_TEXT = ("P0nk", "Cosmic", "v83", "GMS83", "83 dataless")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def fail(errors, message):
    errors.append(message)


def runtime_id(value):
    text = str(value).strip()
    return str(int(text)) if text.isdigit() else text


def active_life(life):
    return not (life.get("hide") or life.get("hidden") or life.get("visible") is False)


def walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            for text in walk_strings(child):
                yield text
    elif isinstance(value, list):
        for child in value:
            for text in walk_strings(child):
                yield text


def main():
    errors = []
    paths = {name: OUT / name for name in ("gameplay.json", "items.json", "quest-text.json", "npc-names.json")}
    if any(not path.is_file() for path in paths.values()):
        missing = [str(path) for path in paths.values() if not path.is_file()]
        print("missing generated files: %s" % ", ".join(missing), file=sys.stderr)
        return 2
    gameplay, items, quest_text, npc_names = [read(paths[name]) for name in paths]
    maps = read(ROOT / "references/tms273-data/maps.json")

    map_ids = {entry["id"] for entry in maps["maps"]}
    if not map_ids:
        fail(errors, "map reference contains no imported maps")
    if len(map_ids) != len(set(map_ids)):
        fail(errors, "map reference contains duplicate map ids")
    spawn_map_ids = {spawn.get("mapId") for spawn in gameplay.get("spawns", [])}
    npc_spawn_map_ids = {spawn.get("mapId") for spawn in gameplay.get("npcSpawns", [])}
    if not spawn_map_ids.issubset(map_ids) or not npc_spawn_map_ids.issubset(map_ids):
        fail(errors, "generated spawn references a map outside the imported TMS273 map set")

    expected_mob_ids = set()
    expected_mob_spawns = 0
    for map_entry in maps["maps"]:
        for life in map_entry.get("life", []):
            if life.get("type") == "m" and active_life(life):
                expected_mob_ids.add(runtime_id(life.get("id")))
                expected_mob_spawns += 1
    mob_ids = {template.get("templateId") for template in gameplay.get("monsters", [])}
    if mob_ids != expected_mob_ids:
        fail(errors, "monster template ids differ from visible TMS273 map life: %r" % sorted(mob_ids))
    if len(gameplay.get("spawns", [])) != expected_mob_spawns:
        fail(errors, "monster spawn count differs from visible TMS273 map life: expected %d, got %d" % (expected_mob_spawns, len(gameplay.get("spawns", []))))
    if any("pdDamage" in template or "PDDamage" in template for template in gameplay.get("monsters", [])):
        fail(errors, "273 percentage PDRate was incorrectly emitted as absolute pdDamage")
    for template in gameplay.get("monsters", []):
        if not isinstance(template.get("pdRate"), (int, float)) or template["pdRate"] < 0:
            fail(errors, "monster %s has no valid pdRate" % template.get("templateId"))
        for drop in template.get("drop", []):
            if drop.get("itemId") not in items:
                fail(errors, "drop item %s is missing from generated item catalog" % drop.get("itemId"))
            if not 0 <= drop.get("chance", -1) <= 1_000_000:
                fail(errors, "drop chance is outside the TMS273 million denominator")

    # Hidden life is never activated.  The map source itself is the authority;
    # Npc.info.hide is checked too because it can hide an otherwise visible row.
    npc_info_hidden = set()
    for map_entry in maps["maps"]:
        for life in map_entry.get("life", []):
            if life.get("type") != "n":
                continue
            npc_path = TMS_ROOT / "WZ_JSON_TW" / "Npc" / (str(life["id"]) + ".json")
            if npc_path.is_file():
                info = read(npc_path).get("info", {})
                hidden = info.get("hide", {}) if isinstance(info, dict) else {}
                if isinstance(hidden, dict):
                    hidden = hidden.get("_value", 0)
                if str(hidden) not in ("", "0", "False", "false"):
                    npc_info_hidden.add(str(int(str(life["id"]))))
            explicitly_hidden = not active_life(life)
            runtime = runtime_id(life["id"])
            active_spawn = any(spawn.get("templateId") == runtime for spawn in gameplay.get("npcSpawns", []))
            if explicitly_hidden and active_spawn:
                fail(errors, "explicitly hidden NPC %s was activated" % runtime)
    if npc_info_hidden.intersection({spawn.get("templateId") for spawn in gameplay.get("npcSpawns", [])}):
        fail(errors, "Npc.info.hide template was activated")
    if any(spawn.get("templateId") in {"1541000", "1541001", "1541067"} for spawn in gameplay.get("npcSpawns", [])):
        fail(errors, "hidden tutorial NPC was activated")
    hidden_conditions = gameplay.get("sources", {}).get("hiddenNpcConditions", {})
    for runtime in ("1541000", "1541001"):
        if runtime in npc_info_hidden:
            record = hidden_conditions.get(runtime, {})
            condition_keys = set(record.get("conditions", {})) if isinstance(record, dict) else set()
            if not {"condition2", "condition3"}.issubset(condition_keys):
                fail(errors, "hidden NPC %s lost TMS273 condition2/condition3 metadata" % runtime)

    active_npc_ids = {spawn.get("templateId") for spawn in gameplay.get("npcSpawns", [])}
    template_npc_ids = {template.get("templateId") for template in gameplay.get("npcs", [])}
    if active_npc_ids != template_npc_ids:
        fail(errors, "NPC spawn/template references are not closed")
    if set(npc_names.get("npcs", {})) != template_npc_ids:
        fail(errors, "npc-names.json does not match active NPC templates")
    if any(not template.get("name") for template in gameplay.get("npcs", [])):
        fail(errors, "active NPC has no TMS273 source name")

    # NPCs stand on the authored cy (the map editor's life.y is the sprite's
    # upper position).  Keep sourceY available for provenance and audit it
    # against each source life row.
    life_by_source = {
        (map_entry["id"], life.get("source")): life
        for map_entry in maps["maps"]
        for life in map_entry.get("life", [])
        if life.get("type") == "n" and active_life(life)
    }
    for spawn in gameplay.get("npcSpawns", []):
        source_life = life_by_source.get((spawn.get("mapId"), spawn.get("source")))
        if source_life is None:
            fail(errors, "NPC spawn source does not match an imported TMS273 life row: %s" % spawn.get("id"))
            continue
        expected_source_y = source_life.get("y")
        expected_y = source_life.get("cy", expected_source_y)
        if spawn.get("sourceY") != expected_source_y or spawn.get("y") != expected_y:
            fail(errors, "NPC %s did not use life.cy while retaining sourceY" % spawn.get("id"))

    if not SUPPORTED_EQUIPMENT.issubset(items):
        fail(errors, "one of the four supported equipment ids is absent")
    for item_id, item in items.items():
        if item.get("inventoryType") not in (1, 2, 3, 4, 5):
            fail(errors, "item %s has invalid inventoryType" % item_id)
        if not isinstance(item.get("slotMax"), int) or item["slotMax"] <= 0:
            fail(errors, "item %s has invalid slotMax" % item_id)
        if not item.get("spriteSource"):
            fail(errors, "item %s has no spriteSource" % item_id)
        source = item.get("source")
        if source:
            source_path = TMS_ROOT / "WZ_JSON_TW" / source
            if not source_path.is_file():
                fail(errors, "item %s source does not exist: %s" % (item_id, source))
    for item_id in SUPPORTED_EQUIPMENT:
        if not str(items[item_id].get("source", "")).startswith("Character/"):
            fail(errors, "equipment %s is not sourced from TMS273 Character JSON" % item_id)

    reference_quest_ids = {str(int(entry["id"])) for entry in read(ROOT / "references/tms273-data/quests.json")["quests"]}
    if set(quest_text.get("quests", {})) != reference_quest_ids:
        fail(errors, "quest-text ids differ from references/tms273-data/quests.json")
    if len(gameplay.get("quests", [])) != len(reference_quest_ids):
        fail(errors, "gameplay quest metadata count differs from TMS273 quest references")
    if quest_text.get("locales") != ["zh"]:
        fail(errors, "quest-text unexpectedly claims an unverified locale")

    all_text = list(walk_strings(gameplay)) + list(walk_strings(items)) + list(walk_strings(quest_text)) + list(walk_strings(npc_names))
    for forbidden in FORBIDDEN_SOURCE_TEXT:
        if any(forbidden in text for text in all_text):
            fail(errors, "generated output contains forbidden legacy source marker %r" % forbidden)

    sources = gameplay.get("sources", {})
    if sources.get("edition") != "TMS273" or not sources.get("drops", {}).get("source", "").startswith("data/MobReward/"):
        fail(errors, "gameplay provenance does not identify TMS273 inputs")
    if any(spawn.get("templateId") not in mob_ids for spawn in gameplay.get("spawns", [])):
        fail(errors, "monster spawn references unknown generated template")
    for shop in gameplay.get("shops", []):
        seen = set()
        for item in shop.get("items", []):
            if item.get("itemId") in seen:
                fail(errors, "duplicate item in generated shop %s" % shop.get("shopId"))
            seen.add(item.get("itemId"))
            if item.get("price", 0) <= 0:
                fail(errors, "nonpositive price in generated shop %s" % shop.get("shopId"))
        owner = next((template for template in gameplay.get("npcs", []) if template.get("templateId") == shop.get("npcId")), None)
        script = owner.get("script") if owner else None
        direct_shop = script and script.get("start") == "shop" and script.get("nodes", {}).get("shop", {}).get("act", {}).get("kind") == "shop" and script.get("nodes", {}).get("shop", {}).get("act", {}).get("shopId") == shop.get("shopId")
        if not direct_shop:
            fail(errors, "shop %s has no direct Act shop dialogue route" % shop.get("shopId"))

    if errors:
        for error in errors:
            print("FAIL: %s" % error, file=sys.stderr)
        return 1
    print(
        "TMS273 gameplay check passed: %d monsters/%d spawns, %d NPCs/%d spawns, %d shops, %d items, %d quest texts"
        % (
            len(gameplay.get("monsters", [])),
            len(gameplay.get("spawns", [])),
            len(gameplay.get("npcs", [])),
            len(gameplay.get("npcSpawns", [])),
            len(gameplay.get("shops", [])),
            len(items),
            len(quest_text.get("quests", {})),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
