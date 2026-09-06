# M4 任务中文校对清单（proofreading workbench）

> 生成：2026-09-06 ｜ 范围：`shared/quest-text.json` 中所有含 zh 的条目
> 当前全部 `reviewed:false`（kind=ai 草稿）。**人工校对方式**：逐条对照 EN 与 zh，修正后把
> 该条 `sources.zh.reviewed` 置 `true` 并可在 `note` 注明依据；`git diff` 即校对轨迹。
> 自动校验基线：`verify_quest_corpus.py`（行数对齐/无残留色标/zh 不发明内容标记）。

## 规模

- 含 zh 任务：**62**（name 62 / lines 61 / log 2；全部 area=20，含 1 条 internal `maple-road-training`）
- 术语表：`shared/quest-glossary.json`（p/o/t → zh，`reviewed:false` 待抽查）；
  id→英文名解析：`evidence/quest-i18n/name-catalog.json`（p 344/345、o 301/303、t 1126/1128）。

| questId | zh 名称 | en 名称 | lines | log | 自动标记 |
|---|---|---|---|---|---|
| 1000 | 借赛拉的镜子 | Borrowing Sera's Mirror | 3 |  |  |
| 1001 | 把镜子带给希娜 | Bringing a Mirror to Heena | 2 |  |  |
| 1003 | 森想吃的东西 | What Sen wants to eat | 3 |  |  |
| 1004 | 回到妮娜那里 | Returning to Nina | 2 |  |  |
| 1005 | 给卢卡斯的信 | Letter for Lucas | 3 |  |  |
| 1006 | 卢卡斯的回信 | Lucas' Reply | 2 |  |  |
| 1007 | 比格斯的收藏品 | Bigg's Collection of Items | 3 |  |  |
| 1008 | 皮奥回收旧物 | Pio's Collecting Recycled Goods | 3 |  | L1残留内容标记 |
| 1009 | 雷恩的冒险岛测验 1 | Rain's Maple Quiz 1 | 3 |  |  |
| 1010 | 雷恩的冒险岛测验 2 | Rain's Maple Quiz 2 | 3 |  |  |
| 1011 | 雷恩的冒险岛测验 3 | Rain's Maple Quiz 3 | 3 |  |  |
| 1012 | 雷恩的冒险岛测验 4 | Rain's Maple Quiz 4 | 3 |  | L0残留内容标记 |
| 1013 | 雷恩的冒险岛测验 5 | Rain's Maple Quiz 5 | 3 |  | L0残留内容标记 |
| 1014 | 雷恩的冒险岛测验 6 | Rain's Maple Quiz 6 | 3 |  | L0残留内容标记 |
| 1015 | 雷恩的冒险岛测验 7 | Rain's Maple Quiz 7 | 3 |  | L0残留内容标记 |
| 1016 | 梅的训练 | Mai's Training | 3 |  | L1残留内容标记 |
| 1017 | 梅的最终训练 | Mai's Final Training | 3 |  | L1残留内容标记 |
| 1018 | 托德的狩猎教学 | Todd's How-to-Hunt | 3 |  | L1残留内容标记 |
| 1019 | 山姆的建议 | Sam's Suggestion | 3 |  | L1残留内容标记 |
| 1020 | 皮奥与回收 | Pio and the Recycling | 3 |  |  |
| 1021 | 罗杰的苹果 | Roger's Apple | 3 | ✓ |  |
| 1022 | 卢卡斯可爱的女儿 | Lucas' Cute Daughter | 3 |  | L0残留内容标记 |
| 1023 | 小猪猪，别跑…… | Here little Piggy... | 3 |  | L0残留内容标记 |
| 1024 | 恋爱咨询?! | Love Counseling ?! | 3 |  | L0残留内容标记 |
| 1025 | 玛丽亚的营养果汁 | Maria's Nutritious Juice | 3 |  | L0残留内容标记 |
| 1026 | 给香克斯送营养果汁 | Delivering Nutritious Juice to Shanks | 3 |  | L0残留内容标记 |
| 1027 | 梅的请求 | Mai's Request | 3 |  | L0残留内容标记 |
| 1028 | 前往明珠港！ | To Lith Harbor! | 3 |  | L0残留内容标记 |
| 1029 | 山姆的忠告 | Sam's Advice | 3 |  |  |
| 1030 | 玛丽亚教你看地图 | Maria's Map Reading | 3 |  |  |
| 1031 | 希娜与赛拉 | Heena and Sera | 3 |  |  |
| 1032 | 妮娜的弟弟森 | Nina's Brother Sen | 3 |  |  |
| 1033 | 森想要的东西 | What Sen Wants | 2 |  |  |
| 1034 | 美味的蘑菇糖 | Tasty Mushroom Candy | 2 |  |  |
| 1035 | 托德的狩猎心得 | Todd's Hunting Method | 3 |  | L1残留内容标记 |
| 1036 | 活百科罗宾 | Robin the Walking Encyclopedia | 3 |  |  |
| 1037 | 帮忙打蜗牛 | Help Hunt the Snails | 3 |  |  |
| 1038 | 玛丽亚的信 | Maria's Letter | 2 |  |  |
| 1039 | 帮助尤娜 | Helping Out Yoona | 3 |  |  |
| 1040 | 村长的引荐 | Chief's Introduction | 3 |  |  |
| 1041 | 梅的第一次训练 | Mai's First Training | 3 |  | L1残留内容标记 |
| 1042 | 梅的第二次训练 | Mai's Second Training | 2 |  |  |
| 1043 | 梅的第三次训练 | Mai's Third Training | 2 |  | L0残留内容标记 |
| 1044 | 梅的最后一次训练 | Mai's Last Training | 2 |  |  |
| 1045 | 巴里的考验 | Bari's Test | 3 |  | L1残留内容标记 |
| 1046 | 比格斯讲金银岛见闻 | Biggs's Story on Victoria Island. | 3 |  |  |
| 1048 | 职业推荐 | Job Recommendation | 3 |  |  |
| 1049 | 成为战士 | Becoming a Warrior | 3 |  |  |
| 1050 | 成为魔法师 | Becoming a Magician | 3 |  |  |
| 1051 | 成为弓箭手 | Becoming a Bowman | 3 |  |  |
| 1052 | 成为飞侠 | Becoming a Thief | 3 |  |  |
| 1053 | 成为海盗 | Becoming a Pirate | 3 |  |  |
| 8000 | 新生活 | New Life | 3 |  | L1残留内容标记 |
| 8020 | 尤娜的购物测验：开始 | Yoona's Quiz on Shopping : Start | 3 |  |  |
| 8021 | 尤娜的购物测验 1 | Yoona's Quiz on Shopping 1 | 3 |  |  |
| 8022 | 尤娜的购物测验 2 | Yoona's Quiz on Shopping 2 | 3 |  |  |
| 8023 | 尤娜的购物测验 3 | Yoona's Quiz on Shopping 3 | 3 |  |  |
| 8024 | 尤娜的购物测验 4 | Yoona's Quiz on Shopping 4 | 3 |  |  |
| 8025 | 尤娜的购物测验 5 | Yoona's Quiz on Shopping 5 | 3 |  |  |
| 8031 | 保卫卢卡斯的农场 | Protect Lucas's Farm | 3 |  | L1残留内容标记 |
| 8142 | 托德的狩猎教学 | Todd's How-to-Hunt | 3 |  | L0残留内容标记 |
| maple-road-training | 训练营任务确认 | Training Camp Check | 0 | ✓ |  |

