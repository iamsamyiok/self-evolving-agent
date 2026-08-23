# self-purify-agent

**自净化全自动进化 AI Agent —— 零依赖 Node.js MVP**

实现《自净化全自动进化AI Agent系统开发指导书（Node.js 生产级）v2.0》第 11.1 节第一阶段：基础自净化最小可用版本。

- **零依赖**：纯 Node.js ≥22.13（node:sqlite + 原生 fetch + readline），无 node_modules
- **双闭环**：任务 → 进化沉淀（技能/记忆/经验）→ 定时净化（检测→复核→隔离→留痕）
- **不误杀**：Wilson 置信下界评分 + 最小证据 n≥5 + 48h 免疫期 + 迟滞带 + 变更率上限
- **可回滚**：一切删除走软删隔离区（30 天 TTL）+ 快照前置 + 净化全程留痕 + 墓碑反再生

## 快速开始

```bash
# 1. 配置 LLM（OpenAI 兼容任意后端：DeepSeek / 智谱 / 自建…）
#    编辑 config/local.json（已 gitignore）：
#    { "LLM_API_KEY": "sk-...", "LLM_BASE_URL": "https://api.deepseek.com/v1", "LLM_MODEL": "deepseek-chat" }

# 2. 交互模式
node tui.js

# 3. 离线演示（零 API 成本，完整跑通 任务→进化→脏数据注入→净化→回滚）
SPA_MOCK=1 node app.js --demo        # Windows PowerShell: $env:SPA_MOCK="1"; node app.js --demo

# 4. 测试（30 项，含脏数据注入净化验收）
npm test
```

## 架构（对应指导书 9 层架构的 MVP 裁剪）

```
tui.js / app.js                 入口（交互 / 无头）
service/evolve-purify-loop.js   双循环调度：任务 P0 → 进化 P1 → 净化 P2（定时 ±20% 抖动、背压降频）
core/agent-executor.js          L6 执行内核：上下文装配（先预算后填充）→ 规划 → 分步 → 判定 → 轨迹落库
core/skill-system.js            技能：提炼 → DRAFT → 黄金集门禁 → ACTIVE → 热度分级（生成即上线被禁止）
core/memory-system.js           记忆：抽取 → 去重 → 冲突消解(supersede链) → 三级分层 → 遗忘曲线
core/experience-engine.js       经验：复盘 → 证据链强制（防幻影经验）→ 失败归因 → 合并迭代
core/purify-center.js           L7 净化中枢：检测→复核→隔离→留痕（+TTL清扫→墓碑）；安全五原则
core/llm-adapter.js             L2 适配层：OpenAI 兼容、重试退避、熔断、JSON 容错管线、判定器双采样
core/store-base.js + store/     L8 底座：node:sqlite、状态机、乐观锁、互斥租约、快照、墓碑
core/auto-control.js            L9 观测：心跳、日预算降级、事件日志
utils/                          Wilson/BM25/解析/Token 预算（评分公式唯一实现，禁各模块另写）
```

## 关键安全机制（指导书红线落地）

| 机制 | 实现 |
|---|---|
| Wilson 下界评分 | `utils/stats.js`——1 次全成功仅 0.20，小样本天然保守 |
| 最小证据 n≥5 | 质量类淘汰必须 n≥5；n<5 只降权不删除 |
| 免疫期 48h / 冷却期 24h | `purify-center.verify()` 双重校验 |
| 软删隔离区 | 一切删除先 QUARANTINED，30 天 TTL，`restore` 一键恢复 |
| 变更率上限 | 单周期 ≤5%、单日 ≤20% 活性实体（小系统保底 1） |
| 快照前置 | 有实质变更候选即 VACUUM INTO + SHA-256 登记 |
| 墓碑反再生 | 硬清除内容登记 token 集，进化侧生成前必查（相似度 ≥0.90 拦截） |
| 判定器双采样 | judge 两次采样不一致 → 弃权不动作（LLM 永不单点裁决破坏性操作） |
| 净化留痕 | 先写 purge_logs（判定依据/prev_state）再执行变更，永不自动清理 |
| 崩溃恢复 | 重启扫描 EXECUTING 日志自动收尾（DONE / ROLLED_BACK） |

## TUI 命令

```
task <任务>       执行任务          status          系统状态
skills/memories/experiences  列实体  purify [deep]   立即净化
restore <id>      隔离区恢复        logs [n]         净化留痕
golden list|add   黄金任务集        snapshot         手动快照
usage             token 用量        demo             MOCK 演示
```

## 配置项（config/index.js）

阈值均带 `[下界, 上界]` 安全边界（自动调参只允许界内）。环境变量：`SPA_API_KEY / SPA_BASE_URL / SPA_MODEL / SPA_DATA_DIR / SPA_MOCK`。

## 测试

```bash
npm test   # 30 项：Wilson/BM25/解析器/状态机/乐观锁/MOCK 端到端/脏数据注入净化（精确率≥90%、召回率≥90%）
```

## 与 v2.0 指导书的差异（MVP 有意裁剪）

- 净化管线实现 ①②③⑤ 步；④ EXECUTE（修复/合并）与 ⑥ REVIEW 属第二阶段
- 净化维度：记忆 + 经验 + 数据（技能/策略/风险净化属第二阶段）
- Embedding：BM25 关键词检索（三级降级第 2 档），本地 ONNX 向量属第三阶段
- 成本护栏：仅日预算降级（三层熔断全套属第二阶段）
- 沙箱/安全宪法/多 Agent/可视化面板：第三阶段

## 已知提示

- Node 22 会打印 `ExperimentalWarning: SQLite is an experimental feature`——node:sqlite 在 22.13+ 已无 flag 可用，Node 24 起稳定，可忽略
