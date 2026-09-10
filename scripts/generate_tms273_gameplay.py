#!/usr/bin/env python3
"""Convert the imported TMS273 starter maps into the server gameplay shape.

The converter deliberately reads only the TMS273 JSON export and the checked-in
TMS273 map/quest references.  It does not use the v83 catalogs or generators.
The four selected monster templates keep the source seven-digit Mob id in
``sources`` while the runtime ids in gameplay/items are normalized with
``str(int(id))``.

By default the entity export is required.  ``--metadata-only`` is an explicit
escape hatch for producing a data review while entity graphics are unavailable;
that mode never claims that the missing graphics are active.
"""

import argparse
from decimal import Decimal, InvalidOperation
import json
import math
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TMS_ROOT = ROOT / "参考/273/TMS273少爷一键端/TMS273"
DEFAULT_MAPS = ROOT / "references/tms273-data/maps.json"
DEFAULT_ENTITIES = ROOT / "resources/tms273-export/entities.json"
DEFAULT_OUTPUT = ROOT / "resources/tms273-export"
SUPPORTED_EQUIPMENT = ("1002067", "1040002", "1052095", "1302000")
DROP_DENOMINATOR = 1_000_000


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )


def runtime_id(value):
    """Return the id used by the current runtime, preserving non-numeric ids."""
    if isinstance(value, bool):
        return str(int(value))
    text = str(value).strip()
    if text.isdigit():
        return str(int(text))
    return text