## 逐条明细（EN ↔ ZH）

### 1000 — 借赛拉的镜子

- **EN 名称**：Borrowing Sera's Mirror
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's go to Heena. | 去希娜那里吧。 |
| 1 | I ran into Heena who was worrying about her face getting irritated by the strong sunlight. I have to get a mirror for Heena from her sister, Sarah. | 我碰到正担心皮肤被强烈日晒晒伤的希娜。得去她姐姐萨拉那里，帮希娜拿一面镜子。 |
| 2 | Heena asked me to go to her sister and get a mirror for her. I walked my way to Sarah. | 希娜请我去她姐姐那里拿镜子。我出发去找萨拉了。 |

### 1001 — 把镜子带给希娜

- **EN 名称**：Bringing a Mirror to Heena
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I borrowed a mirror from Sarah who was doing her laundry. I have to take this mirror to Heena. | 我从正在洗衣服的萨拉那里借来了镜子，得把镜子带给希娜。 |
| 1 | I borrowed a mirror from Sarah, who was doing her laundry, and brought it back to Heena. | 我从正在洗衣服的萨拉那里借来镜子，并把它带给了希娜。 |

### 1003 — 森想吃的东西

- **EN 名称**：What Sen wants to eat
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's talk to Nina. | 去跟妮娜谈谈吧。 |
| 1 | I ran into Nina who was thinking about what to make for Dinner for her brother, Sen. I have to go and talk to Sen who is next to Nina, and find out what he wants to have for dinner. | 我碰到正在发愁晚餐该给弟弟森做什么的妮娜。得去问问就在妮娜旁边的森，看他晚餐想吃什么。 |
| 2 | I asked Sen, Nina's brother, what he wants to have for dinner. He answers he wants to have a Mushroom Soup. | 我问了妮娜的弟弟森晚餐想吃什么。他说想喝蘑菇汤。 |

### 1004 — 回到妮娜那里

- **EN 名称**：Returning to Nina
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Sen wants to have Mushroom Soup for Dinner. Let's get back to Nina now. | 森晚餐想喝蘑菇汤。现在回妮娜那里吧。 |
| 1 | I told Nina what Sen wants for dinner. | 我把森想吃的告诉了妮娜。 |

### 1005 — 给卢卡斯的信

- **EN 名称**：Letter for Lucas
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I heard Maria need a help... | 听说玛丽亚需要帮助…… |
| 1 | I met Maria who was desperately looking for help. She gave me a letter and asked me to bring this to Lucas in Amherst... | 我遇见正急着找帮手的玛丽亚。她给了我一封信，请我送到阿姆赫斯特的卢卡斯那里…… |
| 2 | I gave Maria's letter to Lucas in Amherst. | 我把玛丽亚的信送到了阿姆赫斯特的卢卡斯手上。 |

### 1006 — 卢卡斯的回信

- **EN 名称**：Lucas' Reply
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I delivered Maria's letter to Lucas who was in Amherst. He wrote a reply, which I think I should bring back to Maria. | 我把玛丽亚的信送到了阿姆赫斯特的卢卡斯那里。他写了回信，我想应该把回信带回给玛丽亚。 |
| 1 | Maria looked relieved after reading the reply from Lucas. I wanted to read it too, but I think I did what I was supposed to do. | 读完卢卡斯的回信后，玛丽亚看起来松了口气。我也想知道信里写了什么，不过该做的我都做了。 |

### 1007 — 比格斯的收藏品

- **EN 名称**：Bigg's Collection of Items
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's start looking for Biggs. | 去找比格斯吧。 |
| 1 | I met Biggs at Southperry. He asked me if I can get him 10 orange mushroom caps and 30 blue snail shells and that he'll reward me with a nice item if I do so. He doesn't look too convinced that I can do this, but... it looks like a piece of cake to me. | 我在南港见到了比格斯。他问我能不能帮他弄来 10 个花蘑菇盖和 30 个蓝蜗牛壳，还说办到了就给我一件不错的道具作为奖励。他看起来不太相信我办得到，不过……对我来说只是小菜一碟。 |
| 2 | I got Biggs from Southperry 10 mushroom caps and 30 blue snail shells. How is he going to do business out of this anyway? Well, he did get me a decent weapon to use. I guess I can travel for a while with this... | 我替南港的比格斯弄来了 10 个蘑菇盖和 30 个蓝蜗牛壳。他到底打算拿这些做什么生意啊？总之他给了我把还不错的武器。用它闯荡一阵子应该没问题…… |

### 1008 — 皮奥回收旧物

- **EN 名称**：Pio's Collecting Recycled Goods
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | When I see Pio, he asks me to help collecting recycled goods. | 见到皮奥时，他请我帮忙收集可回收的物品。 |
| 1 | I ran into Pio who is famous in Amherst for fixing broken goods. Pio tells me to break down scrap boxes from here and there in the village and bring back a #t4031161# and an #t4031162#. I think I saw some scrap boxes in the village...\n\n#t4031162# #c4031162# / 1\n#t4031161# #c4031161# / 1 | 我在阿姆赫斯特遇见了以修理旧物出名的皮奥。皮奥让我把村里各处的废箱子拆掉，带一个 #t4031161# 和一个 #t4031162# 给他。我记得村里好像见过一些废箱子……  #t4031162# #c4031162# / 1 #t4031161# #c4031161# / 1 |
| 2 | As Pio asked me, I broke down some useless boxes that were lying here and there in the village, and returned it to him. It was fun collecting them because I could find some useful stuff in them as well. | 按皮奥的请求，我拆掉了村里散落的废箱子，把材料交给了他。收集的过程挺有意思，因为偶尔还能翻到有用的东西。 |

### 1009 — 雷恩的冒险岛测验 1

- **EN 名称**：Rain's Maple Quiz 1
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I'm not a beginner anymore. Let's meet Rain and solve the Quiz! | 我已经不是新手了。去见雷恩挑战小测吧！ |
| 1 | I'm not a MapleStory Beginner. Let's solve Rain's Quiz. | 我已经不是冒险岛的初心者了。来解雷恩的小测吧。 |
| 2 | Rain's First Quiz was, what is the hot-key to open the Item Inventory? I'll make sure I remember the hot-key "I"... | 雷恩的第一题是：打开物品栏的快捷键是什么？我会牢牢记住快捷键「I」…… |

### 1010 — 雷恩的冒险岛测验 2

- **EN 名称**：Rain's Maple Quiz 2
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's solve Rain's 2nd Quiz. | 来解雷恩的第二道小测吧。 |
| 1 | What would be Rain's 2nd Quiz? | 雷恩的第二道小测会是什么呢？ |
| 2 | I found out from Rain's Quiz that the wearable items can be equipped by double-clicking onthe item. | 我从雷恩的小测里学到了：双击道具即可穿戴装备。 |

