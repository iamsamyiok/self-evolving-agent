# self-purify-agent

**自净化全自动进化 AI Agent —— 功能完整版（零依赖 Node.js）**

完整实现《自净化全自动进化AI Agent系统开发指导书（Node.js 生产级）v2.0》第一~三阶段：双闭环自进化/自净化、六维净化、六步净化管线、反振荡全套、安全宪法与工具沙箱、三层预算熔断、自动调参、看门狗、可视化面板、多 Agent 集群。

- **零依赖**：纯 Node.js ≥22.13（node:sqlite + 原生 fetch + readline + node:http），无 node_modules
- **双闭环**：任务 → 进化沉淀（技能/记忆/经验）→ 净化（检测→复核→隔离→执行→留痕→复审）
- **不误杀**：Wilson 置信下界 + 最小证据 n≥5 + 48h 免疫期 + 迟滞带 + 变更率上限 + 复审翻案率度量
- **不失控**：三层 token 预算熔断、安全宪法红线、工具沙箱、墓碑反再生、对抗计数、稳态断言、自动回滚

## 快速开始

```bash
# 1. 配置 LLM（OpenAI 兼容任意后端）——编辑 config/local.json（已 gitignore）：
#    { "LLM_API_KEY": "sk-...", "LLM_BASE_URL": "https://api.deepseek.com/v1", "LLM_MODEL": "deepseek-chat" }

# 2. 交互 TUI
node tui.js

# 3. 离线演示（零 API 成本）：任务→进化→注脏→净化→回滚→沙箱拦截
SPA_MOCK=1 node app.js --demo        # PowerShell: $env:SPA_MOCK="1"; node app.js --demo

# 4. 服务模式（HTTP 任务接口 + 可视化面板）
node app.js --serve                  # 面板 http://127.0.0.1:3790 · 任务接口 :3791/api/task

# 5. 生产守护（看门狗：心跳停滞/崩溃自动重启，24h 重启>3 次熔断）
node app.js --watchdog

# 6. 多 Agent 集群（N 个独立 worker，能力路由 + 共享池提案门禁 + 全局墓碑）
node app.js --cluster 3

# 7. 测试（69 项：含沙箱逃逸/预算熔断/技能净化/复审翻案/对抗冻结/面板对账/集群冒烟/语义检索性能）
npm test
```

## 架构（指导书 9 层全实现）

```
tui.js / app.js / worker.js      入口（TUI / 无头+服务+看门狗+集群 / 集群工作进程）
service/evolve-purify-loop.js    双循环调度：任务P0→进化P1→净化P2（±20%抖动、背压、每日深度净化）
core/agent-executor.js           L6 内核：上下文装配→规划→分步(工具+红线)→判定→轨迹；黄金门禁
core/skill-system.js             技能：提炼→DRAFT→门禁→ACTIVE→热度；墓碑拦截；版本对决
core/memory-system.js            记忆：抽取→去重→冲突消解→分层→遗忘曲线
core/experience-engine.js        经验：复盘→证据链强制→失败归因→合并迭代
core/purify-center.js            L7 中枢【核心】：六步管线全量 + 六维净化 + 反振荡 + 复审
core/llm-adapter.js              L2：OpenAI兼容、重试退避、熔断、JSON管线、判定器双采样、标签计量
core/tool-runtime.js             工具沙箱（§9.2）：声明式注册、路径囚禁、域名白名单、高危理由
core/safety-constitution.js      安全宪法（§8.1）：五条红线 + 步骤级拦截 + 哈希自检
core/auto-control.js             L9：三层预算、自动调参(界内+门禁+留痕)、策略净化、快照回滚、反指标
core/watchdog.js                 看门狗监督进程（§7.3）
core/store-base.js + store/      L8：node:sqlite、状态机、乐观锁、互斥、快照、墓碑、Prompt注册表
extend/monitor-view.js+html      可视化面板（§9.4）：只读指标 + SSE 事件流 + 任务提交
extend/vector-db.js              向量库适配层（§9.1）：本地索引 + 可选 Embedding 端点
extend/cluster.js                多 Agent 集群（§9.3）：能力路由 + 提案-验证-合并 + 全局墓碑
utils/                           Wilson/BM25/余弦/解析/Token 预算（评分公式唯一实现）
```

## 六步净化管线（§6.1，全量）

```
① DETECT 检测（纯本地零 LLM）→ ② VERIFY 复核（免疫期/n≥5/冷却期/并发/预算）
→ ③ QUARANTINE 软删隔离（30天 TTL）→ ④ EXECUTE 修复合并（记忆LLM合并/经验证据吸收/技能复现修复）
→ ⑤ RECORD 留痕（先写日志后变更，永不清理）→ ⑥ REVIEW 复审抽样（10%，翻案率=精确率度量）
```