def number(value, default=None, integer=False):
    if value is None or isinstance(value, bool):
        return default
    # WZ_JSON_TW stores even ordinary WZ integers as decimal strings.  Keep
    # those exact instead of routing large ids/counters through float.
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            return default
        return int(value) if integer else (int(value) if value.is_integer() else value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return default
        try:
            return int(text, 10)
        except ValueError:
            try:
                parsed = Decimal(text)
            except (InvalidOperation, ValueError):
                return default
            if not parsed.is_finite():
                return default
            if integer:
                return int(parsed)
            if parsed == parsed.to_integral_value():
                return int(parsed)
            try:
                result = float(parsed)
            except (OverflowError, ValueError):
                return default
            return result if math.isfinite(result) else default
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(parsed):
        return default
    return int(parsed) if integer else (int(parsed) if parsed.is_integer() else parsed)


def boolish(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "none")
    return bool(value)


def unwrap(value):
    """Unbox WZ_JSON_TW typed nodes without changing UTF-8 strings."""
    if isinstance(value, list):
        return [unwrap(item) for item in value]
    if not isinstance(value, dict):
        return value
    kind = value.get("_dirType")
    if kind == "vector" or ("_x" in value and "_y" in value):
        return {
            "x": number(value.get("_x"), 0),
            "y": number(value.get("_y"), 0),
        }
    if "_value" in value:
        raw = value.get("_value")
        if kind in ("int", "short", "long", "uint", "ushort", "ulong"):
            parsed = number(raw)
            return int(parsed) if parsed is not None else raw
        if kind in ("float", "double"):
            return number(raw)
        return raw
    return {key: unwrap(item) for key, item in value.items() if key != "_dirType"}


def records(value):
    """Turn a WZ sub node or a normalized list into ordered record values."""
    value = unwrap(value)
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        numeric = [key for key in value if str(key).isdigit()]
        if numeric:
            return [value[key] for key in sorted(numeric, key=lambda key: int(key))]
    return []


def find_records(value, wanted, found=None):
    """Collect named records from String.wz's nested category trees."""
    if found is None:
        found = {}
    if isinstance(value, dict):
        for key, child in value.items():
            if key in wanted and isinstance(child, dict):
                found[key] = unwrap(child)
            find_records(child, wanted, found)
    elif isinstance(value, list):
        for child in value:
            find_records(child, wanted, found)
    return found


def active_source_life(entry):
    """Visibility must come from explicit map source flags only."""
    if boolish(entry.get("hide")) or boolish(entry.get("hidden")):
        return False
    if "visible" in entry and entry.get("visible") is False:
        return False
    return True


def path_text(path, root):
    return "/".join(path.relative_to(root).parts)


def source_node(path, root):
    """Map a JSON export path to the WZ node path used by the icon exporter."""
    rel = path.relative_to(root).with_suffix("")
    parts = list(rel.parts)
    if parts and parts[0] == "Item" and len(parts) >= 4:
        # Item/Consume/0204/02041006.json corresponds to
        # Item/Consume/0204.img/02041006/info/icon in the WZ tree.
        return "/".join(parts[:2] + [parts[2] + ".img", parts[3], "info", "icon"])
    if parts and parts[0] == "Character" and len(parts) >= 3:
        return "/".join(parts[:2] + [parts[2] + ".img", "info", "icon"])
    return "/".join(parts + ["info", "icon"])


def fallback_sprite_source(item_id):
    padded = item_id.zfill(8)
    group = int(item_id) // 1_000_000 if item_id.isdigit() else 0
    if group == 1:
        # The exact equipment category is supplied by String/Eqp when present;
        # the generic Character path remains an explicit source hint otherwise.
        return "Character/*/%s.img/info/icon" % padded
    category = {2: "Consume", 3: "Install", 4: "Etc", 5: "Cash"}.get(group)
    if category:
        return "Item/%s/%s.img/%s/info/icon" % (category, padded[:4], padded)
    return None


def action_frames(entity, action):
    if not isinstance(entity, dict):
        return []
    actions = entity.get("actions", {})
    value = actions.get(action, []) if isinstance(actions, dict) else []
    return value if isinstance(value, list) else records(value)


def frame_rect(frame):
    if not isinstance(frame, dict):
        return None
    lt, rb = frame.get("lt"), frame.get("rb")
    if isinstance(lt, dict) and isinstance(rb, dict):
        x0, y0 = number(lt.get("x")), number(lt.get("y"))
        x1, y1 = number(rb.get("x")), number(rb.get("y"))
        if None not in (x0, y0, x1, y1) and x0 < x1 and y0 < y1:
            return {"lt": {"x": x0, "y": y0}, "rb": {"x": x1, "y": y1}}
    # The entity exporter retains the frame rectangle as x/y + width/height
    # when WZ has no explicit body lt/rb node.  This is source geometry, not a
    # guessed combat constant.
    x, y = number(frame.get("x")), number(frame.get("y"))
    width, height = number(frame.get("width")), number(frame.get("height"))
    if None not in (x, y, width, height) and width > 0 and height > 0:
        return {"lt": {"x": x, "y": y}, "rb": {"x": x + width, "y": y + height}}
    return None


def action_duration(frames):
    delays = []
    for frame in frames:
        delay = number(frame.get("delay")) if isinstance(frame, dict) else None
        if delay is None or delay <= 0:
            return None
        delays.append(delay)
    return int(sum(delays)) if delays else None


def load_string_records(wz_root, wanted):
    result = {}
    for name in ("Mob", "Consume", "Etc", "Ins", "Eqp"):
        path = wz_root / "String" / (name + ".json")
        if path.exists():
            result.update(find_records(read_json(path), wanted))
    return result


def load_npc_string_records(wz_root, wanted):
    """Load NPC display names from String/Npc.json only.

    NPC ids (2000..29999, 100xxxx) collide with Eqp/Face/Skin ids from
    String/Eqp.json (e.g. Face 22000 vs NPC 22000), so NPC names must never be
    looked up from the cross-category merged ``string_records`` table: the Eqp
    category would overwrite the correct NPC name with a face/equipment name.
    """
    path = wz_root / "String" / "Npc.json"
    if path.exists():
        return find_records(read_json(path), wanted)
    return {}


def build_source_index(base):
    index = {}
    if not base.exists():
        return index
    for path in base.rglob("*.json"):
        if path.stem.isdigit():
            index.setdefault(path.stem, []).append(path)
    for key in index:
        index[key].sort(key=lambda path: str(path))
    return index


def relative_to_root(path, root):
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path)