### 1011 — 雷恩的冒险岛测验 3

- **EN 名称**：Rain's Maple Quiz 3
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's solve Rain's 3rd Quiz. | 来解雷恩的第三道小测吧。 |
| 1 | What would be Rain's 3rd Quiz? It won't matter cause I'm good~ | 雷恩的第三道小测会是什么呢？反正难不倒我～ |
| 2 | I found out "E" is the hot-key for opening the Equipment Window. I can take off what I'm wearing by double-clicking on the item in the Equipment Window. | 我学到了「E」是打开装备窗口的快捷键。在装备窗口里双击道具还可以脱下装备。 |

### 1012 — 雷恩的冒险岛测验 4

- **EN 名称**：Rain's Maple Quiz 4
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's solve #p12101#'s fourth Quiz. | 来解 #p12101# 的第四道小测吧。 |
| 1 | You can solve Rain's Quizzes if you carefully think about it. | 只要仔细想想，雷恩的小测并不难解。 |
| 2 | Rain's 4th Quiz was finding the hot-key for picking up the items on the ground. That's easy~ it's " Z" of course~ But I found out I can also pick up items with the number key "0"... | 雷恩的第四题是找出拾取地上道具的快捷键。简单～当然是「Z」啦……不过我还发现，用小键盘的「0」键也能拾取道具…… |

### 1013 — 雷恩的冒险岛测验 5

- **EN 名称**：Rain's Maple Quiz 5
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | #p12101#'s fifth Quiz. What would it be about? | #p12101# 的第五道小测。会考什么呢？ |
| 1 | What would be the 5th Quiz? | 第五道小测会是什么呢？ |
| 2 | Rain gave me a Quiz about Job Advancements. For Warriors, Thieves, and Bowmen, you need to be at least level 10, while for Magicians, you can advance at Level 8. | 雷恩出了一道关于转职的小测。战士、飞侠和弓箭手需要至少 10 级才能转职，而魔法师 8 级就可以转职。 |

### 1014 — 雷恩的冒险岛测验 6

- **EN 名称**：Rain's Maple Quiz 6
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Shall we solve #p12101#'s sixth Quiz? | 要不要来解 #p12101# 的第六道小测？ |
| 1 | Finally, it's the 6th Quiz. I'm happy that my Maple knowledge can be used here like this. Why don't I go for the 6th Quiz?  | 终于到第六道小测了。没想到我在冒险岛学到的知识还能这样派上用场，真开心。去挑战第六道小测吧？ |
| 2 | I learned that every time my level goes up, I get 5 Ability Points(AP) that I can upgrade my abilities. I can see the detail with the hot-key "S". | 我学到了：每次升级会获得 5 点能力点（AP），可以用来强化能力。按「S」键可以查看详细能力。 |

### 1015 — 雷恩的冒险岛测验 7

- **EN 名称**：Rain's Maple Quiz 7
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | This is #p12101#'s last Maple Quiz! I'm excited. Let's do it! | 这是 #p12101# 的最后一期冒险岛小测！真让人兴奋。上吧！ |
| 1 | Finally the last Quiz. Now I think I'm not a beginner~ | 终于到最后一道小测了。这样我就不再是新手了吧～ |
| 2 | Rain advised me to leave Maple Island and go for a greater journey. In Victoria Island, you can choose your job, and face a whole lot of new adventures. Ok...let's go to Maple Island's South Ferry... | 雷恩建议我离开彩虹岛，去更大的世界冒险。在金银岛上可以挑选职业，还会遇到一大堆新的冒险。好……去彩虹岛的南港吧…… |

### 1016 — 梅的训练

- **EN 名称**：Mai's Training
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Mai in Maple Island seems like a Martial -Art specialist, who can train the beginners to boost up the strength... | 彩虹岛上的梅看起来是位擅长指导新手提升力量的格斗高手…… |
| 1 | I decided to get trained under the Famous Sword-Master, Mai, in Amherst. I guess hunting the weakest monsters is a good idea. Should I hunt Snail, Blue Snail, and Shroom in order?\n\n#o100100# #a10161# \n#o100101#  #a10162# \n#o120100# #a10163#\n\n Ah, Mai told me to meet with #p20002# in Southperry and try training together... | 我决定拜在阿姆赫斯特著名剑术大师梅的门下训练。先打打最弱的怪物热身应该不错。要不要按蜗牛、蓝蜗牛、蘑菇仔的顺序来？  #o100100# #a10161#  #o100101# #a10162#  #o120100# #a10163#   啊，梅还让我去南港找比格斯，和他一起训练…… |
| 2 | Mai trained me, and I feel I'm a lot stronger. | 梅训练了我，我觉得自己变强了很多。 |

### 1017 — 梅的最终训练

- **EN 名称**：Mai's Final Training
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Mai's training is a simple monster-hunt. But it is very useful in getting used to hunting. Let's get Mai's training, which might be the last training in Maple Island. | 梅的训练就是简单的猎杀怪物，但对熟悉打猎很有帮助。去接受梅的训练吧，这也许是彩虹岛上最后一次训练了。 |
| 1 | Mai told me to hunt stronger monsters. Of course it is important to know your own strength, but to develop your strength, you need to try to hunt stronger monsters.\n\n#o1210102# #a10171#  | 梅让我去猎更强的怪物。当然，清楚自己的实力很重要，但想变强，就得试着挑战更强的怪物。  #o1210102# #a10171#  |
| 2 | After getting Mai's traning, I became much stronger. I think I am going to leave Maple Island to get a job I like. Let's go to South Ferry and head to Victoria Island. | 接受梅的训练后，我变强了很多。我想离开彩虹岛去找份喜欢的职业。去南港坐船前往金银岛吧。 |

### 1018 — 托德的狩猎教学

- **EN 名称**：Todd's How-to-Hunt
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I hear Todd can teach us how to hunt... | 听说托德会教我们怎么狩猎…… |
| 1 | Todd taught me to move towards upper right-hand side to attack and kill Jr. Sentinel, and talk to #p2002#...\n\nJr. Sentinel #a10181#\n#t4000142# #c4000142#/1 | 托德教会我：向右上方移动攻击，击杀见习哨兵，然后再去找彼得……  见习哨兵 #a10181# #t4000142# #c4000142#/1 |
| 2 | I killed the monster just as Todd told me. | 我按托德说的杀了那只怪物。 |

### 1019 — 山姆的建议

- **EN 名称**：Sam's Suggestion
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Sam suggested me to meet Mai... | 山姆建议我去见梅…… |
| 1 | When I talked to Sam, he first told me to go to the East...and he told me to hunt 10 #o100100#...and meet #p12100#. \n\n#o100100# #a10191# | 和山姆交谈时，他先让我往东边去……然后让我猎 10 只蜗牛……再去见梅。  #o100100# #a10191# |
| 2 | As Sam told me, I hunted 10 #o100100#...and met #p12100#. | 按山姆说的，我猎了 10 只蜗牛……也见到了梅。 |

### 1020 — 皮奥与回收

