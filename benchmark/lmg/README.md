# lmg 产品链 bench（受测对象 = lmg 编排全家）

与 `mc/` 的分野：mc 侧单测记忆服务检索面（直灌 + recall@k，零答题 LLM）；本目录测
**lmg 整套**——语料经产品 replay 真实写链灌库（verbatim 原文直存 + auto 捕获 + closeout
晋升，收尾评估在 daemon 收尾 worker），答题走产品完整读面（ambient + results 双区注入 +
检索工具 / 深检索）。

**形态边界**：产品 replay 只消费对话形态语料——本链要求 pack 带 conversations 扩展
（对话 adapter 自动提供）；非对话语料走 mc 直测线全链。

## 全链

```
formation.ts   灌库：每题一 project（/root/bench-<dataset>-<qid>）→ 源对话各一 session 子节点，
               逐对话 spawn 产品 replay（题内 date 串行、题间 --jobs 并行）；--verify 断言
               verbatim / 捕获 / 晋升三层可见性；幂等重入（进度账本 done 跳过）
snapshot.ts    库快照 / restore / 全表指纹（shared/，formation 冻结底座 → 每臂前复位）
qa.ts          答题：每题一个 lmg 宿主进程（pipe 折单行题面 + stdin 应答 ask_user + EOF 收口）；
               臂 = default（原文读面区宽 32）/ deep（深检索 + 显式意图行）
judge-qa.ts    判分：语义轨（judge-core rubric）+ 官方轨（LongMemEval evaluate_qa 模板）
               双轨一次跑两份；官方轨适用面由数据集 adapter 声明（judgeTracks——非对话
               数据集语义轨单轨）；弃权机械判错、超时/进程死不判单列
readout.ts     读数：qa-state + 判分产物 → readout.md（总览 / 分题型 / 错题 / 逐题速览）
row-time.ts    原文行时刻机制面（--row-time=source：把原文行时刻改回源对话日期——
               时序类题目的公平性开关；命名管道租约保证同库同时只许一轮）
```

## 跨臂污染三重控制

1. 每臂前 `snapshot.ts --restore` 复位库；
2. 答题会话不收尾（closeout 缺省关、stdin EOF 即退）；
3. 答题期 daemon 收尾 worker 关（qa 起 daemon 时显式 off——答题期不得消费/晋升）。

## 前置与顺序（以随仓 lme 数据集为例）

```powershell
shared\scripts\mem-bench-app.ps1 start -Dataset lme -Line lmg    # 8084 / lmg_mem_bench_lme_chain（start 只建库不清库；重灌用 reset）
npx tsx lmg/formation.ts --dataset=lme --verify
npx tsx shared/snapshot.ts --dataset=lme --snap
# 第一臂（快照即臂态，直接跑）：
npx tsx lmg/qa.ts --dataset=lme --arm=default
npx tsx lmg/judge-qa.ts --dataset=lme --arm=default
npx tsx lmg/readout.ts --arm=default
# 第二臂起：先复位库（跨臂污染三重控制之一），再跑同一组——
npx tsx shared/snapshot.ts --dataset=lme --restore=output/lme/chain/snapshots/<时间戳>.dump
npx tsx lmg/qa.ts --dataset=lme --arm=deep
npx tsx lmg/judge-qa.ts --dataset=lme --arm=deep
npx tsx lmg/readout.ts --arm=deep
```

- 快照 dump 缺省落 `output/<dataset>/chain/snapshots/<时间戳>.dump`（旁带 `.fingerprint.json`）；
  restore 后全表指纹自动对账，库态 ≠ 快照即拒跑。
- 臂前置态自检：跑臂前想核库是不是预期态，`npx tsx shared/snapshot.ts --dataset=lme
  --fingerprint` 出当前指纹与快照指纹比对，一致才开跑（formation/qa 都是小时级，跑错
  状态代价高）。

座标公式单源 `shared/coords.ts`（armCwd / benchProjectId / qaSession）——灌库侧与答题侧
必须算出同一字符串，分根 = 池分家。