def item_source(item_id, item_index, character_index):
    padded = item_id.zfill(8)
    group = int(item_id) // 1_000_000 if item_id.isdigit() else 0
    candidates = character_index.get(padded, []) if group == 1 else item_index.get(padded, [])
    if not candidates:
        candidates = item_index.get(padded, []) + character_index.get(padded, [])
    return candidates[0] if candidates else None


def item_definition(item_id, source, string_records, wz_root):
    record = string_records.get(item_id, {})
    if not isinstance(record, dict):
        record = {}
    source_info = {}
    source_spec = {}
    if source is not None:
        raw = read_json(source)
        source_info = unwrap(raw.get("info", {}))
        source_spec = unwrap(raw.get("spec", {}))
        if not isinstance(source_info, dict):
            source_info = {}
        if not isinstance(source_spec, dict):
            source_spec = {}
    inventory_type = int(item_id) // 1_000_000 if item_id.isdigit() else 0
    slot_max = number(source_info.get("slotMax"), integer=True)
    defaults = []
    if slot_max is None or slot_max <= 0:
        slot_max = 1 if inventory_type == 1 else 100
        defaults.append("slotMax")
    name = record.get("name")
    description = record.get("desc", "")
    if name is not None and not isinstance(name, str):
        name = str(name)
    if not isinstance(description, str):
        description = str(description) if description is not None else ""
    entry = {
        "inventoryType": inventory_type,
        "slotMax": slot_max,
        "info": source_info,
        "spec": source_spec,
        "source": path_text(source, wz_root) if source else None,
        "sourceItemId": item_id.zfill(8),
        "spriteSource": source_node(source, wz_root) if source else fallback_sprite_source(item_id),
        "spriteSourceStatus": "json-present" if source else "json-missing",
    }
    if name:
        entry["name"] = name
    if description:
        entry["description"] = description
    if defaults:
        entry["defaultsApplied"] = defaults
    return entry


def map_life(maps):
    all_life = []
    for map_entry in maps:
        for entry in records(map_entry.get("life", [])):
            if not isinstance(entry, dict):
                continue
            all_life.append((map_entry, entry))
    return all_life


def build_quest_text(quest_doc):
    quests = {}
    for quest in quest_doc.get("quests", []):
        quest_id = runtime_id(quest.get("id", quest.get("questId", "")))
        if not quest_id:
            continue
        display = quest.get("display", {})
        strings = display.get("strings", {}) if isinstance(display, dict) else {}
        name = quest.get("name") or (display.get("name") if isinstance(display, dict) else None)
        log = ""
        if isinstance(strings, dict):
            for key in ("QuestInfo/0", "QuestInfo/1", "QuestInfo/2"):
                if isinstance(strings.get(key), str) and strings[key].strip():
                    log = strings[key]
                    break
        entry = {"name": {"zh": name or quest_id}}
        if log:
            entry["log"] = {"zh": log}
        quests[quest_id] = entry
    return {
        "schemaVersion": 1,
        "generatedFrom": "TMS273 WZ_JSON_TW Quest references/tms273-data/quests.json",
        "encoding": "UTF-8",
        "locales": ["zh"],
        "limitations": [
            "TMS273 source contains Traditional Chinese text only; no English translation is invented.",
            "QuestData Check/Act/Say are retained in the reference file but are not executable server scripts.",
        ],
        "quests": quests,
    }