- **EN 名称**：Pio and the Recycling
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I gathered up the recycling materials that Pio asked for, and he said he'll make me something nice in return... | 我把皮奥要的回收材料集齐了，他说会做点好东西报答我…… |
| 1 | Pio promised to make me a nice relaxing chair with the recylicing materials I gathered up for him. | 皮奥答应我，会用我收集来的回收材料做一把舒服的休闲椅。 |
| 2 | I helped Pio gather up the recycling materials, and he made a nice comfortable chair. | 我帮皮奥集齐了回收材料，他做了一把很舒服的椅子送给我。 |

### 1021 — 罗杰的苹果

- **EN 名称**：Roger's Apple
- **auto**：无

- **日志文案 log**：
  - EN：Talk to Roger on Maple Road. Use the Roger's Apple he hands you and recover your HP to full.
  - ZH：前往冒险岛路与罗杰对话，使用他给你的罗杰的苹果恢复 HP 到满值。

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Let's talk to #p2000#. | 去找罗杰谈谈吧。 |
| 1 | By pressing the hotkey I, I can consume #t02010007# in consumption window. Let's talk to #p2000#.. | 在消耗栏里按 I 键，双击「罗杰的苹果」就能使用。之后回去找罗杰谈谈吧。 |
| 2 | I learned how to use items! This will make life much easier! | 我学会使用道具了！以后会方便很多！ |

### 1022 — 卢卡斯可爱的女儿

- **EN 名称**：Lucas' Cute Daughter
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | They say there's a request for elder #p12000# in #m1010000#. | 听说 #m1010000# 的长老 #p12000# 有委托。 |
| 1 | #p12000# is worried about his daughter in #m60000#. To make the way safe for his daughter on her way home, he asked me to catch #o0130101#. #o0130101#? Hmmm~ tough one..Then after killing #o0130101#, shall I go to  #p20100#? \n  \n#o0130101# #a10221#  | #p12000# 正为住在 #m60000# 的女儿担心。为了让女儿回家的路安全，他请我把 #o0130101# 收拾干净。#o0130101#？唔……有点棘手……解决掉 #o0130101# 后，要不要去找 #p20100#？    #o0130101# #a10221#  |
| 2 | I let #p20100# know I beat off all of #o0130101#. Yes! | 我去告诉 #p20100#，我已经把 #o0130101# 都解决掉了。耶！ |

### 1023 — 小猪猪，别跑……

- **EN 名称**：Here little Piggy...
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | #p20002# in #m60000# looks upset. What's going on? | #m60000# 的 #p20002# 看起来很沮丧。发生什么事了？ |
| 1 | #p20002# heard that somebody told him he looks like #o1210100#. That's why he's so mad. To be honest, they look alike.....anyway, for #p20002#, let's get 2#o1210100#. \n  \n#o1210100# #a10231#  | 有人说 #p20002# 长得像 #o1210100#，他为此大发雷霆。说实话……确实有点像……总之，为了 #p20002#，去猎 2 只 #o1210100# 吧。    #o1210100# #a10231#  |
| 2 | I defeated #o1210100#! #p20002# seems satisfied. | 我打败了 #o1210100#！#p20002# 看起来很满意。 |

### 1024 — 恋爱咨询?!

- **EN 名称**：Love Counseling ?!
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | #p2005# said he needs to ask me something...I hope this isn't some weird favor... | #p2005# 说有事要问我……希望不是什么奇怪的请求…… |
| 1 | #p2005# is helping  #p20001#, the crew of  #m60000#, to find ingredients for his girlfriend's present. He asked me to get  3 #t4000003# and hand in to #p20001#. #t4000003#? It's a monster which looks like a tree stump. If I find #o0130100#, I think I can get what he says. \n\n#i4000003##t4000003# #c4000003#/3 | #p2005# 正在帮 #m60000# 的船员 #p20001# 寻找送女朋友礼物的材料。他请我弄 3 个 #t4000003# 交给 #p20001#。#t4000003#？那是一种看起来像木妖的怪物掉的东西。如果找到 #o0130100#，应该就能弄到。  #i4000003##t4000003# #c4000003#/3 |
| 2 | I gave #p20001# #t4000003#. #p20001# is going to make a boat. When would he finish it? Would #p20100# be on #p20001#'s boat? | 我把 #t4000003# 交给了 #p20001#。#p20001# 准备造一条船。什么时候能造好呢？#p20100# 会坐 #p20001# 的船吗？ |

### 1025 — 玛丽亚的营养果汁

- **EN 名称**：Maria's Nutritious Juice
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | #p2103# said he wants to say something to me... | #p2103# 说有话要对我说…… |
| 1 | #p2103# wants to make a nutritious juice that is necessary for good health and asked me to get ingredients: #t4000004# and #t4000011#... I wonder what kind of juice it be.\n\n#i4000004##t4000004# #c4000004#/1 \n#i4000011##t4000011# #c4000011#/5 | #p2103# 想做一杯有益健康、营养满满的果汁，请我找齐材料：#t4000004# 和 #t4000011#……不知道会是什么味道的果汁。  #i4000004##t4000004# #c4000004#/1  #i4000011##t4000011# #c4000011#/5 |
| 2 | I have all ingredients to #p2103#.  #p2103# seems to ask for some more. | 我把材料都交给了 #p2103#。#p2103# 似乎还想要更多。 |

### 1026 — 给香克斯送营养果汁

- **EN 名称**：Delivering Nutritious Juice to Shanks
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Would #p2103# make a nutritious juice? Seems to ask for more... | #p2103# 会做出营养果汁吗？好像还需要更多材料…… |
| 1 | #p2103# asked me to give nutritious juice to  #p22000#, the captain of #m60000#. Hmm...are they dating? | #p2103# 请我把营养果汁交给 #m60000# 的船长 #p22000#。嗯……他们俩在交往吗？ |
| 2 | I gave #p22000#  #p2103#'s nutritious juice.  #p22000# looked happy... #p2103# and  #p22000# are dating. The juice looks...pretty nasty, actually; but #p22000# was encouraged and gave me some advice. | 我把 #p2103# 的营养果汁交给了 #p22000#。#p22000# 看起来很开心……原来 #p2103# 和 #p22000# 在交往啊。那果汁看起来……说实话挺恶心的；不过 #p22000# 受到鼓舞，还给了我一些建议。 |

### 1027 — 梅的请求

- **EN 名称**：Mai's Request
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | #p12100# stands at #m50000#. They say she is the strongest in Maple Island.... Why is she here? What's her life story like? Let's see #p12100#. | #p12100# 站在 #m50000#。听说她是彩虹岛上最强的人……她为什么会在这里？她有着怎样的经历？去 #p12100# 那里问问吧。 |
| 1 | #p12100# is a new adventurer and worker on Victoria Island. But the elder, #p12000# in #m1010000# hired her in case of any dangerous situations on Maple Island. #p12100# says it's a hard time now because of all the work....Let's tell #p12000# what #p12100# said. | #p12100# 是从金银岛来的新冒险家和工作人员。但彩虹岛上可能出现危险情况，所以 #m1010000# 的长老 #p12000# 雇了她。#p12100# 说现在工作太多、很辛苦……去把 #p12100# 的话转告 #p12000# 吧。 |
| 2 | #p12000# agreed with what #p12100# said. He said it's better to hire more workers. Then he asked me to tell #p1002101# in #m104000000#... #m104000000# is in Victoria Island...I have to go to  #p22000# in #m60000#. | #p12000# 认同 #p12100# 的说法。他说最好再多雇几个帮手。然后他让我去 #m104000000# 找 #p1002101#……#m104000000# 在金银岛上……我得先去找 #m60000# 的 #p22000#。 |