**六维净化**：记忆（过期/低值/冗余/冲突）· 经验（失效/劣质/重复）· 技能（僵尸/FROZEN观察/错误复现修复/冗余）· 数据（坏行→lost_and_found）· 策略（Prompt版本化+黄金门禁+检索权重调参）· 风险（红线拦截/净利率破线回滚/对抗冻结）

## 安全机制总表

| 机制 | 实现 |
|---|---|
| Wilson 下界评分 | 1 次全成功仅 0.20，小样本天然保守；n<5 质量分封顶 0.55 |
| 免疫期 48h / 冷却期 24h | verify() 双重校验，新实体与刚写入实体净化豁免 |
| 软删隔离区 | 一切删除先 QUARANTINED，`restore` 一键恢复，TTL 后硬删+墓碑 |
| 变更率上限 | 单周期 ≤5%、单日 ≤20%（小系统保底 1） |
| 快照前置 | VACUUM INTO + SHA-256 登记，滚动保留 30 份 |
| 墓碑反再生 | 硬清除内容登记 token 集，进化生成前必查（≥0.90 拦截） |
| 对抗计数 | 血缘链 3 次生成-被净化 → 整链冻结（比删除安全） |
| 稳态断言 | 净利率连续 3 周期越界 → 失稳事件；<−10% → 自动快照回滚 |
| 三层预算 | L1 任务 50k（中止+复盘）/ L2 净化周期 30k（仅规则净化）/ L3 日 2M（降级模式） |
| 判定器双采样 | 两次采样不一致 → 弃权不动作；判定与利益分离 |
| 安全宪法 | 五条红线硬编码 + 哈希自检 + 每步前置检查 |
| 工具沙箱 | 路径囚禁、域名白名单、高危须理由、shell 默认禁、凭据模式拦截 |
| 崩溃恢复 | EXECUTING 日志重启后自动收尾（DONE/ROLLED_BACK） |
| 自动调参 | 界内步长 ≤10%、影子重排门禁 ≥80% 重合、成功率下降自动回退、全程留痕 |

## TUI 命令

```
task <任务>       执行任务          status          系统状态
skills/memories/experiences 创实体  purify [deep]   净化周期
review [id]       复审抽样          tune            自动调参
prompts [role]    Prompt 双轨      tools           工具注册表
restore <id>      隔离区恢复        logs [n]        净化留痕
tune-logs [n]     调参留痕          golden list|add 黄金任务集
snapshot          手动快照          usage           三层预算用量
demo              MOCK 演示
```

## 测试覆盖（69 项）

- **单元**：Wilson/BM25/解析器/Token预算/状态机/乐观锁/快照/互斥
- **进化**：任务全链路、记忆/经验沉淀证据链、去重合并、DRAFT 门禁、墓碑拦截
- **净化注入**（DoD §10.2）：精确率 100%、召回率 100%、免疫期/n<5 保护、留痕完整、可回滚、崩溃恢复、TTL+墓碑
- **沙箱逃逸**（DoD §11.3）：路径逃逸/无理由写入/凭据外传/域名白名单/shell 禁用/步骤红线
- **技能净化**：僵尸隔离、FROZEN 观察期、冗余合并吸收、复审翻案（翻案率度量）、对抗冻结
- **预算/调参/策略**：标签计量、L2 周期预算降级、调参界内留痕回退、Prompt 迭代黄金门禁、启动自检
- **服务/集群**：面板指标与 purge_logs 对账 100%、HTTP 任务接口、2-worker 集群路由与结果回收
- **安全加固**：间接注入防御（23 指纹三档分级，含代码/工具调用/JSON 结构注入）、技能版本快照+自动回滚+回滚后验证闭环、任务中断恢复、DNS TOCTOU 消除
- **稳定性增强**：LLM 流式连接泄漏修复（abort 时显式关闭 reader）、run_js CPU 死循环防护（`__count__` 步进计数器 + `setTimeout` 封顶）、对话 context 滑窗（保留最近 3 轮完整 + 更早摘要）、hybridSearch 双阈值（bm25>0.3 && cos>0.15）、instant 记忆优先召回、embedding 覆盖率统计、启动时 backfillAll await、graceful shutdown（SIGTERM/SIGINT handler）
- **语义检索**：BAAI/bge-m3 向量库 + BM25 混合检索、增量同步、写时补向量、存量异步回填

## 配置（config/index.js，含 [下界,上界] 安全边界）

环境变量：`SPA_API_KEY / SPA_BASE_URL / SPA_MODEL / SPA_DATA_DIR / SPA_MOCK / SPA_TOOLS / SPA_TOOL_SHELL / SPA_DASHBOARD_PORT / SPA_SERVE_PORT`。Embedding 可选：`EMBEDDING_PROVIDER=openai-compatible` + 端点（默认 BM25，三级降级 §4.1.3）。

## 已知提示

- Node 22 会打印 `ExperimentalWarning: SQLite...`（22.13+ 可用，24 起稳定），可忽略
- 真实 API 首次跑建议先 `node app.js --task "小任务"` 验证连通，再起 `--serve`/`--watchdog`
