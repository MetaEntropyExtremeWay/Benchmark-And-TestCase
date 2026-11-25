# mc 检索直测 bench（受测对象 = mc 记忆服务检索面）

无答题/判分 LLM、无宿主依赖（向量化仍需 mc 仓配置的 embed 凭据）：`prepare` 把题集
pack 的 records 直灌 mc（一条 record = 一条记录，机械可复现；对话集由 adapter 预先
转成 records，非对话语料同样能灌），`recall` 用**题面原句**当探针（无模型参与），本地
算金标证据级 recall@k 与准入门槛效果。灌库与直测对同一条座标公式（`shared/coords.ts`
单源）——对不上 = 直测看不见库。

## 流程（以随仓 lme 数据集为例）

```powershell
shared\scripts\mem-bench-app.ps1 start -Dataset lme            # 8081 / lmg_mem_bench_lme（start 只建库不清库；重灌用 reset）
npx tsx mc/prepare.ts --run <runId> --dataset lme              # 直灌 + 向量化排空 + 串台验收
npx tsx mc/recall.ts --run <runId> --dataset lme               # recall@k 读数
```

`--dataset lme|locomo` 选题集 pack（即 datasets/ 里注册的 adapter）；两步的 dataset
须一致（recall 会与 prepare manifest 交叉校验）。

## 机制

- **prepare**：每题独立 context（cwd 哈希座标，条目 kind = `is` 原文信息条目），只灌该题
  scope 内的 records（adapter.questionRecords 过滤），灌完等向量化排空
  （`BENCH_MC_DRAIN_MS` 预算，千级条目 ≈ 分钟量级、全量可到小时级），然后**串台验收**——
  每题检索 topk10 命中的计分单元键（adapter.hitKey）必须**全部**落该题 scopeKeys 内。
  判据依据：直灌库的每一条内容都来自该题 scope，命中越界 = 写入座标错位（几何不变量
  被破坏），一票否决而非统计口径；越界即报错退出并指认越界单元。
- **recall**：探针 min_score=0 拿门槛前候选、reinforce=false 不污染排序；本地按 rank
  前缀算金标单元级 recall@k 阶梯（5/10/16/32），并按真实准入门槛（证据分 ≥ minScore
  或 词项命中 ≥ minMatched）复算门槛后对照轨。
- **clean**（域内清场）：按 ingest 指纹（题集 pack + 灌库链代码）决定库是否重置；
  `--reset-db` 强制重置。

## 产物

- `output/<dataset>/<runId>/recall.md`——人读表（run 根）：recall@k 阶梯 / 门槛前后对照 /
  降级告警。
- `output/<dataset>/<runId>/data/recall.json`——结构化逐题行（机器面）。
- `output/<dataset>/<runId>/data/prepare.json`——prepare manifest（每题 contextId / ops 数 /
  串台验收结果）。

## 读数口径

金标单元键由数据集 adapter 定义（对话集 = 会话键）；`recallFull` 与 @32 的差 = topk
预算外的金标；`outOfScope` 非空 = 跨题泄漏（隔离失效信号）。干扰单元计数（题域内非金标
单元进 top-k）是正常读数——信息底座的噪声本来就是考题的一部分。