### 1028 — 前往明珠港！

- **EN 名称**：To Lith Harbor!
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | To deliver a message of #p12000# to #p1002101#, I need to go to Victoria Island. The only way I can get there is to pay #p22000# in #m60000#... Fortunately, #p12000# said he will ask #p22000# a favor. Let's not worry and go to #p22000#. | 要把 #p12000# 的口信带给 #p1002101#，我得去金银岛。唯一的办法是坐 #m60000# 的 #p22000# 的船……幸好 #p12000# 说会跟 #p22000# 打声招呼。别担心，去找 #p22000# 吧。 |
| 1 | #p22000# let me on board for free as he heard from #p12000#. Good, now let's go to Victoria Island! #m104000000#! Now I only have to find  #p1002101#? much bigger than Maple Island..can I find it? | #p22000# 听说是 #p12000# 拜托的，让我免费上了船。太好了，去金银岛吧！目的地 #m104000000#！现在只要找到 #p1002101# 就行……比彩虹岛大好多……我能找到吗？ |
| 2 | I met  #p1002101# in #m104000000#. Hmmm~ This tough and stubborn guy is a friend of #p12000#! Amazing! Fortunately,  #p1002101# would do a favor of #p12000#. Hope I can find a nice guy so that my first trip to the Maple World ends well... | 我在 #m104000000# 见到了 #p1002101#。唔……这位又顽固又倔强的大叔居然是 #p12000# 的朋友！真了不起！幸好 #p1002101# 愿意帮 #p12000# 的忙。希望第一次枫叶世界之行能顺利遇上好人…… |

### 1029 — 山姆的忠告

- **EN 名称**：Sam's Advice
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | A kind guy on Maple Island, Sam wanted to give me some Beginner advice...who says beginners aren't lucky? | 彩虹岛上有位善良的山姆，想给我一些新手建议……谁说新手运气不好了？ |
| 1 | Sam taught me How to use AP which I can get whenever my level gets up. The investment of  AP determines my power (STR), intelligence (INT), agility (DEX), luck (LUK). My investment choice of AP will increase my HP and MP. \n\nwhoa.. Fantastic! I learned a lot thanks to him. Sam said there is one more thing to tell me. | 山姆教我怎么使用每次升级都会获得的能力点(AP)。加点方向决定我的力量(STR)、智力(INT)、敏捷(DEX)和幸运(LUK)。加点方式还会影响我的 HP 与 MP。  哇……太棒了！托他的福学到很多。山姆说还有一件事要告诉我。 |
| 2 | Sam told me to go to Victoria Island if I want to be a stronger adventurer through a Job Advancement. I can choose from a Warrior, a Magician, a Bowman, a Thief and a Pirate on Victoria Island. Each job has a stat requirement to join and train on that path: Warrior is STR 35, Magician INT 20, Bowman DEX 25, Thief DEX 25. I'll remember that and invest AP in the proper stats of the job i want! | 山姆说，如果我想通过转职成为更强的冒险家，就去金银岛。在金银岛上可以从战士、魔法师、弓箭手、飞侠、海盗中选择职业。每种职业都有加入并修炼所需的能力要求：战士要求 STR 35、魔法师要求 INT 20、弓箭手要求 DEX 25、飞侠要求 DEX 25。我会记住，并把 AP 加到想选职业对应的能力上！ |

### 1030 — 玛丽亚教你看地图

- **EN 名称**：Maria's Map Reading
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I'm at a crossroads. Where should I go? I should've seen the sign. Hhhhh! Let's ask Maria for help. | 我站在岔路口。该往哪边走？刚才应该看清路标的。唉！去请玛丽亚帮忙吧。 |
| 1 | Maria showed me how to read the World Map. If I press W, the world map will appear. I can see some places that I haven't been... | 玛丽亚教我看世界地图。按 W 键就会显示世界地图。可以看到一些还没去过的地方…… |
| 2 | I think the world map will make it easier to go around Maple World. | 我觉得有了世界地图，在枫叶世界走动会方便很多。 |

### 1031 — 希娜与赛拉

- **EN 名称**：Heena and Sera
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Maple World, where fantasy and reality meet and have pie! This is the world where many people are eager to listen to my own story. I better go talk to Heena first. | 枫叶世界，一个幻想与现实相遇、还能吃到派的世界！这里有很多人都想听我的故事。先去跟希娜谈谈吧。 |
| 1 | Heena told me her sister Sera also likes to meet with new travelers, and wanted me to go see her. Apparently, Sera's near by, hanging laundry. I better head right. | 希娜告诉我，她姐姐赛拉也很喜欢认识新的旅行者，希望我去见见她。赛拉好像就在附近晾衣服。我最好往右走。 |
| 2 | Sera told me to take the portal on the right and move forward. | 赛拉让我走右边的传送点继续前进。 |

### 1032 — 妮娜的弟弟森

- **EN 名称**：Nina's Brother Sen
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Apparently, Nina, a proud resident of the Mushroom Town, has a little brother... | 蘑菇村的妮娜是位自豪的村民，据说她有个小弟弟…… |
| 1 | Nina asked me to ask her brother Sen what he wants for dinner. Since Sen's at the residential area of Mushroom Town, I better go inside the house where he stays. | 妮娜请我去问她弟弟森晚餐想吃什么。森在蘑菇村的住宅区，我得进他住的那间房子去找他。 |
| 2 | Sen told me he wants a tasty Mushroom Candy. | 森告诉我，他想吃美味的蘑菇糖。 |

### 1033 — 森想要的东西

- **EN 名称**：What Sen Wants
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | What Sen wanted was a nice, tasty Mushroom Candy. I better tell this to Nina. | 森想要的是一颗美味可口的蘑菇糖。去告诉妮娜吧。 |
| 1 | I told Nina what Sen wanted right now. | 我把森想要的东西告诉了妮娜。 |

### 1034 — 美味的蘑菇糖

- **EN 名称**：Tasty Mushroom Candy
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I told Nina Sen wanted a Mushroom Candy. She then took out ten of those from her pocket, and asked me if I could give those to him. I better go see Sen right now. | 我告诉妮娜，森想要蘑菇糖。她从口袋里掏出十颗，问我能不能带给森。现在就去森那里吧。 |
| 1 | When Sen received the Mushroom Candy, he seemed very grateful and even gave me 2 of those. | 森收到蘑菇糖时非常感激，还给了我两颗。 |

### 1035 — 托德的狩猎心得

