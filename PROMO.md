# evo-agent · 自进化智能体

**一个会越用越聪明的 AI Agent。零依赖，一条命令安装。**

它不只是执行任务——每次任务完成后，自动沉淀技能、记忆与经验；下一次遇到同类问题，直接调用积累的能力，更快更准。自我修正机制保证进化不跑偏：坏技能自动隔离，好技能投票上位，全程可回滚。

---

## 特色

### 1. 双闭环自进化
任务 → 进化（技能/记忆/经验沉淀）→ 自我修正（检测→复核→隔离→修复→留痕→复审），能力随使用持续增长，且每一步留痕可审计。

### 2. 零依赖，一条命令
纯 Node.js（node:sqlite + 原生 fetch），无 node_modules、无虚拟环境、无 Docker。装完即用，数据全在本地 `~/.self-evolve/`。

### 3. 全权限 + 可选安全模式
默认全权限：文件工具全盘读写、http_get 可访问内网/本机、shell 可用、run_js 可 require 全部 Node 内置模块。需要收紧时 `SPA_SAFE_MODE=1` 一键恢复：路径囚禁工作区 + 私网拦截 + 域名白名单。

### 4. 不误杀的进化质量
Wilson 置信下界评分 + 最小证据量 + 免疫期 + 迟滞带 + 复审翻案率度量——用统计学管住自动化，进化稳字当头。

### 5. 深度研究能力
多查询并行检索、证据账本编号引用、信息缺口自动补搜、上下文分级蒸馏。回答带可点击来源卡片，结论可溯源。

### 6. 20+ 内置工具
文件读写、网页/新闻检索、子代理、diff、HTTP 探测、JSON/CSV 查询、文档解析（PDF/DOCX/XLSX）、批量断言校验、用量查询、open_url 系统浏览器打开网页等，规划器自动发现按需调用。run_js 为受信全功能模式：可 `require` 任意 Node 内置模块（fs 读写、fetch 网络、child_process 系统命令），打开网页、操作文件、调外部命令一类任务直接写代码完成。

### 6.5 长回答自动折叠
网页对话中超过 10 行的回答自动收起（渐变遮罩提示还有内容），点击"展开全文"查看全部、再点"收起"恢复——长报告不再刷屏。

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

其他安装方式：

```bash
# 免安装试用（一次性运行，npx 走缓存）
npx self-evolve@latest spa demo

# 固定版本（生产环境防意外升级）
npm i -g self-evolve@1.5.13

# 离线 / 内网安装：联网机取 tgz，传输后本地安装
npm pack self-evolve
npm i -g self-evolve-1.5.13.tgz
```

零依赖安装：包内无 node_modules、无原生编译，`npm i -g` 秒级完成；仅需 Node ≥ 22.13（node:sqlite、原生 fetch）。

## 更新

```bash
# 方式一：内置自更新（查 registry → 自动 npm 安装 → 数据无损）
spa update

# 方式二：手动
npm i -g self-evolve@latest

# 国内镜像加速（registry 查询与更新走 npmmirror）
SPA_NPM_REGISTRY=https://registry.npmmirror.com spa update

# 查看版本与新版提示
spa version
```

升级要点：

- 数据与配置全在 `~/.self-evolve/`（可用 `SPA_DATA_HOME` 重定向），与安装目录分离——**跨版本升级不丢数据**，记忆/技能/经验/工作区文件全部保留
- 升级前无需停止旧版本之外的操作；运行中的进程继续用旧代码，下次启动生效
- `spa update` 失败（权限/网络）时打印手动命令与离线 tgz 路径
- 版本锁定用户升级前先解绑：`npm i -g self-evolve@latest` 直接覆盖 pin

## 卸载

```bash
# 卸载程序（两个 bin 入口一并移除）
npm uninstall -g self-evolve

# 可选：清理用户数据（记忆/技能/经验/工作区/配置，不可恢复）
rm -rf ~/.self-evolve
```

说明：

- `npm uninstall -g` 只删安装目录，`~/.self-evolve/` 数据目录保留——重装后历史记忆、技能、待办、交付物全部找回
- 想彻底清除痕迹才需要第二步 `rm -rf ~/.self-evolve`（自定义过 `SPA_DATA_HOME` 的按该路径清理）
- 源码运行（git clone）场景无全局安装，直接删仓库目录即可

## 使用

```bash
self-evolve                # 网页对话模式（默认）
spa                        # 终端 TUI 交互模式
spa task "调研XX并写摘要"   # 单任务无头执行
spa web                    # 启动网页对话（同 self-evolve）
spa status                 # 查看系统状态
spa version                # 查看版本与新版提示
spa update                 # 自更新到最新版
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
