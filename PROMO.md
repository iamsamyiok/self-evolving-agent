# evo-agent · 自进化智能体

**一个会越用越聪明的 AI Agent。零依赖，一条命令安装。**

它不只是执行任务——每次任务完成后，自动沉淀技能、记忆与经验；下一次遇到同类问题，直接调用积累的能力，更快更准。自我修正机制保证进化不跑偏：坏技能自动隔离，好技能投票上位，全程可回滚。

---

## 特色

### 1. 双闭环自进化
任务 → 进化（技能/记忆/经验沉淀）→ 自我修正（检测→复核→隔离→修复→留痕→复审），能力随使用持续增长，且每一步留痕可审计。

### 2. 零依赖，一条命令
纯 Node.js（node:sqlite + 原生 fetch），无 node_modules、无虚拟环境、无 Docker。装完即用，数据全在本地 `~/.self-evolve/`。

### 3. 不失控的安全设计
- 安全宪法五条红线 + 步骤级拦截
- 工具沙箱：路径囚禁、域名白名单、高危操作需理由
- 三层 token 预算熔断，成本封顶
- 看门狗进程：崩溃自动重启，异常频繁自动熔断

### 4. 不误杀的进化质量
Wilson 置信下界评分 + 最小证据量 + 免疫期 + 迟滞带 + 复审翻案率度量——用统计学管住自动化，进化稳字当头。

### 5. 深度研究能力
多查询并行检索、证据账本编号引用、信息缺口自动补搜、上下文分级蒸馏。回答带可点击来源卡片，结论可溯源。

### 6. 20+ 内置工具
文件读写、网页/新闻检索、子代理、diff、HTTP 探测、JSON/CSV 查询、文档解析（PDF/DOCX/XLSX）、批量断言校验、用量查询等，规划器自动发现按需调用。

### 7. 多种运行形态
终端 TUI / 网页对话 / HTTP 服务 + 可视化面板 / 看门狗守护 / 多 Agent 集群，一种能力五种玩法。

---

## 安装

要求：Node.js ≥ 22.13

```bash
npm i -g self-evolve
self-evolve
```

首次运行自动进入配置向导，填一个 OpenAI 兼容的 API Key（DeepSeek、通义、Kimi、OpenAI 等均可），随后终端会输出链接，点击进入对话界面。

非交互配置（CI / 脚本）：

```bash
self-evolve --api-key sk-xxx
self-evolve --port 8080 --no-open
self-evolve --config
```

## 使用

```bash
self-evolve                # 网页对话模式（默认）
spa                        # 终端 TUI 交互模式
spa task "调研XX并写摘要"   # 单任务无头执行
spa status                 # 查看系统状态
spa demo                   # 离线全流程演示
```

进阶形态（源码运行）：`npm run serve`（HTTP 服务 + 可视化面板 :3790）、`npm run watchdog`（生产守护）、`npm run cluster`（多 Agent 集群）。

零成本体验（无需 API Key，离线演示 任务→进化→自我修正→回滚 全流程）：

```bash
SPA_MOCK=1 node app.js --demo
```

---

## 链接

- GitHub：https://github.com/iamsamyiok/self-evolving-agent
- npm：https://www.npmjs.com/package/self-evolve
- License：MIT

---

**evo-agent · 自进化智能体——把「越用越顺手」做进底层。**
