# mc / lmg benchmark

对 **mc（记忆服务）** 与 **lmg（编排全家）** 两个系统的长时记忆能力评测 harness。
**数据集可插拔**（adapter 架构，零对话形态假设）；随仓带 [LongMemEval-S](https://arxiv.org/abs/2410.10813) 126 题冻结子集作为示例数据集与基线（见 [docs/baseline.md](docs/baseline.md)）。两条评测线：

- **lmg 产品链**（主口径）——测整套编排系统：语料经产品 replay 真实写链灌库（含收尾提炼与晋升）→ pg 快照冻结 → 答题（注入面 + 检索工具的完整产品读面）→ 双轨判分（语义 rubric + LongMemEval 官方模板）→ 读数汇总。
- **mc 检索直测**——单测记忆服务检索面：零答题/判分 LLM 直灌 records → 题面原句探针 → 金标证据级 recall@k 阶梯与准入门槛效果。

## 目录

```
frozen/     随仓示例数据集的冻结清单（lme-126.json：126 个 LongMemEval-S question_id）
datasets/   数据集 adapter（接口定义 / 对话形态公共件 / lme 与 locomo 两个示例 / 注册表）——
            加新数据集在此落文件 + 注册，shared/ 零改动
data/       gitignored：download.ps1 下载的官方数据集 + extract.ts 产出的运行时题集 pack
shared/     复用层（零数据集形态词汇）：pack 契约与加载（pack）/ 座标契约单源（coords）
            / mc HTTP 客户端（mem）/ 判分纯面（judge-core、judge-official-core）
            / 题面契约（prompt）/ 快照复位（snapshot）/ lmg daemon 起停（daemon）
            / 脚本（download.ps1 / extract.ts / mem-bench-app.ps1）
lmg/        lmg 产品链驱动：formation（灌库）/ qa（答题）/ judge-qa（判分）/ readout（读数）
            / row-time（原文行时刻机制面）
mc/         mc 检索直测线：prepare（直灌 + 串台验收）/ ingest（records → ops）/
            recall（recall@k）/ clean（域内清场 + 库指纹）
docs/       protocol.md（评测协议 + pack 契约）/ baseline.md（基线读数与复现配方）
test/       单测（vitest）
output/     gitignored：运行产物 output/<dataset>/<runId>/
```

## 术语

- **mc** = 记忆服务（产品）；**lmg** = 编排全家（daemon + kernel + exo 整套，产品）。
  harness 驱动的就是这两个产品的运行形态；仓根目录名以两仓实际克隆名为准（见前置）。
- **两条评测线**：mc 直测线（环境键 `BENCH_MC_*`，实例端口 8081/8082）与 lmg 产品链线
  （环境键 `BENCH_LMG_*`，实例端口 8084/8085，产物树 `output/<dataset>/chain/`，座标
  `/root/bench-<dataset>-<qid>`）——`mem-bench-app.ps1 -Dataset <ds> -Line mc|lmg` 起对应
  实例。两线各自独立实例与库，跨线坐标互斥（config 硬门）。
- **数据集接入（adapter 架构）**：harness 不锁数据集、也不假设对话形态——核心层只有
  通用 records（key / date / text 任意记忆条目）与题目的 gold/scope 单元键；对话只是
  adapter 形态之一。**加一个数据集 = `datasets/` 下建 `<name>.ts` 实现 DatasetAdapter
  （照 lme.ts / locomo.ts）+ registry.ts 注册一行，shared/ 零改动**（pack 契约细节见
  [docs/protocol.md](docs/protocol.md)「题集 pack 契约」）。判分官方轨为 LongMemEval 口径，
  是否适用由 adapter 声明（judgeTracks）；非对话语料走 mc 直测线全链（lmg 链的产品
  replay 只消费对话形态语料——产品边界，不是 harness 限制）。
- **契约面**：harness 对记忆服务的全部调用收在 `shared/mem.ts`（contexts 建 / doc 批量写 /
  search（min_score / reinforce / clusters 语义参数）/ health / verbatim 批量写 / deep 检索）。
  端点与响应字段语义的权威定义在 mc 仓文档；要用另一套记忆服务跑 harness，兼容实现需
  覆盖这些调用面。

## 快速开始（以随仓 lme 数据集为例）

前置（缺一项 fail-loud 时按报错修即可；报错自带修法）：

- Node 22+（harness 自身）；Java + `JAVA_HOME`（起 mc 服务 jar 用）
- **mc 仓与 lmg 仓的本地克隆**（构建产物与运行时依赖都在那两仓，从对应产品发布渠道获取；
  mc 服务版本需 ≥ 0.9.79——verbatim 读面与聚团附带在此之后）
- mc 仓内完成：`mvn package`（jar）、dev PG 就绪（127.0.0.1:5433，用户 lmg，
  mc 仓 dev\pg 布局）、embed 供应商凭据已按 mc 仓 `scripts/env.ps1` 配好（向量化必需）
- lmg 仓内完成：依赖安装（node_modules）、其 `.env` 的 LLM 配置（答题宿主运行时模型）
- 判分用 LLM key（`BENCH_LLM_API_KEY`，与答题模型可不同）

```powershell
# 0) 配置
cp .env.example .env        # 填 BENCH_LLM_API_KEY（judge 用）；仓根探测不到时填 BENCH_MC_ROOT / BENCH_LMG_ROOT
npm install

# 1) 数据：官方 LongMemEval-S（MIT）→ 冻结子集 pack
powershell -File shared/scripts/download.ps1     # 下载 longmemeval_s_cleaned.json 到 data/
npx tsx shared/scripts/extract.ts                # 抽 126 题 → data/lme-pack.json（确定性）

# 2) lmg 产品链（主口径全链）
shared\scripts\mem-bench-app.ps1 start -Dataset lme -Line lmg   # 链线专用 mc 实例（8084）；start 只建库不清库——重灌用 reset
npx tsx lmg/formation.ts --dataset=lme --verify           # 真实写链灌库（LLM 收尾，小时级；可 --limit-q 冒烟）
npx tsx shared/snapshot.ts --dataset=lme --snap           # 库快照 → output/lme/chain/snapshots/<时间戳>.dump
npx tsx lmg/qa.ts --dataset=lme --arm=default             # 答题（每题一个 lmg 宿主进程；小时级）
npx tsx lmg/judge-qa.ts --dataset=lme --arm=default       # 双轨判分（LLM）
npx tsx lmg/readout.ts --arm=default                      # 人读汇总 → chain/qa/default/readout.md
# 第二臂（deep）：先复位库再跑，防跨臂污染——
npx tsx shared/snapshot.ts --dataset=lme --restore=output/lme/chain/snapshots/<dump 文件>
npx tsx lmg/qa.ts --dataset=lme --arm=deep
npx tsx lmg/judge-qa.ts --dataset=lme --arm=deep
# 复位对账：restore 后库态 ≠ 快照即拒跑（全表指纹自动核对）

# 3) mc 检索直测（无答题/判分 LLM；向量化排空为分钟~小时级）
shared\scripts\mem-bench-app.ps1 start -Dataset lme       # 直测实例（8081）
npx tsx mc/prepare.ts --run mc-r1                          # 直灌 + 串台验收
npx tsx mc/recall.ts --run mc-r1                           # recall@k 读数 → run 根 recall.md
```

判分模型与答题模型都钉进产物（judge.json / qa-state）——换模型即换口径，可比性以同
模型为前提。对外读数引用**官方判分轨**（见 docs/protocol.md「判分」）。

## 基线

随仓示例（lme-126）的基线读数见 [docs/baseline.md](docs/baseline.md)：主口径读数、底座配方（formation manifest 事实）、模型钉与噪音声明。新数据集按 protocol 契约接入后，同口径产出自己的基线。

## 协议

见 [docs/protocol.md](docs/protocol.md)：题面契约、题集 pack 契约（接入第三方数据集）、判分双轨、跨臂污染三重控制、底座 policy、座标几何。