def quest_specs(quest_doc):
    specs = []
    for quest in quest_doc.get("quests", []):
        quest_id = runtime_id(quest.get("id", quest.get("questId", "")))
        if not quest_id:
            continue
        display = quest.get("display", {})
        strings = display.get("strings", {}) if isinstance(display, dict) else {}
        name = quest.get("name") or (display.get("name") if isinstance(display, dict) else "")
        summary = ""
        for key in ("QuestInfo/0", "QuestInfo/1", "QuestInfo/2"):
            if isinstance(strings, dict) and strings.get(key):
                summary = strings[key]
                break
        # Empty start/complete maps are intentional: references/tms273-data
        # marks every imported QuestData row executable=false.
        specs.append({
            "questId": quest_id,
            "name": name or quest_id,
            "summary": summary,
            "start": {},
            "complete": {},
            "reward": {"mesos": 0, "exp": 0, "items": []},
            "source": quest.get("sourceJson"),
            "executable": False,
        })
    return specs


def convert(args):
    tms_root = args.tms_root.resolve()
    wz_root = tms_root / "WZ_JSON_TW"
    maps_doc = read_json(args.maps_json)
    maps = maps_doc.get("maps", [])
    map_ids = [str(map_entry.get("id", "")) for map_entry in maps]
    if not maps or any(not map_id for map_id in map_ids):
        raise ValueError("references/tms273-data/maps.json must provide nonempty map entries")
    if len(set(map_ids)) != len(map_ids):
        raise ValueError("references/tms273-data/maps.json contains duplicate map ids")
    for map_entry in maps:
        source_json = map_entry.get("sourceJson")
        if not source_json or not (wz_root / source_json).exists():
            raise FileNotFoundError("missing TMS273 map JSON: %s" % source_json)

    entities = None
    if args.entities.exists():
        entities = read_json(args.entities)
    elif not args.metadata_only:
        raise FileNotFoundError(
            "missing %s; entity graphics are required unless --metadata-only is supplied" % args.entities
        )
    if entities is None:
        entities = {"npcs": {}, "monsters": {}}
    entity_mobs = entities.get("monsters", {}) if isinstance(entities, dict) else {}
    entity_npcs = entities.get("npcs", {}) if isinstance(entities, dict) else {}

    life = map_life(maps)
    visible_life = [(m, e) for m, e in life if active_source_life(e)]
    visible_mobs = [(m, e) for m, e in visible_life if e.get("type") == "m"]
    visible_npcs = [(m, e) for m, e in visible_life if e.get("type") == "n"]
    # P practice-only Boss template: never add it to authored Map.life.
    practice_boss = "3220000"
    raw_mob_ids = sorted({str(e.get("id", "")) for _, e in visible_mobs} | {practice_boss})
    raw_npc_ids = sorted({str(e.get("id", "")) for _, e in visible_npcs})
    if not all(raw_mob_ids) or not all(raw_npc_ids):
        raise ValueError("visible TMS273 life entry is missing id")

    issues = []
    hidden_records = []
    for map_entry, entry in life:
        if active_source_life(entry):
            continue
        hidden_records.append({
            "mapId": map_entry["id"],
            "path": entry.get("path"),
            "type": entry.get("type"),
            "sourceId": entry.get("id"),
            "reason": "explicit map hide/hidden/visible=false",
        })

    # Npc.info.hide is a source visibility flag even when a map life row omits
    # hide.  Such NPCs stay in the audit record but never become spawns.
    npc_source_info = {}
    hidden_npc_conditions = {}
    for raw_id in sorted({str(e.get("id", "")) for _, e in life if e.get("type") == "n"}):
        path = wz_root / "Npc" / (raw_id + ".json")
        if not path.exists():
            issues.append("missing NPC source JSON: Npc/%s.json" % raw_id)
            continue
        npc_source = read_json(path)
        info = unwrap(npc_source.get("info", {}))
        info = info if isinstance(info, dict) else {}
        npc_source_info[raw_id] = info
        if boolish(info.get("hide")):
            conditions = {
                key: unwrap(value)
                for key, value in npc_source.items()
                if str(key).startswith("condition")
            }
            hidden_npc_conditions[runtime_id(raw_id)] = {
                "source": path_text(path, tms_root),
                "infoHide": info.get("hide"),
                "conditions": conditions,
            }
            hidden_records.append({
                "sourceId": raw_id,
                "type": "n",
                "reason": "Npc.info.hide is explicitly nonzero",
                "conditionKeys": sorted(conditions),
            })

    active_npcs = []
    for map_entry, entry in visible_npcs:
        raw_id = str(entry["id"])
        if boolish(npc_source_info.get(raw_id, {}).get("hide")):
            continue
        entity = entity_npcs.get(runtime_id(raw_id), {})
        if boolish(entity.get("hidden")):
            hidden_records.append({
                "sourceId": raw_id,
                "type": "n",
                "reason": "entities.json marks template hidden",
            })
            continue
        active_npcs.append((map_entry, entry))

    if not args.metadata_only:
        missing_mob_entities = sorted(set(runtime_id(i) for i in raw_mob_ids) - set(entity_mobs))
        missing_npc_entities = sorted(
            set(runtime_id(e.get("id")) for _, e in active_npcs) - set(entity_npcs)
        )
        if missing_mob_entities or missing_npc_entities:
            raise ValueError(
                "entities.json is missing active templates: monsters=%s npcs=%s"
                % (missing_mob_entities, missing_npc_entities)
            )

    mob_rewards_root = tms_root / "data" / "MobReward"
    item_ids = set(SUPPORTED_EQUIPMENT)
    monster_templates = []
    deferred_quest_drops = []
    source_monsters = {}
    for raw_id in raw_mob_ids:
        runtime = runtime_id(raw_id)
        mob_path = wz_root / "Mob" / (raw_id + ".json")
        if not mob_path.exists():
            raise FileNotFoundError("missing TMS273 monster source JSON: %s" % mob_path)
        info = unwrap(read_json(mob_path).get("info", {}))
        info = info if isinstance(info, dict) else {}
        level = number(info.get("level"), integer=True)
        max_hp = number(info.get("maxHP"), integer=True)
        exp = number(info.get("exp"), integer=True)
        if level is None or level <= 0 or max_hp is None or max_hp <= 0 or exp is None or exp < 0:
            raise ValueError("incomplete TMS273 monster stats in %s" % mob_path)
        template = {
            "templateId": runtime,
            "level": level,
            "maxHp": max_hp,
            "exp": exp,
            "bodyAttack": boolish(info.get("bodyAttack")),
            "source": path_text(mob_path, tms_root),
        }
        for source_key, output_key, integer in (
            ("PADamage", "paDamage", True),
            ("PDRate", "pdRate", False),
            ("speed", "speed", False),
        ):
            value = number(info.get(source_key), integer=integer)
            if value is not None:
                template[output_key] = value
        entity = entity_mobs.get(runtime, {}) if not args.metadata_only else {}
        stand = action_frames(entity, "stand")
        rectangle = frame_rect(stand[0]) if stand else None
        if rectangle:
            template["hitboxLt"] = rectangle["lt"]
            template["hitboxRb"] = rectangle["rb"]
        for action, output_key in (("die", "dieDurationMs"), ("stand", "standDelayMs"), ("move", "moveDurationMs")):
            duration = action_duration(action_frames(entity, action))
            if duration:
                template[output_key] = duration

        reward_path = mob_rewards_root / (runtime + ".json")
        drops = []
        # The private practice encounter has no loot eligibility; do not import custom Boss rewards.
        reward_rows = read_json(reward_path) if reward_path.exists() and runtime != practice_boss else []
        if not reward_path.exists():
            issues.append("missing TMS273 MobReward/%s.json" % runtime)
        for row in reward_rows:
            item_id = runtime_id(row.get("itemId"))
            minimum = number(row.get("minNum"), integer=True)
            maximum = number(row.get("maxNum"), integer=True)
            chance = number(row.get("chance"), integer=True)
            if not item_id or minimum is None or minimum <= 0 or maximum is None or maximum < minimum:
                issues.append("invalid MobReward row for %s: %r" % (runtime, row))
                continue
            if chance is None or chance < 0 or chance > DROP_DENOMINATOR:
                issues.append("invalid MobReward chance for %s: %r" % (runtime, row))
                continue
            item_ids.add(item_id)
            quest_id = runtime_id(row.get("questId", 0))
            drop = {"itemId": item_id, "quantity": minimum, "chance": chance}
            if maximum != minimum:
                drop["quantityMax"] = maximum
            if quest_id != "0":
                deferred_quest_drops.append({
                    "templateId": runtime,
                    "itemId": item_id,
                    "minimum": minimum,
                    "maximum": maximum if maximum != minimum else None,
                    "questId": quest_id,
                    "chance": chance,
                })
            else:
                drops.append(drop)
        if drops:
            template["drop"] = drops
        monster_templates.append(template)
        source_monsters[runtime] = {
            "sourceTemplateId": raw_id,
            "statsSource": path_text(mob_path, tms_root),
            "entitySource": entity_mobs.get(runtime, {}).get("source") if entity_mobs else None,
            "PDRate": info.get("PDRate"),
            "MDRate": info.get("MDRate"),
            "dropSource": path_text(reward_path, tms_root) if reward_path.exists() else None,
        }

    monster_spawns = []
    for map_entry, entry in visible_mobs:
        raw_id = str(entry["id"])
        spawn_id = "%s-life-%s" % (map_entry["id"], str(entry.get("path", "")).split("/")[-1])
        spawn = {
            "id": spawn_id,
            "mapId": map_entry["id"],
            "templateId": runtime_id(raw_id),
            "x": number(entry.get("x"), 0),
            "y": number(entry.get("y"), 0),
            "facing": -1 if number(entry.get("f"), 1, integer=True) == 0 else 1,
            "mobTime": number(entry.get("mobTime"), 0, integer=True),
            "source": entry.get("source"),
        }
        foothold = number(entry.get("fh"), integer=True)
        if foothold is not None and foothold >= 0:
            spawn["footholdId"] = foothold
        for key in ("rx0", "rx1"):
            if entry.get(key) is not None:
                spawn[key] = number(entry.get(key))
        monster_spawns.append(spawn)

    wanted_npcs = set(runtime_id(str(e["id"])) for _, e in active_npcs)
    wanted_npcs.update(runtime_id(str(e["id"])) for _, e in visible_npcs)
    string_records = load_string_records(wz_root, set(runtime_id(i) for i in raw_mob_ids) | wanted_npcs | item_ids)
    npc_string_records = load_npc_string_records(wz_root, wanted_npcs)
    npc_templates = []
    npc_spawns = []
    shops = []
    shop_item_ids = set()
    shops_root = tms_root / "data" / "Shop"
    for runtime in sorted(set(runtime_id(str(e["id"])) for _, e in active_npcs), key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value)):
        record = npc_string_records.get(runtime, {})
        entity = entity_npcs.get(runtime, {}) if not args.metadata_only else {}
        name = record.get("name") if isinstance(record, dict) else None
        if not name:
            name = entity.get("name") if isinstance(entity, dict) else None
        if not name:
            raise ValueError("missing TMS273 NPC name for runtime id %s" % runtime)
        shop_path = shops_root / (runtime + ".json")
        shop_id = runtime if shop_path.exists() else None
        npc = {
            "templateId": runtime,
            "name": name,
            "func": record.get("func", "") if isinstance(record, dict) else "",
            "shopId": shop_id,
            "stand": entity.get("stand", []) if isinstance(entity, dict) else [],
            "source": "Npc/%s.img + String/Npc.json" % str(runtime).zfill(7),
        }
        if shop_id is not None:
            # The current runtime opens a shop through its normal NPC dialogue
            # resolver.  TMS273 supplies the shop rows but no executable Say
            # script, so the minimal authored route is one direct Act node.
            npc["script"] = {
                "start": "shop",
                "nodes": {"shop": {"act": {"kind": "shop", "shopId": shop_id}}},
            }
        npc_templates.append(npc)
        if shop_path.exists():
            shop_data = read_json(shop_path)
            shop_entries = []
            seen_shop_items = set()
            for index, row in enumerate(shop_data.get("items", [])):
                if boolish(row.get("hide")):
                    continue
                item_id = runtime_id(row.get("itemId"))
                price = number(row.get("price"), integer=True)
                if not item_id or price is None or price <= 0:
                    issues.append("invalid visible shop row in %s" % path_text(shop_path, tms_root))
                    continue
                if item_id in seen_shop_items:
                    issues.append("duplicate shop item %s in %s; first source row retained" % (item_id, runtime))
                    continue
                seen_shop_items.add(item_id)
                shop_item_ids.add(item_id)
                item_ids.add(item_id)
                shop_entries.append({"itemId": item_id, "price": price, "position": index})
            if shop_entries:
                shops.append({
                    "shopId": shop_id,
                    "npcId": runtime,
                    "items": shop_entries,
                    "source": path_text(shop_path, tms_root),
                    "shopVerNo": shop_data.get("shopVerNo"),
                })

    # Shop rows are discovered after the first NPC/mob string pass; load their
    # names now so every catalog entry remains sourced from TMS273 String.wz.
    string_records.update(load_string_records(wz_root, item_ids))

    for map_entry, entry in active_npcs:
        runtime = runtime_id(str(entry["id"]))
        path_tail = str(entry.get("path", "")).split("/")[-1]
        source_y = number(entry.get("y"), 0)
        npc_y = number(entry.get("cy"), source_y)
        spawn = {
            "id": "%s-life-%s" % (map_entry["id"], path_tail),
            "mapId": map_entry["id"],
            "templateId": runtime,
            "x": number(entry.get("x"), 0),
            "y": npc_y,
            "sourceY": source_y,
            "facing": -1 if number(entry.get("f"), 1, integer=True) == 0 else 1,
            "source": entry.get("source"),
        }
        foothold = number(entry.get("fh"), integer=True)
        if foothold is not None and foothold >= 0:
            spawn["footholdId"] = foothold
        npc_spawns.append(spawn)

    item_index = build_source_index(wz_root / "Item")
    character_index = build_source_index(wz_root / "Character")
    items = {}
    item_sources = {}
    for item_id in sorted(item_ids, key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value)):
        if item_id == "0":
            continue
        source = item_source(item_id, item_index, character_index)
        definition = item_definition(item_id, source, string_records, wz_root)
        if source is not None:
            items[item_id] = definition
        item_sources[item_id] = {
            "source": definition.get("source"),
            "spriteSource": definition.get("spriteSource"),
            "status": definition.get("spriteSourceStatus"),
        }
        if source is None:
            issues.append("missing TMS273 item stats JSON for item %s" % item_id)
        if not definition.get("name"):
            issues.append("missing TMS273 item name for item %s" % item_id)

    # Server-pack reward rows can reference removed client items. Preserve the
    # source record above, but never grant a fabricated default-stat item.
    for monster in monster_templates:
        if "drop" in monster:
            monster["drop"] = [drop for drop in monster["drop"] if drop["itemId"] == "0" or drop["itemId"] in items]
    for shop in shops:
        shop["items"] = [item for item in shop["items"] if item["itemId"] in items]

    quest_doc_path = ROOT / "references/tms273-data/quests.json"
    quest_doc = read_json(quest_doc_path)
    quest_text = build_quest_text(quest_doc)
    quests = quest_specs(quest_doc)

    if args.metadata_only:
        issues.insert(0, "metadata-only: entities.json graphics were not activated")
    issues.extend([
        "TMS273 Mob.info.MADamage/MDRate have no matching current server magic-combat fields; retained in sources.monsters.",
        "TMS273 QuestData (including the 36301-36307 adventure sequence when present) has no activated server scripts; transitions/rewards remain empty and quest-text is display-only.",
        "TMS273 NPC dialogue/script references are not converted; shop NPCs use the current runtime's direct Act shop route and no Say text is invented.",
        "Player initial HP/attributes were not found in the selected TMS273 map/entity inputs; empty player config preserves current engine compatibility defaults.",
    ])
    gameplay = {
        "sourceContentVersion": "TMS273-273",
        "player": {},
        "monsters": sorted(monster_templates, key=lambda item: int(item["templateId"])),
        "spawns": monster_spawns,
        "expTable": [],
        "dropChanceDenominator": DROP_DENOMINATOR,
        # P: TMS273 map life keeps mobTime (units) per spawn and no map-wide
        # respawn cycle.  Normal spawns carry mobTime 0, so the server treats
        # them as "follow the map respawn cycle" with this fallback interval
        # (10000 ms matches the earlier assembled runtime).
        "monsterRespawnMs": 10000,
        "npcs": sorted(npc_templates, key=lambda item: int(item["templateId"])),
        "npcSpawns": npc_spawns,
        "shops": shops,
        "quests": quests,
        "sources": {
            "edition": "TMS273",
            "maps": {map_entry["id"]: map_entry.get("sourceJson") for map_entry in maps},
            "monsters": source_monsters,
            "items": item_sources,
            "shops": "data/Shop/*.json",
            "quests": "references/tms273-data/quests.json",
            "entities": relative_to_root(args.entities, ROOT),
            "hiddenNpcConditions": hidden_npc_conditions,
            "drops": {
                "source": "data/MobReward/*.json",
                "denominator": DROP_DENOMINATOR,
                "deferredQuestDrops": deferred_quest_drops,
            },
        },
        "incomplete": issues,
        "hiddenSourceLife": hidden_records,
        "compatibility": {
            "runtimeIds": "numeric template/item/NPC ids use no leading zero; source ids remain in sources.",
            "pdRate": "273 PDRate is a percentage and is emitted as pdRate; it must not be converted to absolute pdDamage.",
            "mdRate": "273 MDRate is retained in sources.monsters until a server field exists.",
            "respawn": "P: source spawn mobTime 0 is handled as the map respawn cycle; monsterRespawnMs=10000 is the fallback cycle (matches the earlier runtime) because TMS273 keeps no map-wide interval.",
            "player": "No confirmed TMS273 initial player stat record was selected; engine defaults remain compatibility behavior.",
            "quests": "Quest text is zh-only and QuestData execution is disabled by source metadata.",
        },
    }
    return gameplay, items, quest_text, {"schemaVersion": 1, "kind": "npc-name-zh", "generatedFrom": "TMS273 WZ_JSON_TW/String/Npc.json", "encoding": "UTF-8", "npcs": {item["templateId"]: item["name"] for item in npc_templates}}


def parse_args(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tms-root", type=Path, default=DEFAULT_TMS_ROOT)
    parser.add_argument("--maps-json", type=Path, default=DEFAULT_MAPS)
    parser.add_argument("--entities", type=Path, default=DEFAULT_ENTITIES)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--metadata-only", action="store_true", help="write review metadata without activating entity graphics")
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    try:
        gameplay, items, quest_text, npc_names = convert(args)
        write_json(args.output_dir / "gameplay.json", gameplay)
        write_json(args.output_dir / "items.json", items)
        write_json(args.output_dir / "quest-text.json", quest_text)
        write_json(args.output_dir / "npc-names.json", npc_names)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print("generate_tms273_gameplay: %s" % error, file=sys.stderr)
        return 2
    print(
        "Generated TMS273 gameplay: %d monster templates, %d monster spawns, %d NPC templates, %d NPC spawns, %d shops, %d items, %d quest texts"
        % (
            len(gameplay["monsters"]),
            len(gameplay["spawns"]),
            len(gameplay["npcs"]),
            len(gameplay["npcSpawns"]),
            len(gameplay["shops"]),
            len(items),
            len(quest_text["quests"]),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