- **EN 名称**：Todd's Hunting Method
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | At the East entrance of the Mushroom Town, there's a fella named Todd who can teach me how to hunt in the world of Maple. I better go see him right now. | 蘑菇村东入口有位叫托德的家伙，可以教我在枫叶世界里怎么狩猎。现在就去见他吧。 |
| 1 | Todd instructed me that the Ctrl key allows me to hunt in a basic manner, and told me to hunt the Jr. Sentinel nearby. I should hunt Jr. Sentinel, grab 1 piece of Jr. Sentinel Shellpiece and bring them to Peter to learn hunting methods using skills. \n\nJr. Sentinel #a1#   \n\n#i4031802# #t4031802# #c4031802#/1 | 托德教我：按 Ctrl 键可以进行基础攻击，还让我去猎附近的见习哨兵。我应该猎见习哨兵，拿 1 片见习哨兵壳片，去找彼得学习用技能狩猎的方法。  见习哨兵 #a1#     #i4031802# #t4031802# #c4031802#/1 |
| 2 | I have learned that skills can be accessed through pressing K to open the skill window, and unlike regular attacks, skills can only be accessed by raising the skill level by assigning skill points. He also told me that it's much easier to use the skill by saving it on the Quick Slot. I better do that. | 我学会了：按 K 键可以打开技能窗口；与普通攻击不同，技能要分配技能点提升等级后才能使用。他还说，把技能放到快捷栏会更方便。最好照做。 |

### 1036 — 活百科罗宾

- **EN 名称**：Robin the Walking Encyclopedia
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Robin, who exudes confidence as he stands at Snail Hunting Ground 1, apparently knows a lot about job advancements and stats. I better go talk to him right now. | 站在蜗牛狩猎场 1 的罗宾一脸自信，似乎对转职和能力点很了解。现在就去问他吧。 |
| 1 | Robin told me that he'll teach me all I need to know about the stats, AP, and job advancement, then quiz me on it. I better learn some things about Ap first before continuing with the quest of Robin the Walking Encyclopedia. | 罗宾说会把他知道的能力、能力点和转职知识都教给我，然后再考考我。继续「活百科罗宾」的任务之前，最好先学点能力点(AP)的知识。 |
| 2 | I was able to pass Robin's quiz. Phew... | 我通过了罗宾的小测。呼…… |

### 1037 — 帮忙打蜗牛

- **EN 名称**：Help Hunt the Snails
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Sam at the Snail Hunting Ground 1 apparently is looking for me. I better go see him right now... | 蜗牛狩猎场 1 的山姆好像在找我。现在就去见他吧…… |
| 1 | Sam asked me to take care of some snails to protect Maria, who ventured off town to collect some mushrooms. I better slay 10 Snails and notify Maria that the field is clear.\n\nSnail #a10371# | 山姆请我帮忙清理蜗牛，好保护出门采蘑菇的玛丽亚。我得杀 10 只蜗牛，再告诉玛丽亚这边已经安全了。  蜗牛 #a10371# |
| 2 | I told Maria I took care of the snails. | 我告诉玛丽亚，蜗牛已经清理干净了。 |

### 1038 — 玛丽亚的信

- **EN 名称**：Maria's Letter
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Maria said that she feels relieved that the snails are gone, and that she can now concentrate on collecting the mushrooms. To make sure no one worries about her, she told me to give this letter to Chief Lucas of Amherst. | 玛丽亚说蜗牛没了她就放心了，可以专心采蘑菇。为了不让人担心，她让我把这封信交给阿姆赫斯特的卢卡斯村长。 |
| 1 | After reading the letter, Lucas seemed quite relieved, and told me he has someone he wants to introduce to me that can train me. | 卢卡斯读完信后如释重负，并说要介绍一个人给我认识，那人能训练我。 |

### 1039 — 帮助尤娜

- **EN 名称**：Helping Out Yoona
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | Apparently Yoona is in a bit of trouble after wandering outside Amherst. | 尤娜似乎是在阿姆赫斯特外面闲逛时遇到了麻烦。 |
| 1 | Yoona obviously didn't think it'd be all that when she left town, only to realize that there were lots of monsters outside. To help her return home, she asked me to take care of someBlue Snails and Shrooms.\n\nBlue Snail #a10391#  \nShroom #a10392# | 尤娜显然没想到外面会这么麻烦，离开村子才发现外面怪物成群。为了让她能回家，她请我帮忙清理一些蓝蜗牛和蘑菇仔。  蓝蜗牛 #a10391#   蘑菇仔 #a10392# |
| 2 | I told Yoona that I have taken care of some Blue Snails and Shrooms. | 我告诉尤娜，蓝蜗牛和蘑菇仔已经清理好了。 |

### 1040 — 村长的引荐

- **EN 名称**：Chief's Introduction
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | For taking care of the snails for the safety of Maria, Lucas offered to introduce me to a person that'll train me. Who would that be? I better go see him. | 为了玛丽亚的安全帮忙清理蜗牛后，卢卡斯说要介绍一个人来训练我。会是谁呢？去见他吧。 |
| 1 | Lucas told me to head to the East Field of Amherst and find Mai, who trains by herself there. He wanted me to to receive Mai's trainings. He said the training will definitely come in handy, since she used to apply her trades at Victoria Island...  \n\n#y1041#  (#u1041#)\n#y1042#  (#u1042#)\n#y1043#  (#u1043#)\n#y1044# (#u1044#)\n | 卢卡斯让我去阿姆赫斯特的东郊找独自训练的梅。他想让我接受梅的训练。他说这训练肯定用得上，因为梅以前在金银岛用过她的手艺……  #y1041#  (#u1041#) #y1042#  (#u1042#) #y1043#  (#u1043#) #y1044# (#u1044#)  |
| 2 | I completed all of Mai's Trainings and returned to Lucas. | 我完成了梅的全部训练，回到了卢卡斯那里。 |

### 1041 — 梅的第一次训练

- **EN 名称**：Mai's First Training
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I was finally introduced to the person that'll train me through Lucas. Apparently, at the East Field of Amherst, I can find Mai training by herself. I better head East. | 卢卡斯终于把我介绍给了要训练我的人。在阿姆赫斯特东郊可以看到独自训练的梅。往东走吧。 |
| 1 | Mai instructed me to work on my hunting by first working on easy monsters. She then instructed me to hunt 5 Stumps and collect 3 Tree Branches. \n\nStump #a10411# #i4000003# #t4000003# #c4000003# /3 | 梅先让我从简单的怪物开始练习狩猎，然后让我猎 5 只木妖，收集 3 根树枝。  木妖 #a10411# #i4000003# #t4000003# #c4000003# /3 |
| 2 | I managed to hunt 5 Stumps, gathered all the branches, and reported them to Mai. | 我猎了 5 只木妖，集齐了树枝，并向梅汇报。 |

### 1042 — 梅的第二次训练

- **EN 名称**：Mai's Second Training
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | After coming back from hunting Stumps, Mai thought I had some talent, and proceeded to turn up the training by a notch. This time, I'll have to hunt 5 Red Snails. Apparently they are faster than Stumps, so I better watch out. \n\nRed Snail #a10421# | 猎完木妖回来后，梅觉得我有些天赋，于是把训练难度提高了一档。这次要猎 5 只红蜗牛。据说它们比木妖跑得快，得当心。  红蜗牛 #a10421# |
| 1 | Red Snails have much higher endurance than Snails and Blue Snails. They also move faster than Stumps. I better not underestimate those sneaky creatures. | 红蜗牛的耐力比蜗牛和蓝蜗牛高得多，跑得也比木妖快。不能小看这些狡猾的家伙。 |

