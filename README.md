# Benchmark-And-TestCase

对两个系统的长时记忆能力做基准评测的资产（数据集可插拔）：

- **mc** = 记忆服务；**lmg** = 编排全家（daemon + kernel + exo 整套）。
  harness 驱动的是两个产品的真实运行形态——写链灌库、注入面答题、双轨判分。
- `benchmark/` — 评测 harness：数据集可插拔（adapter 架构、零对话形态假设）+ 两条评测线
  + 双轨判分；随仓带 LongMemEval-S 126 题示例与基线。入口：[benchmark/README.md](benchmark/README.md)。
- `testcase/` — 功能测试用例（与 benchmark 的冻结题集是两回事）。

License: [MIT](LICENSE)。
