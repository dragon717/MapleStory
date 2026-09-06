# 官方中文语料导入报告（mxd.dvg.cn）

> 抓取源：`https://mxd.dvg.cn/questsinfo.php?id={}`　抓取时间：2026-09-06 09:26:04
> 生成：`scripts/quest_i18n/build_official_batch.py`

## 1. 覆盖统计

| 指标 | 值 |
|---|---|
| 语料 v83 任务数 | 2818 |
| 线上有数据（抓到） | 2817 |
| 英文名一致（可入批次） | 1815 |
| 其中含阶段行文本 | 1369 |
| 英文名不一致（冲突，仅报告） | 665 |
| 国服译名缺失/韩文残留（跳过） | 337 |
| 行文本无法对齐（只导名称） | 445 |
|  harvested NPC 中文名 | 487 |

## 2. 现网文案 vs 官方译名差异（不自动覆盖，需人工决策）

| questId | 现网 zh | 官方 zh |
|---|---|---|
| 1007 | 比格斯的收藏品 | 比格斯的物品收集 |
| 1021 | 罗杰的苹果 | 罗杰和苹果 |
| 1029 | 山姆的忠告 | 쌤의 조언 |
| 1030 | 玛丽亚教你看地图 | 마리아의 지도 보기 |

## 3. 英文名冲突样例（前 40）

| questId | 本地 v83 en | 线上 en | 线上 zh |
|---|---|---|---|
| 1007 | Bigg's Collection of Items | Biggs's Collection of Items | 比格斯的物品收集 |
| 1200 | Moon Bunny's Rice Cake | - | 迎月花保护月妙组队任务 |
| 1201 | First Time Together | - | 第一次同行 |
| 1202 | The Crack of Dimension | [Party Quest] Dimensional Schism | 玩具城组队任务 |
| 1203 | Remnants of Goddess | - | 女神塔组队任务 |
| 1204 | Lord Pirate | [Party Quest] Lord Pirate | 海盗船组队任务 |
| 1205 | Romeo and Juliet | [Party Quest] Romeo and Juliet | 拯救罗密欧和朱丽叶 |
| 1206 | Forest of Poison Haze | - | 毒雾森林 |
| 1300 | Ariant Hunting Competition | - | 阿里安特竞技大会 |
| 1301 | Monster Carnival | [Competitive Content] Monster Carnival | 怪物嘉年华 |
| 1302 | The 2nd Monster Carnival | [Competitive Content] The 2nd Monster Carnival | 第2届怪物嘉年华 |
| 2019 | A Clue to the Secret Book | [Sleepywood] Mr. Wetbottom's Secret Book | 秘密之书 |
| 2020 | Hungry Ronnie | [Sleepywood] Hungry Ronnie | 肚子饿的洛尼 |
| 2021 | Secret to Unagi Special | [Sleepywood] Unagi Special | 特制烤鳗鱼 |
| 2023 | Returned Secret Book | [Sleepywood] Returned Secret Book | 秘密之书回收 |
| 2024 | Collecting 100 Cursed Dolls | Collecting 50 Cursed Dolls | 搜集50个诅咒人偶 |
| 2025 | Collecting 200 Cursed Dolls | Collecting 70 Cursed Dolls | 搜集70个诅咒人偶 |
| 2026 | Collecting 400 Cursed Dolls | Collecting 100 Cursed Dolls | 搜集100个诅咒人偶 |
| 2027 | Collecting 600 Cursed Dolls | Collecting 150 Cursed Dolls | 搜集150个诅咒人偶 |
| 2028 | Collecting 1000 Cursed Dolls | Collecting 200 Cursed Dolls | 搜集200个诅咒人偶 |
| 2047 | Hero's Gladius | [Sleepywood] Hero's Gladius | 英雄的战剑 |
| 2048 | Rewakening the Gladius | [Sleepywood] Reawakening the Gladius | 旧战剑唤醒办法 |
| 2050 | Sabitrama and the Diet Medicine | [Forest of Endurance] The Pink Anthurium | 赫尔莎和粉红花束 |
| 2051 | Sabitrama's Anti-Aging Medicine | [Forest of Endurance] The Double-Rooted Red Ginseng | 赫尔莎和强效红参 |
| 2052 | John's Pink Flower Basket | [Forest of Tenacity] John's Pink Flower Basket | 约翰的粉红色花篮 |
| 2053 | John's Present | [Forest of Tenacity] John's Present | 约翰准备的礼物 |
| 2054 | John's Last Present | [Forest of Tenacity] John's Last Present | 约翰准备的最后礼物 |
| 2055 | Shumi's Lost Coin | [Construction Site B1] Shumi's Lost Coin | 休咪丢失的金币 |
| 2056 | Shumi's Lost Bundle of Money | [Construction Site B2] Shumi's Lost Roll of Cash | 休咪丢失的钞票 |
| 2057 | Shumi's Lost Sack of Money | [Construction Site B3] Shumi's Lost Sack of Cash | 休咪丢失的钱包 |
| 2096 | A Spell that Seals Up a Critical Danger I | [Sleepywood] The Great Danger Seal I | 封印住神秘危险之力的仪式 1 |
| 2097 | A Spell that Seals Up a Critical Danger II | [Sleepywood] The Great Danger Seal II | 封印住神秘危险之力的仪式  2 |
| 2147 | 스텀피의 묘목 기르기 | Stumpy's Growing Tree | 培育树妖王的苗木 |
| 2175 | Disciples of the Black Magician | Disciples of the Black Mage | 黑魔法师的手下 |
| 2212 | The Path of Pirate | The Path of a Pirate | 成为海盗的途径 |
| 2235 | Manji's Request | [Sleepywood] Manji's Apprentice | 麦吉的弟子 |
| 2236 | How to Shoo Away the Evil | [Sleepywood] To Shoo Away Evil | 赶走恶魔的方法 |
| 2237 | The Owner of the Mysterious Note | [Sleepywood] The Owner of the Mysterious Note | 被丢弃的纸条的主人 |
| 2238 | Who is the Owner of the Mysterious Note? | [Sleepywood] The Note's Mysterious Owner | 纸条的主人是？ |
| 2239 | Balrog and the Seal | [Sleepywood] Balrog and the Seal | 蝙蝠魔的封印 |

## 4. 未替换的内容标记（术语表缺词 Top 30）

| 标记 | 出现次数 |
|---|---|
| `#o9001009#` | 30 |
| `#o0210100#` | 29 |
| `#p1103000#` | 21 |
| `#t1902005#` | 17 |
| `#o9300285#` | 16 |
| `#o6220001#` | 14 |
| `#o9001010#` | 12 |
| `#o2230100#` | 11 |
| `#t4000166#` | 11 |
| `#o5120503#` | 11 |
| `#t4031518#` | 11 |
| `#t4031517#` | 11 |
| `#o1140130#` | 11 |
| `#t4031348#` | 10 |
| `#t4005004#` | 10 |
| `#t4032312#` | 10 |
| `#t1902015#` | 10 |
| `#t4032334#` | 10 |
| `#o1110101#` | 9 |
| `#t4031608#` | 9 |
| `#t1912005#` | 9 |
| `#t1902016#` | 9 |
| `#o6220000#` | 8 |
| `#o5220002#` | 8 |
| `#t4031927#` | 8 |
| `#o8140000#` | 8 |
| `#o8500001#` | 8 |
| `#t1032040#` | 8 |
| `#t4001207#` | 8 |
| `#o9300351#` | 8 |