### 1043 — 梅的第三次训练

- **EN 名称**：Mai's Third Training
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | After coming back from hunting 5 Red Snails, Mai told me it's time for me to hunt even more powerful monsters. She then instructed me to hunt 3 Slimes and bring back 1 Squishy Liquid. \n\nSlime #a10431# #i4000004# #t4000004# #c4000004# /1 | 猎完 5 只红蜗牛回来后，梅说该去猎更强的怪物了。她让我猎 3 只绿水灵，带回 1 个绿水灵珠。  绿水灵 #a10431# #i4000004# #t4000004# #c4000004# /1 |
| 1 | After succesfully hunting Slimes, I obtained the Squishy Liquid and reported it to Mai. | 成功猎杀绿水灵后，我拿到了绿水灵珠并向梅汇报。 |

### 1044 — 梅的最后一次训练

- **EN 名称**：Mai's Last Training
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I defeated the Slimes and brought back the Squishy Liquid to Mai. She seemed to be impressed, and instructed me this time to hunt a really powerful monster. She then told me to hunt 2 Orange Mushrooms from inside the Training Center.\n\nOrange Mushroom #a10441# | 我打败了绿水灵，把绿水灵珠带给梅。她好像很满意，这次让我去训练场里猎一种很强的怪物。她让我猎 2 只花蘑菇。  花蘑菇 #a10441# |
| 1 | I was able to defeat 2 Orange Mushrooms and reported the result to Mai. | 我打败了 2 只花蘑菇，并向梅汇报了结果。 |

### 1045 — 巴里的考验

- **EN 名称**：Bari's Test
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | At the West Field of Southperry, Bari seems to be looking for me... | 在南港西郊，巴里似乎在找我…… |
| 1 | Bari told me he had been requested by Mai to test my skills, and instructed me to defeat the most powerful monster in Maple Island, Orange Mushroom, and bring back 1 Orange Mushroom Cap. \n\nOrange Mushroom #a10451# n#i4000001# #t4000001# #c4000001# /1 | 巴里说梅拜托他测试我的实力，他让我打败彩虹岛上最强的怪物——花蘑菇，并带回 1 个花蘑菇盖。  花蘑菇 #a10451# n#i4000001# #t4000001# #c4000001# /1 |
| 2 | I was able to defeat Orange Mushroom and bring back an Orange Mushroom Cap to Bari. This completed all of Mai's trainings. I think I'm now ready to take on the Victoria Island. | 我打败了花蘑菇，把花蘑菇盖带给了巴里。至此梅的训练全部完成。我想自己已经准备好前往金银岛了。 |

### 1046 — 比格斯讲金银岛见闻

- **EN 名称**：Biggs's Story on Victoria Island.
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I better go to Southperry and meet up with Biggs to learn more about Victoria Island, like Bari said. | 我最好去南港找比格斯，听他讲讲金银岛的事，就像巴里说的那样。 |
| 1 | Biggs told me the basics needed to learn more about Victoria Island, and advised me that everyone that has landed in Victoria Island from Maple Island needs to visit Olaf. Once I get to Victoria Island, I better head to Lith Harbor and meet up with Olaf. | 比格斯把了解金银岛需要知道的基础知识告诉了我，还说每个从彩虹岛来到金银岛的人都要去拜访奥拉夫。到了金银岛后，最好先去明珠港找奥拉夫。 |
| 2 | Olaf seemed genuinely happy to meet a new traveler, and told me if I needed any information on job advancements, he's the man to talk to. | 见到新来的旅行者，奥拉夫似乎打心底里高兴，还说如果我想了解转职的情报，找他准没错。 |

### 1048 — 职业推荐

- **EN 名称**：Job Recommendation
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | The Maple Administrator seems willing to lend me a hand on job selections... | 冒险岛管理员似乎很乐意在职业选择上帮我一把…… |
| 1 | I was still just getting my feet wet in this game, so the Maple Administrator decided to help select a job for me. | 我对这个世界还不太熟，于是冒险岛管理员决定帮我选一个职业。 |
| 2 | I was still just getting my feet wet in this game, so the Maple Administrator decided to help select a job for me. | 我对这个世界还不太熟，于是冒险岛管理员决定帮我选一个职业。 |

### 1049 — 成为战士

- **EN 名称**：Becoming a Warrior
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | The Maple Administrator told me that I may be best suited to be a Warrior. | 冒险岛管理员说我最适合当战士。 |
| 1 | The Maple Administrator told me she'll take me to Perion now to help me make the job advancement as a Warrior. | 冒险岛管理员说，现在带我去勇士部落，帮我完成战士转职。 |
| 2 | Should I go ahead and make the job advancement as a Warrior? | 我要直接去完成战士转职吗？ |

### 1050 — 成为魔法师

- **EN 名称**：Becoming a Magician
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | The Maple Administrator told me that I may be best suited to be a Magician. | 冒险岛管理员说我最适合当魔法师。 |
| 1 | The Maple Administrator told me she'll take me to Ellinia now to help me make the job advancement as a Magician. | 冒险岛管理员说，现在带我去魔法密林，帮我完成魔法师转职。 |
| 2 | Should I go ahead and make the job advancement as a Magician? | 我要直接去完成魔法师转职吗？ |

### 1051 — 成为弓箭手

- **EN 名称**：Becoming a Bowman
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | The Maple Administrator told me that I may be best suited to be a Bowman. | 冒险岛管理员说我最适合当弓箭手。 |
| 1 | The Maple Administrator told me she'll take me to Henesys now to help me make the job advancement as a Bowman. | 冒险岛管理员说，现在带我去弓箭手村，帮我完成弓箭手转职。 |
| 2 | Should I go ahead and make the job advancement as a Bowman? | 我要直接去完成弓箭手转职吗？ |

### 1052 — 成为飞侠

- **EN 名称**：Becoming a Thief
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | The Maple Administrator told me that I may be best suited to be a Thief. | 冒险岛管理员说我最适合当飞侠。 |
| 1 | The Maple Administrator told me she'll take me to Kerning City now to help me make the job advancement as a Thief. | 冒险岛管理员说，现在带我去废弃都市，帮我完成飞侠转职。 |
| 2 | Should I go ahead and make the job advancement as a Thief? | 我要直接去完成飞侠转职吗？ |

### 1053 — 成为海盗

- **EN 名称**：Becoming a Pirate
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | The Maple Administrator told me that I may be best suited to be a Pirate. | 冒险岛管理员说我最适合当海盗。 |
| 1 | The Maple Administrator told me she'll take me to The Nautilus now to help me make the job advancement as a Pirate. | 冒险岛管理员说，现在带我去诺特勒斯号，帮我完成海盗转职。 |
| 2 | Should I go ahead and make the job advancement as a Pirate? | 我要直接去完成海盗转职吗？ |

