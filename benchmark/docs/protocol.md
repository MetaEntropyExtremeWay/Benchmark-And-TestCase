# 评测协议

本文描述 harness 的评测口径：题面怎么构造、库怎么灌、答案怎么判、污染怎么防。
所有机制的单源代码位置随文标注。

## 题集

harness 不锁基准：**数据集 = adapter**（datasets/registry.ts 注册），核心层零形态假设。
本节先给通用契约，再列随仓示例。

### 题集 pack 契约（所有数据集，含第三方接入）

运行时题集 pack = `data/<dataset>-pack.json`（gitignored）：`shared/scripts/extract.ts`
经 adapter 从原始文件确定性抽取（无随机、按官方文件序、records 按首现序）——同输入
必同输出；pack 结构 fail-loud 校验（count 对账、id 唯一、goldKeys ⊆ scopeKeys）。

**record = 任意记忆条目（key / date / text 三件事）**，题目的 goldKeys / scopeKeys 是
**计分单元键**（adapter 定义其粒度——对话集 = 会话键，文档集 = 文档键…）。跑全链需要：

```jsonc
{
  "source": "…",
  "count": 126,
  "questions": [{ "id", "dataset", "question", "goldAnswer", "goldKeys", "scopeKeys", "categoryLabel", "questionDate?", "hint?" }],
  "records":  [{ "key", "text", "date?", "meta?" }],
  "conversations?": [{ "key", "date?", "turns": [{ "speaker", "text" }] }]  // 可选：对话扩展（lmg 链 replay 线专用）
}
```

- **加数据集**：`datasets/` 下建 `<name>.ts` 实现 `DatasetAdapter`（buildPack /
  questionRecords / hitKey / judgeTracks）+ registry.ts 注册一行——shared/ 零改动。
- **形态边界**：mc 直测线吃任意 records（非对话语料走这条线全链）；lmg 链写线走产品
  replay，只消费对话形态（conversations 扩展），这是产品输入形状不是 harness 限制。
- **键系约定**：对话 adapter（datasets/dialogue.ts）单源——record.key = `<convKey>#<n>`、
  record.meta.conversation = 会话键（= gold 单元键）、meta.sid = 命中计分键。

### 随仓示例：LongMemEval-S 126

