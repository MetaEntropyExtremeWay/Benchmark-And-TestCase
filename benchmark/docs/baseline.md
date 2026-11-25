# 基线：126 题主口径读数

> 2026-11-21 run。本文是复现配方 + 当次读数；重跑对照以本文配方为锚。
> **对外引用一律用官方轨**（LongMemEval 官方模板判分，见 protocol.md「判分」）——
> 语义轨是严格对照口径（弃权判错 + F1 ≥ 0.6 硬线），与官方轨不可直比。

## 读数

| 臂 | 判分轨 | 读数 |
|---|---|---|
| **default**（原文读面区宽 32） | **官方轨（主口径）** | **112 / 126 = 88.9%** |
| default | 语义轨（严格对照） | 22 / 126（两轨口径不同，不与上列直比——弃权判错 + F1 硬线使严格轨分数远低，属口径差而非运行异常） |
| deep（深检索 + 显式意图行） | 官方轨 | 101 / 110 = 91.8%（16 题额度窗耗尽未答完，分母不含未判） |

分题型（default / 官方轨）：single-session-user 70 题（含 6 弃权题全对）、multi-session 56 题。
错题清单与逐题速览见 run 产物 `chain/qa/<arm>/readout.md`（judge-qa + readout 生成）。

**已知偏置披露**：答题模型与 judge 模型同族（均 glm-5.3）——self-judging 同族偏置是
已知面；官方轨模板照抄官方、判读规则（contains-yes）不修，跨报告对照以同 judge 模型
为前提，换 judge 模型即换口径。

## 底座配方（formation manifest 事实）

| 键 | 值 |
|---|---|
| 题集 | frozen/lme-126.json（126 题，slots 总数 6047，金标全部在库） |
| tsMode | false（原文行时刻 = 回放时刻；时序桶不在本子集，失真不触及） |
| 数据集 | LongMemEval-S 官方文件按清单确定性抽取 |
| 实例 | 8084 / `lmg_mem_bench2_lme`（bench 专用，verbatim scope=auto + 锁 + GC 关） |
| 写链 | 产品 replay 真实链（verbatim 直存 + auto 捕获 + closeout 晋升 + daemon 收尾 worker 8路×5s） |

## 模型钉

| 面 | 值 |
|---|---|
| 答题模型 | glm-5.3（lmg 宿主运行时配置） |
| judge 模型 | glm-5.3（BENCH_JUDGE_MODEL） |
| 判分模板 | 语义轨 promptVersion=v2（F1 阈值 0.6）+ 官方轨 official-evalqa-r1（本 run 判分用 r0 模板：弃权模板句尾多一词 "response"，与官方 evaluate_qa.py 逐字对账后校正为 r1——影响面限 6 道弃权题的官方轨判定；重判离线零答题成本，对本 run 产物树重跑 judge-qa 即可） |

## 噪音与边界

- formation / 答题 / 判分都含 LLM 环节——单题翻转在噪音带内；本表读数是单 run 快照，
  复现按 [protocol.md](protocol.md) 配方重建底座后同臂对照。
- deep 臂 16 题因 LLM 额度窗耗尽未答完（quotaHit 记录在 qa-state），分母只含已判题——
  完整对照须补跑后重判。
- default 臂的读面区宽 32 是 bench 校准宽度（产品缺省更窄）；把它当产品开箱读数引用时
  须注明该配置。