### 8000 — 新生活

- **EN 名称**：New Life
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I should go see Mai right now... | 现在该去找梅了…… |
| 1 | I better get Mai 10 Mushroom Spores, 10 Snail Shells, and 10 Red Snail Shells right now.\n#t4000011#  #c4000011#/10\n#t4000019#  #c4000019#/10\n#t4000016#  #c4000016#/10 | 我得马上给梅弄 10 个蘑菇孢子、10 个蜗牛壳和 10 个红蜗牛壳。 #t4000011#  #c4000011#/10 #t4000019#  #c4000019#/10 #t4000016#  #c4000016#/10 |
| 2 | I took care of the challenge Mai gave me. That was easy... | 我完成了梅给我的挑战。太简单了…… |

### 8020 — 尤娜的购物测验：开始

- **EN 名称**：Yoona's Quiz on Shopping : Start
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I should meet Yoona at Southperry for a little quiz! | 去南港找尤娜参加小测吧！ |
| 1 | There's a quest before the quiz starts. I better take care of that fast. | 在小测开始前还有一个任务。最好快点把它办完。 |
| 2 | I was able to safely obtain Beginner's Guide to Shopping at the Cash Shop. | 我顺利拿到了《新手购物指南（现金商城篇）》。 |

### 8021 — 尤娜的购物测验 1

- **EN 名称**：Yoona's Quiz on Shopping 1
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I better solve Yoona's 1st question on shopping. | 最好快点解开尤娜的购物测验第 1 题。 |
| 1 | What's the 1st question on Yoona's Quiz on Shopping? I have to remember if I want to get it right... | 尤娜购物测验的第 1 题会是什么呢？想答对就得记住…… |
| 2 | I learned something about expanding the inventory through Cash Shop.  I can store extra equipment and items using this method! | 我学到了用现金商城扩展背包的方法！用它可以存放更多装备和道具！ |

### 8022 — 尤娜的购物测验 2

- **EN 名称**：Yoona's Quiz on Shopping 2
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I better solve Yoona's 2nd question on shopping. | 最好快点解开尤娜的购物测验第 2 题。 |
| 1 | What's the 2nd question on Yoona's Quiz on Shopping? I have to remember if I want to get it right... | 尤娜购物测验的第 2 题会是什么呢？想答对就得记住…… |
| 2 | I learned something about avatar item equipment. I can obtain stylish decorations for my weapons, armor, face, hair at any time! | 我学到了时装道具的穿戴方法。随时都能给我的武器、防具、脸、发型换上时髦的装扮！ |

### 8023 — 尤娜的购物测验 3

- **EN 名称**：Yoona's Quiz on Shopping 3
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I better solve Yoona's 3rd question on shopping. | 最好快点解开尤娜的购物测验第 3 题。 |
| 1 | Almost halfway done! Time to solve question number 3! I have to get it right... | 快过半了！来解第 3 题吧！必须答对…… |
| 2 |  I learned something about expiration dates. I can move my cursor over my acquired items and view the expiration date, so I know when I have to change style or re-select it! | 我学到了道具的过期时间。把鼠标移到道具上就能看到过期时间，这样就能知道什么时候该换风格或重新挑选了！ |

### 8024 — 尤娜的购物测验 4

- **EN 名称**：Yoona's Quiz on Shopping 4
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I better solve Yoona's 4th question on shopping. | 最好快点解开尤娜的购物测验第 4 题。 |
| 1 |  I can see the light at the end of the tunnel--I'm nearly done! Time to solve question number 4! | 已经能看到终点的亮光了——快完成了！来解第 4 题吧！ |
| 2 |  I learned something about number of uses on an item. I can only use an item so such until it vanishes. At that point, I'll have to acquire another one if possible... | 我学到了道具的使用次数。道具用到一定次数就会消失，到那时就得再弄一个……如果还能弄到的话。 |

### 8025 — 尤娜的购物测验 5

- **EN 名称**：Yoona's Quiz on Shopping 5
- **auto**：无

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I better solve Yoona's last question on shopping. | 最好快点解开尤娜购物测验的最后一题。 |
| 1 | Last question. Gotta finish STRONG! | 最后一题。要漂亮地收尾！ |
| 2 |  I learned something about the restrictions regarding the weapon avatar items. This should help me navigate through the Cash Shop with no problem whatsoever! | 我学到了武器时装道具的限制。有了这些知识，逛现金商城肯定畅通无阻！ |

### 8031 — 保卫卢卡斯的农场

- **EN 名称**：Protect Lucas's Farm
- **auto**：L1残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 |  It seems like the snails around Amherst are causing great grief around the area because of their actions on the farm. How can I help solve this problem, perhaps I should talk to Lucas! | 阿姆赫斯特附近的蜗牛在农场里捣乱，给这一带带来很大困扰。要怎么帮忙解决这个问题呢？也许该去找卢卡斯谈谈！ |
| 1 | The snails around Amherst has been causing great damage to farms in the area, and Lucas is really counting on me to come through for them. I'll have to take them out! \n#o100100#  #a80311# \n#o100101#  #a80312# \n#o130101#  #a80313# | 阿姆赫斯特的蜗牛一直在破坏这一带的农场，卢卡斯非常指望我能帮忙。我得把它们解决掉！ #o100100#  #a80311#  #o100101#  #a80312#  #o130101#  #a80313# |
| 2 | The snails are gone! Hopefully this will protect the farms for a little bit. Too bad the Work Gloves Lucas gave me smelled like old bananas and fish...yuck!  | 蜗牛都不见了！希望这能保护农场一阵子。可惜卢卡斯给我的工作手套闻起来像烂香蕉和鱼……恶心！ |

### 8142 — 托德的狩猎教学

- **EN 名称**：Todd's How-to-Hunt
- **auto**：L0残留内容标记

| # | EN（进度行） | ZH |
|---|---|---|
| 0 | I hear #p9101002# can teach us how to hunt. | 听说 #p9101002# 会教我们怎么狩猎。 |
| 1 | #p9101002# taught me to move towards upper right-hand side to attack by pressing Ctrl and kill 1 x #o9409000# and 1 x #o9409001#,  then talk to #p9101001#... \n\nTutorial Leatty #a81421#\nTutorial Drumming Rabbit #a81422#\n#t4000300# #c4000300#/1\n#t4000301# #c4000301#/1 | #p9101002# 教我向右上方移动、按 Ctrl 攻击，杀掉 1 只 #o9409000# 和 1 只 #o9409001#，然后去找 #p9101001#……  教学莱提 #a81421# 教学打鼓兔 #a81422# #t4000300# #c4000300#/1 #t4000301# #c4000301#/1 |
| 2 | As #p9101002#'s taught me, I hunted down the monsters. | 按 #p9101002# 教的，我猎掉了那些怪物。 |

### maple-road-training — 训练营任务确认

- **EN 名称**：Training Camp Check
- **auto**：无

- **日志文案 log**：
  - EN：Sera asked you to let Heena confirm your training record before you leave the camp.
  - ZH：赛拉让你在离开营地前，先让希娜确认你的训练记录。