- 基准 = [LongMemEval-S](https://arxiv.org/abs/2410.10813)（MIT）；冻结子集 =
  `frozen/lme-126.json`（126 个 question_id：70 single-session-user 含 6 道弃权题 `_abs`、
  56 multi-session）。
- gold 单元 = 会话键（scope = answer ∪ haystack；gold ⊆ scope——答案会话是语料本体，
  剥了它任何读面只能答不知道）；含弃权题（`_abs`），判分走官方 unanswerable 模板。

## 题面契约

单源 `shared/prompt.ts` `basePrompt`：

```
[Question date: <提问时刻>]
[官方 hint 原样透传]

<问题原文>

End your reply with a final line in exactly this format:
FINAL_ANSWER: <your answer>
```

- 中性措辞、不带任何语料内容——「金标不进题面」由构造面保证（语料只经灌库 / 注入面供给）。
- lmg 链答题把题面**折单行**喂 pipe（一行一回合）；FINAL_ANSWER 抽取取末次命中
  （占位示例排除；契约字面缺席时认备式标记「最终答案 / final answer」行首形态，
  抽出记 answerVia=fallback 判分照常留痕）。

## 灌库（formation）

- 语料 = 每题 scope **全量（含金标对话）**——对话基准协议 gold ⊆ scope，答案对话是
  语料本体，剥了它任何读面只能答不知道。formation manifest 记 goldIncluded，=0 的题读数无效。
- 写链 = 产品现成 replay 子命令（逐轮 verbatim 直存 + auto 捕获 + closeout 晋升入队），
  收尾评估在 daemon 收尾 worker——测的是真实写链，不做旁路直灌。条目 kind = `is`
  （原文信息条目——mc 服务的条目类型里 bench 直灌/写链产物只用这一种；`defn` / `funcall`
  为服务端其他条目类型，bench 不产生）。
- 几何：每题一 project `/root/bench-<dataset>-<qid>`（一题一「用户」记忆域，跨题零串台）→ 源会话
  按时序各一 session 子节点。座标公式单源 `shared/coords.ts`，灌库侧与答题侧必须算出
  同一字符串。
- **ts policy**：缺省 `--ts` 关——verbatim 行时刻 = 回放时刻（全体等新）。开启会把 verbatim
  行源时钟与晋升条目灌库时钟造成混钟态；全等新是单一失真源、臂间一致，更好判读。
  时序类题目的专项对照走 `qa.ts --row-time=source`（机制面 `lmg/row-time.ts`）。
  免责：LongMemEval 官方口径带源时间戳，ts=off 时时序题的应答条件与官方不同——
  随仓示例（lme-126）不含 temporal-reasoning 桶（见 baseline.md），该失真不触及该示例读数。
- 排空判据（库级）：outbox / verbatim 队列 pending=0 + 收尾事件全落定 + unevaluated
  清空 + 条目向量全落定（向量没落定的行检索读不到，快照带 pending 行会被 restore 后的
  embed 轮询续写——所以排空是快照的前置）。

## 快照与复位

`shared/snapshot.ts`：pg_dump 自定义格式 → restore = 停实例 → dropdb → createdb →
pg_restore → 起实例。全表指纹（逐表 count + 全行 md5，时间衰减活字段屏蔽）保证 restore 后
库态 ≠ 快照即拒跑——**每臂前 restore** 是跨臂污染控制的第一重。

## 判分

双轨一次跑两份（`lmg/judge-qa.ts`），判分模型钉进产物：

1. **官方轨（对外主口径）**：LongMemEval 官方 `evaluate_qa.py` 五个模板逐字照抄
   （`shared/judge-official-core.ts`，与官方仓库原文逐字对账），分题型宽容条款
   （temporal off-by-one 等）+ contains-yes 判读，照抄不修；弃权题（`_abs`）走官方
   unanswerable 模板。**适用面由数据集 adapter 声明**（lme = official + semantic；
   locomo 等非 LongMemEval 口径数据集仅语义轨）。对外引用读数一律用此轨——
   对齐该口径的数据集可与其他 LongMemEval 报告对照。
2. **语义轨（严格对照口径）**：自研 rubric「盲三元组」（judge 只见题面 / 金标 / 一份
   匿名预测——不知道答题方与臂，剥掉身份指纹）+ token-F1 ≥ 0.6 机械对照轨
   （`shared/judge-core.ts`）；弃权判错、开放回答按 F1 硬线——比官方轨严得多，读数
   不可与官方轨直比，用途是**同 run 内跨臂/跨版本的严格横比**。提示词改动 = 判分口径
   改动，必须 bump 版本并对存量重判。

判分模型与答题模型可能同族（见 baseline.md 的披露）；换 judge 模型即换口径。分母纪律
两轨一致：**弃权 / 抽不出答案行 → 机械判错**；超时 / 进程死（无答案）不判、单列（不进
分母）。双轨对照（agree / flip）随 judge-official.json 记录——语义轨读数只与同轨读数比。

## 跨臂污染三重控制

1. 每臂前 snapshot restore 复位库；
2. 答题会话不收尾（closeout 缺省关、stdin EOF 即退）；
3. 答题期 daemon 收尾 worker 关（答题期不得消费 / 晋升任何写入）。

## 复现与噪音声明

- **底座不可逐位复现**：formation 走真实 LLM 写链，重灌 = 不同的库内容（收尾生成的方差）。
  可比性靠「同配方重建 + 快照指纹钉扎」：同 frozen 清单、同 ts policy、同排空判据，重建
  底座后各臂在同一快照上分头跑。
- 答题与判分都是 LLM——单题翻转在噪音带内；结论以 run 级聚合读数为准，敏感结论须复跑
  验证（模型温度非 0）。
- 模型钉：答题模型由 lmg 仓运行时配置决定，judge 模型 = BENCH_JUDGE_MODEL——两者都进
  产物记录；跨 run 对比必须同模型。
