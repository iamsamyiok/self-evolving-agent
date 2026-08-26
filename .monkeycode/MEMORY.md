# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while fixing persistent 429 + stream interruption complaints
- Category: Troubleshooting & Debugging
- Instructions:
  - 429 放大根因：chat() 只在重试循环外取一次令牌——429/5xx 指数退避重试期间不再过令牌桶，重试风暴连环触发 429。修复：每次重试前 acquireToken()；429 走专属耐心轮（LLM_429_MAX_WAITS=5，读 Retry-After，attempt-- 不烧常规预算，耗尽抛"限流持续"清晰报错）
  - 断流无感恢复三件套：web.js WebServer.liveTasks 静态 Map（taskId→{events,done,result,at}）记录全量进度事件（start 事件也要 push 进 events 保持与流序列下标对齐）；GET /api/task/:id running 时返回 {status:'running',events}、done 时带 result；前端 catch 流错误后 2.5s 轮询，用 handled 计数 slice 补渲染漏掉的事件（renderStage/renderDone 与流路径共用）
  - 前端不再显示"网络中断"警告，改为 view.set('同步执行进度…') 静默切换轮询
- Date: 2026-08-24（二轮补丁：界面卡死"恢复连接中"不动作）
- Instructions:
  - 卡死根因 1：handleChat catch 分支不设 live.done → 任务失败（429 耗尽抛错）后轮询永远 running。修复：taskId/live 提升到 try 外声明，catch 也写 live.result + live.done=true
  - 卡死根因 2：前端轮询的 try/catch 包在 while 外，单次轮询网络抖动即整体放弃。修复：catch 移入循环内，失败仅提示"恢复连接中…"继续轮询；8 分钟 deadline 到期渲染"同步超时，可在对话列表查看"
  - renderDone 载荷双形状：流式 done 事件是 message.content，轮询恢复是 result.answer——必须 q.answer??q.content 兼容，否则流式成功也显示"任务失败：未知"
  - 429 无 Retry-After 头时必须指数等待（5s→10s→20s→40s→60s）：不等待立即重试会在 1s 内烧光 5 轮耐心（服务端限流窗口≥30s）
  - 免费配额省钱：judge 加 samples=1 单采样（任务成败判定低风险）；进化钩子令牌让路（tokensAvailable()<6 跳过 LLM 类钩子只记账），否则连续提问时钩子吃光 20/min 配额，用户下一任务直接 429
- Date: 2026-08-24（三轮：界面"正在思考中"僵死无反馈）
- Instructions:
  - 感知层根因：后端任务全 SUCCESS 没卡——卡的是展示。429 耐心轮睡 5s→10s→20s→40s→60s（累计 135s/次）+ 令牌桶排队期间零事件发出，前端标题僵在"正在思考…"（计时器走秒但标题死）
  - 等待透明化机制：llm-adapter 导出 taskScope（AsyncLocalStorage，node:async_hooks 零依赖）；agent-executor runTask 包 taskScope.run({progress}) 注入闭包；chat() 的 429 等待/排队 >2s 时 notifyWait({stage:'llm_wait',kind,nth,max,waitSec,position}) → onProgress → 流+live.events 双通道 → 前端 renderStage 显示"服务限流，Ns 后自动重试"或"排队等待模型配额"
  - 事件序列对齐保持：llm_wait 走同一 onProgress 管道，流和轮询自动一致
  - 进化钩子隔离：_evolveTail 包 taskScope.run({})（空 store），fire-and-forget 不继承任务上下文，避免钩子的等待事件污染已完成任务的 live.events
  - 验证技巧：单测 acquireToken 排队上报——先同步抽干 20 令牌，第 21 个进队列，等 2.5s 看 progress 收到 kind:queue 事件（注意 --input-type=module 的 -e 里 taskScope.run 回调必须同步返回 promise）
- Date: 2026-08-24（四轮：仍"正在思考中" + 无法停止/输入锁死）
- Instructions:
  - 锁死根因 1：chat.html 响应无 Cache-Control → 浏览器缓存旧版前端，用户跑的是没有 llm_wait 渲染/断流恢复的旧 JS。修复：HTML 响应加 Cache-Control: no-store（前端迭代频繁必须禁缓存）
  - 锁死根因 2：state.sending=false 在 send() 末尾裸放，任何异常逃逸即永久锁输入。修复：收尾全部包 try/finally；发送中按钮变 ■ 停止键（setSendingUI 切换，不再 disabled）
  - 停止机制（协作式中断，实测 ~1s 生效）：POST /api/task/:id/abort 置 live.abort=true → submitTask 传 isAborted:()=>live.abort → runTask 放进 taskScope store {progress, aborted} → llm-adapter isAborted() 读。中断点：chat() 每次尝试前/fetch 进行中（500ms watcher ac.abort()）/429 退避 abortableSleep(300ms 粒度)/令牌排队（interval 检查+退出队列防止白耗令牌）/步骤边界/最终综合前
  - ABORT_ERR = {retryable:false, aborted:true, message:'已停止'}：catch 里 isAborted() 优先判断，防止 fetch 掐断的 AbortError 被当可重试错误重试
  - 前端停止：activeAC.abort() + POST abort + userStopped 标志（区别断流恢复：停止后不进轮询）；显示"已停止"灰字
  - 中止任务落库 FAIL/已停止，不 chargeSkills（FAIL 不惩罚技能）
- Date: 2026-08-24（五轮：前端 TypeError "this.finishLine is not a function" 死循环"恢复连接中"）
- Instructions:
  - 事故链：makeExecView 返回对象缺 finishLine 方法（step-block 重构时漏抽），cur()/step() 在 curLine 非空时调 this.finishLine() 必抛 TypeError；第一个 step 事件即崩，掉进断流恢复轮询，轮询里 renderStage 再抛同错 → catch 伪装成"恢复连接中"死循环。后端任务其实正常跑完
  - 教训：curl 测后端事件流不等于前端渲染路径通过；node --check 只查语法。已建 tests/unit/exec-view.test.js：从 chat.html 切出 makeExecView 源码（顶级函数：indexOf('function makeExecView') 到行首 '\n}'），new Function 注入 mock DOM（createElement/querySelector/appendChild/classList/addEventListener），跑完整事件序列 plan→step→stepDone→…→done 断言不抛错
  - 渲染容错：流式和轮询两条路径的 renderStage 都包内层 try/catch，单事件渲染失败显示"渲染异常：xxx"并 handled++ 继续补渲染，绝不伪装成网络错误
  - stepDone 的 lbl 声明必须在 if(curLine) 外（折叠块 html 引用 lbl），行缺失时 lbl='' 回退——块级作用域陷阱
  - 修改 chat.html 前端渲染后必须跑 exec-view.test.js（node --test tests/unit/exec-view.test.js），再 node --check 提取的 script
- Date: 2026-08-24（六轮："非法 URL" 降级 → 幻觉新闻）
- Instructions:
  - 根因链：planner §6 曾引导"搜索用 http_get" + 技能蒸馏器提示词只允许 tool:http_get → 蒸馏出的 9 个新闻类技能全部固化 http_get+query（无 url）坏用法 → 技能被门禁转 ACTIVE 后每次命中必失败降级 → reason 步骤凭训练数据编造新闻（幻觉）
  - news_search 工具真实存在（AnySearch API https://api.anysearch.com/v1/search 免Key可用，POST {query,max_results}；降级 Google News RSS）；别名表已映射 search/web_search/google_search 等
  - 修复四层：planner §5/§6 改为"搜索一律 news_search，http_get 仅限已知完整 URL 的 API"；executeSkillStep 运行时治愈（tool:http_get 无 url 但有 query → 改道 news_search）；蒸馏器注入真实工具清单 + 产出后同样治愈；存量技能 SQL 批量治愈（9 个）
  - 技能子步骤链式传递：executeSkillStep 的 reason/answer 子步骤必须携带前序 results（工具产出是分析对象，缺失即幻觉）；提示词注明"分析必须基于真实内容禁止编造"
  - 降级防幻觉：degrade 到 reason 的步骤提示词强制要求"涉及实时/外部信息时声明未经联网核实，禁止编造具体新闻、数字或来源"
  - http_get 容错：checkPermissions 对含非 ASCII 的 url 自动 encodeURI（中文 URL 不再报非法）
  - planner 激活版仅 105 字符占位 → prompt() 回退 DEFAULT_PROMPTS（agent-executor.js 内），改默认模板即生效；prompt_registry 表 status 列（非 state）
- Date: 2026-08-24（七轮：模型不知道"今天"是几号 → "最近一周"算成训练数据的 2026年7月）
- Instructions:
  - 时间感知：prompt() 对 planner/step/final 三个 role 注入"当前时间：YYYY年M月D日（周X）HH:MM"+说明"训练数据早于当前时间，相对时间以当前时间为准"。模型上下文没有日期时，所有相对时间（最近/本周/今天）会按训练数据时间换算，产出过时内容
  - quick 模式实时性守卫：opts.quick 且 input 匹配 /最近|最新|今天|本周|近日|新闻|行情|现价|此刻|now|current|latest|today/i → progress 发 replan(attempt:0, reason:'问题涉及实时信息...') 且 opts={...opts,quick:false} 走完整规划——quick 单次直答无搜索，实时问题直答必幻觉
  - judge 截断：展示上下文从头300+尾300 放宽到头600+尾500——列表型交付物（多条新闻）条目多，截太狠判定器看不到完整内容会误判 FAIL
  - 验证要点：回答中出现与当前日期一致的相对时间（如 8月20日）= 时间注入生效；出现训练数据旧日期（如"2026年7月"）= 未生效
- Date: 2026-08-24（用户指令：移除快速模式 + 界面改亮色）
- Instructions:
  - 前端已无快速模式：quickMode checkbox 与传参全部删除，所有对话走完整规划（实时性守卫仍在后端兜底，API 的 quick 参数保留兼容但前端不再传）
  - chat.html 为亮色 ChatGPT 风格：CSS 变量 --bg:#fff --side:#f9f9f9 --panel:#f4f4f4 --line:#e5e5e5 --txt:#0d0d0d --code:#f6f8fa；代码块浅底深字（code 内联文字 #c7254e，pre 文字 #24292f）；modal 遮罩 rgba(0,0,0,.4)。改样式时勿引入硬编码暗色（#1a1a1a/#111/#262626 等）

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while fixing frequent "网络中断" during long multi-step tasks
- Category: Troubleshooting & Debugging
- Instructions:
  - 中断根因：NDJSON 流在进度事件之间静默（LLM 调用 15-60s + 免费限流令牌桶等待），预览代理判定空闲掐断连接；服务端任务仍在跑（轮询恢复能拿到结果即此证据）
  - 修复：web.js handleChat 加 15s 心跳（`{"type":"ping"}`）+ `X-Accel-Buffering: no`；listen() 设 server.requestTimeout=0、headersTimeout=0、keepAliveTimeout=72s；任务结束 finish() 清心跳再 end
  - 前端 chat.html 读流循环显式忽略 ping 事件
  - 关联缺陷：planner 偶发裸用技能名（tool:ai_news_summary_pipeline 漏 skill: 前缀）→ R5 拦截降级；planOnce 泛化重写顺序改为：未注册名先查技能池 active().find(name) → 再走 ALIASES 别名表

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while solving memory-scale retrieval slowdown systematically
- Category: Troubleshooting & Debugging
- Instructions:
  - 检索缓存架构：core/retrieval-cache.js EntityIndex —— 快照校验（COUNT+SUM(version)+MAX(updated_at) 单条聚合 SQL）+ 增量 diff 同步（只重分词变更条目）+ 冷热裁剪（超 MEMORY_INDEX_MAX_ROWS=20000 按温度=质量0.5+重要性0.2+时近性0.3 保留最热）
  - 记账旁路：store.touch（access_count/last_used_at）与 store.bumpStats（成功/失败/执行计数、质量分）直写 SQL，不递增 version/updated_at —— 每次任务后的检索记账/技能执行记账不触发索引重建；真实内容/状态变更仍走 store.update 正常失效
  - BM25 倒排化：utils/similarity.js BM25Index 加 postings（token→Set<id>），search 只对与查询共享 token 的文档打分（O(命中集)）；同时修复原 add() 每次全量重算 avgLen 的 O(N²) 构造缺陷
  - 三系统接入：memory/skill/experience 的 retrieve/findDuplicate/findSimilar/active() 全部走缓存索引；行查找用 Map.get 替代 O(N) 的 Array.find
  - 性能基线（5k 记忆压测，tests/unit/retrieval-perf.test.js）：首建 ~200ms、热检索 ~35ms/次、单条增量同步 <50ms；旧实现每次检索全量重建（150ms+）

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while adding share/export-import, ChatGPT-style UI, and no-tool capability expansion
- Category: Operations & Deployment
- Instructions:
  - 能力分享端点：`GET /api/share/export`（返回 `{format:'evo-agent-share',version:1,items:[{type,score,...}]}`）；`POST /api/share/import` 接收同名包（skill 入库 DRAFT 须过黄金门禁，memory/experience 去重后 ACTIVE，重复跳过）
  - chat.html 路由为 `/`（不是 `/chat.html`）；web.js 在 `web/chat.html` 读取并返回，HTML 修改无需重启服务
  - web.js 含 share 端点时需重启生效（HTML 是每次读文件，JS 是启动时加载）
  - 当前活跃 backend terminal：term_1787559885805_29（PID 11616）运行 node web.js
- Instructions:
  - 断线重连链路：start 事件携带 taskId → 前端流中断后轮询 GET /api/task/:id（执行中返回 pending，落库后返回结果）
  - run_js 沙箱：vm + 黑名单（require/process/Function/eval/fetch/constructor/prototype 等）+ 3s 超时；死循环被超时拦截不 crash
  - judge 判定标准是"最终交付物"而非过程展示；简短答案 abstain 宽容线为 8 字符
  - 记忆入库门槛 MEMORY_MIN_IMPORTANCE=0.55，quality_score 按重要性初始化；抽取 prompt 含正反例禁止任务复述
  - REPLAN_MAX=2，每次 replan 前有 labelBudgetLeft>10_000 预算守卫

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while adding resilience execution kernel (degrade/replan/params-fix)
- Category: Troubleshooting & Debugging
- Instructions:
  - 韧性执行链：工具失败 → fixToolParams（LLM 修参数一次）→ 降级 reason（degradeNote 注入）→ 任务级 replan（带错误教训重规划）
  - infra 错误（/熔断|429|预算|store_closed/）不降级不上抛重规划，直接失败
  - tools/ 目录为热插拔工具位：default 导出 {name,desc,risk,checkPermissions,run}，启动时 loadDynamicTools 自动注册
  - calc 工具含幂的纯整数表达式走 BigInt 路径（2^64 精确），小数/函数走 double
  - 进度事件流：step（开始）/ step_done（ms+preview）/ retry / degrade / replan，前端 chat.html 按事件渲染打勾与耗时

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while adding share/export-import, ChatGPT-style UI, and no-tool capability expansion
- Category: Troubleshooting & Debugging
- Instructions:
  - 无工具能力拓展：planner prompt §5 给出公开免 Key API 优先级（open-meteo 天气 / open.er-api.com 汇率 / github.com 占位），缺专用工具时按 http_get → run_js 代码实现 → reason 自身知识 三级降级，不可放弃
  - 技能参数模板插值：agent-executor.js `interpolateParams()` 支持 `{{key}}` 和 `{key}` 占位符替换；executeSkillStep 合并时子步骤默认值 ← 用户传入参数（用户覆盖默认值）
  - get_weather 技能 URL 是 `https://wttr.in/{city}?format=j1`，不插值会拿到 wttr.in 默认位置（悉尼）——修复后东京查询返回真实数据
  - skills 表 NOT NULL 列：state/origin/created_at/updated_at/immunity_until/name/scenario/description/steps；新增测试插入须补齐所有非空列
  - 分享包格式字段：items 中 skill 需 scene/desc/steps/success_count/fail_count/heat；memory/experience 含 content/quality_score/task_signature
- Instructions:
  - Web 服务启动：`node web.js`（长驻任务须用 background_terminal 且 timeout=0；chat 端口 3789，dashboard 端口 3790）
  - LLM 免费限流约 20 req/min；令牌桶在 core/llm-adapter.js（20 桶容，1/3s 补充）；429 已豁免熔断窗口
  - 连续真实 LLM 测试之间须 sleep 15-25s 避免触发熔断（70% 错误率或连续 10 失败 → 3 分钟冷却）
  - 测试时注意：用户浏览器可能开着 web 前端并发发任务，tasks 表最新记录可能不是自己的测试任务

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while fixing test suite hangs
- Category: Testing Methods
- Instructions:
  - 测试命令：`node --test tests/unit/*.test.js`（shell glob 形式；目录参数形式不工作）
  - 模块级 setInterval 必须 `.unref?.()`，否则 node --test 进程挂起超时（曾因 llm-adapter 限流定时器缺 unref 导致全套测试挂死）
  - 起服务器的测试须在 test.after 中关闭 server 与 store（web-chat.test.js 曾缺失导致挂起）
  - `node --check` 按 CJS 解析，无法可靠发现 ESM 语法错误；用 `node core/xxx.js` 直接执行可拿到精确行号

[Project Knowledge Summary]
- Date: 2026-08-24
- Context: Discovered by Agent while fixing constitution mismatch warning
- Category: Troubleshooting & Debugging
- Instructions:
  - 改动 core/safety-constitution.js 后启动会报 constitution_mismatch（运行时防篡改哈希）；合法迭代后须用 node 脚本重登记 `constitution_sha`（store.setState）
  - store 关闭后统一抛 `store_closed`（store-base.js 的 db getter 守卫）；上层捕获该错误应静默
- Date: 2026-08-25
- Context: Agent 触发 13 项系统性弱点修复（Great Wall 复杂任务用例暴露 LLM 连接泄漏 + run_js CPU 死循环等）
- Category: Troubleshooting & Debugging
- Instructions:
  - hybridSearch 双阈值：`score > 0.15 && bm25 > 0.3`（任一 dim 低于下限丢弃），跨查询分数不可比时防低质命中污染上下文
  - instant 记忆独立 bucket：检索时先查 instant tier（最多占 topK 30%），再查 semantic/short/long tier
  - 经验平凡成功过滤：结构化检查（`rules.length === 0 && pitfalls.length === 0`）替代字符串启发式
  - 技能提炼可执行性门控：validate 回调校验 tool:* 步骤的 tool 名在注册表内 + params 必填字段齐全
  - 技能回滚后验证闭环：rollbackManually 返回 verified 字段，tryRollback 日志补 snapshot_sha + rollback_reason
  - skill_versions 表新增 sha TEXT 列（migration V4+）；snapshotSkill 插入时需传 null 占位
  - embed-backfill 启动改为 await backfillAll(store) + 2s 缓冲后再 loop.start()
  - graceful shutdown：SIGTERM/SIGINT → 中止 liveTasks → 等 5s → store.close() → process.exit(0)
  - 注入指纹从 17 增至 23（新增 code_inject/tool_inject/json_inject 三类）
- Date: 2026-08-25
- Context: Agent 完成 v1.5.0 发布（交互与工具完备轮：shell 默认开、edit_file、多模态图片、TUI 重构）
- Category: Operations & Deployment
- Instructions:
  - gh 凭据过期时（401 Bad credentials）：`git credential fill` 可能返回缓存旧 token（仍 401）；必须直接调 helper `printf 'protocol=https\nhost=github.com\n\n' | /app/agent/bin/agent git-credential-helper get` 取新 token 再 `gh auth login --with-token`（登录身份 monkeycode-ai[bot]）
  - 远程存在孤儿标签 v1.2.0/v1.3.0/v1.3.1/v1.4.0（旧版本方案遗留，无对应 GitHub Release）；唯一正式 Release 是 v1.1.0（稳定性加固轮 @ 4a55efd）。新发布须打 > v1.4.0 的标签（本次 v1.5.0），勿复用 v1.2.0
  - 发布流程：git add+commit（消息尾 `Co-authored-by: monkeycode-ai <monkeycode-ai@chaitin.com>` 会被钩子自动追加，-m 里手写会重复）→ git tag vX.Y.Z → git push origin master --tags → gh release create vX.Y.Z --title ... --notes ...
- Date: 2026-08-25
- Context: Agent 将项目打包发布为 npm 包 self-evolve@1.5.0
- Category: Operations & Deployment
- Instructions:
  - npm 包：self-evolve（bin 命令同名，另保留 spa 旧入口）；npm 主页 https://www.npmjs.com/package/self-evolve
  - 发布 403 "Two-factor authentication ... required"：账号开了强制 2FA，经典 token 被拒；须用 Granular Access Token（勾选 Bypass 2FA for automation + Read and write）。token 写 ~/.npmrc（600 权限）后 npm publish <pkg>.tgz --access public
  - 安装模式数据隔离：仓库内无 config/local.json 时 IS_PACKAGED=true，数据/配置/沙箱落 ~/.self-evolve/（SPA_DATA_HOME 可重定向，测试用）；开发仓库行为不变
  - 发布前必做：npm pack --dry-run 检查清单不含 data/、config/local.json、.monkeycode/；node --check 是 CJS 解析，bin 用 ESM 须 node 直接执行验证；干净 prefix 安装 + 起服务 + curl 200 全链路验证
  - server.listen 的 EADDRINUSE 是异步 'error' 事件，try/catch 接不住——必须 promise 内 this.server.once('error', reject)（web.js listen 与 extend/monitor-view.js listen 均已修）

[Project Knowledge Summary]
- Date: 2026-08-26
- Context: Agent 完成深度研究管线（v1.5.3：多路检索+证据账本+缺口迭代+计划确认+报告引用）
- Category: Build Methods
- Instructions:
  - 深研架构：core/research.js 零依赖纯函数层——EvidenceBook（URL 去重/编号/citationList/toJSON）+ parseSearchResults（`N. 标题\n来源：\n链接：\n摘要：` 格式，编号行即条目起点不做连续性校验）+ multiQuery/parallelSearch/gapCheck/distillSteps（全部失败降级：gapCheck 失败→sufficient:true 防死循环）
  - 深度档位：opts.depth = light（quick 直答，实时问题自动升级）| standard | deep（多路预检索+计划确认+缺口补搜+蒸馏+引用注入）；evidence 挂 _runTask 外层作用域供 trace/补搜/最终复用
  - 计划确认：web.js 传 awaitApproval 闭包 → /api/task/:id/approve 端点；Promise.race 60s 超时自动放行；用户拒绝错误（含"计划确认"）须排除出 replan 可恢复集合（否则拒绝会被重跑违背用户意图）
  - 引用链：final system prompt 注入编号证据清单→模型输出 [n]→前端 md() 后替换为 sup.cite（仅 n≤evidence.length 才转换，防幻觉引用）→点击闪跳来源卡片；导出纯前端 Blob 下载 .md
  - web 冒烟端口：SPA_WEB_PORT（非 SPA_PORT！）+ SPA_DASHBOARD_PORT；平台预览服务长驻 3789（旧代码），测新代码须换端口
  - 教训：curl 打旧实例会拿到"看似正常"的旧版响应（无新事件/新字段）——EADDRINUSE 日志才是判据；上轮 v1.5.2 发版漏提交 package.json 版本号（HEAD 1.5.1/npm 1.5.2），发版前须 diff 确认
- Date: 2026-08-26（v1.5.4 执行反馈增强）
- Instructions:
  - 反馈三层架构：phase 事件（agent-executor 在 5 个 LLM 调用点前发 {stage:'phase',label}→前端 view.cur 行级计时）+ 生成心跳（llm-adapter chat() 请求进行中每 8s 发 {stage:'llm_wait',kind:'generating',waitSec}，仅改标题不加行）+ 流式 delta 本身即活性信号（首个 delta 前的 TTFB 由心跳覆盖）
  - 心跳停止点：429 分支停（rate_limit 事件接管）/流式分支到 headers 即停/非流式 json() 完成后停/catch 必停；MOCK 模式不走心跳
  - "输入框黑点"根因：⚡ emoji 在无 emoji 字体环境渲染成几个像素的深色小块——UI 控件图标一律用内联 SVG（fill=currentColor 跟随主题色），禁用 emoji 字符做控件图标
  - UI 验证环境：/tmp/opencode/uitest 装有 playwright-core + chromium-headless-shell（系统依赖已 apt 装齐），可 node shot.js 截图 + 像素扫描（自写 PNG 解码 scan.js）/ASCII 渲染（ascii.js）定位视觉缺陷；image_analysis MCP 余额不足时用像素扫描替代

[Project Knowledge Summary]
- Date: 2026-08-26（v1.5.5 吸收 dual-agent 内部智能体机制）
- Context: 学习 iamsamyiok/dual-agent 内部智能体机制后全量吸收 9 项（批 1-4），npm self-evolve@1.5.5 发布
- Category: Operations & Deployment
- Instructions:
  - dual-agent 仓库源码已克隆到 /tmp/opencode/dual-agent/，关键模块：lib/inner.js（上下文预算折叠 head300+tail100）、lib/plugins.js（插件运行时/锻造 overlay/mtime 热重载）、plugins/skill.js（SKILL.md frontmatter 解析+渐进披露）、plugins/subagent.js（并行子调研）、lib/intent.js（意图契约抽取+judge+≤2轮返修）——后续 Agent 开发时优先参考
  - 本次新增核心文件：core/intent.js（B1 意图闭环）、core/archive.js（B2 BM25 历史任务检索）、core/fs-skills.js（C1 目录型 SKILL.md + C2 GitHub 一键安装）、core/subagent.js（D2 并行子调研工具 tool:subagent）
  - tool-runtime.js call() 三重保护生效：超时兜底（SPA_TOOL_TIMEOUT_MS 默认 60s，含 Promise.race + clearTimeout 清理）/ 输出截断（OUTPUT_CAP=8192）/ 必填参数校验（requiredParams 声明走 _checkRequired，缺参报 err.blocked=true 带 schema 提示让 LLM 自修正）
  - 锻造区 overlay：`<DATA_DIR>/tools-forged/` 覆盖同名内置 tools/；mtime 变更自动重载；restoreTool 删锻造版回归内置
  - 连续失败止损：makeStallTracker(limit=3) —— 同工具 3 次失败且从未成功 → 后续步骤 skip 直接降级 reason 并注入"换路"提示
  - 测试套件：`node --test tests/unit/*.test.js`，当前 68 项全绿（42 原有 + 26 新）

[Project Knowledge Summary]
- Date: 2026-08-26（v1.5.9 来源点击修复）
- Context: 用户反馈点击来源条目打不开网页
- Category: Troubleshooting & Debugging
- Instructions:
  - 根因一：来源条目（aiHtml 生成的 src-item）只有右侧 .src-u 里的小 <a> 可点，标题/序号是纯文本——UI 可点区域必须覆盖整行，不能只给角落小字
  - 根因二：平台预览是 iframe 嵌入，sandbox 未开 allow-popups 时 target=_blank 被静默拦截（点 <a> 也无反应，无任何报错）——预览内所有外链必须走 openExternal 兜底链：window.open → window.top.location 顶层导航 → prompt 可复制链接
  - 防双开三件套：全局捕获委托统一处理 a[href]；内层锚点不放 inline onclick；整行 onclick 带 event.target.closest('a') 守卫
  - openExternal 对非 http(s) href（站内 # 锚点）直接 return 不 preventDefault，否则站内跳转会被点死
  - onclick 属性里塞 URL 用 esc(JSON.stringify(url))：&amp;/&quot; 在 HTML 属性解码后是合法 JS 字符串
  - 修改来源卡片/链接行为后必跑 tests/unit/source-card-click.test.js（切源码手法同 exec-view）+ md-autolink.test.js + exec-view.test.js
  - 预览 3789 实例对 web/chat.html 是每请求重读文件——改 HTML 刷新页面即生效，无需杀进程重启；改 web.js 才需要重启

[Project Knowledge Summary]
- Date: 2026-08-26（v1.5.8 来源链接直达）
- Context: 用户要求所有"来源"必须有可点击链接直达原始信息源
- Category: Build Methods
- Instructions:
  - chat.html md() 渲染顺序（改渲染必读）：esc → 占位符暂存（图片 markdown → [文本](URL) 链接 → 代码块 → 行内代码，stash 返回 \u0000N\u0000）→ autolink 裸 URL（字符类排除 \u0000<>"' 防撞占位符与标签属性）→ bold/heading/列表 → 占位符换回 → 换行转 br。HTML 块必须先 stash 再 autolink，否则 img src / a href 里的 URL 会被二次包裹
  - esc 后 URL 中 & 变 &amp;——放 href 是合法写法（浏览器解析回 &），无需反转义
  - md() 测试手法（tests/unit/md-autolink.test.js）：从 chat.html 正则切出 esc 一行 + md 函数体，new Function 注入执行真实调用链；改 md() 后必须跑此测试 + exec-view.test.js
  - subagent 结论来源：runOne 用 research.js 的 parseSearchResults 解析 news_search 输出取前 2 条带 URL 条目，拼 `来源：标题 URL` 附结论尾（结论本体仍 ≤300 字不含 URL）
  - 深研链路的来源链接（来源卡片 <a href>、导出报告 URL 行）v1.5.3 起已有，本轮未动
  - gh CLI 的 token 会过期（401 Bad credentials）：先 helper 取新 token `printf 'protocol=https\nhost=github.com\naction=get\n' | /app/agent/bin/agent git-credential-helper get`，管道 `gh auth login --with-token` 后 push/release 即恢复

[Project Knowledge Summary]
- Date: 2026-08-26（v1.5.7 审查修复轮）
- Context: 对 v1.5.6 八工具做代码审查，修复 6 处实际缺陷 + 沙箱测试隔离问题
- Category: Troubleshooting & Debugging
- Instructions:
  - usage 工具数据源分层：current/budget 走 llm-adapter 内存 getUsage()（同进程权威实时）；history 走 <DATA_DIR>/inner-usage.json（recordUsage 脏标记 + 5s 防抖落盘 unref 定时器 + 跨日归档保 30 天）。禁止再裸读 config/local.json 算预算——打包模式下路径不对，必须 import CONFIG
  - ZIP 中央目录字段偏移：nameLen 在 +28、extraLen +30、commentLen +32、compSize +20、localOffset +42、name 数据在 +46；局部头 nameLen +26、extraLen +28、数据 +30+nameLen+extraLen，局部 size 为 0 时回退中央目录值（data descriptor）。v1.5.6 曾把 nameLen 读在 +26 导致 DOCX/XLSX 全部找不到条目
  - deflate 解压用 node:zlib inflateRawSync——仍是零第三方依赖；真实 DOCX/XLSX 几乎全是 deflate 条目，只支持存储型的解析器等于不可用
  - PDF 文本提取：字符串以 \xFE\xFF 开头走 UTF-16BE，否则 latin1 + PDFDocEncoding 高位映射（<0x80 必须 ASCII 原样，曾把空格映成右引号）；Tj 与 TJ 数组都要匹配；括号字符串须处理 \) \( \n \r \t 与八进制转义
  - diff 算法：相等行原样保留即天然上下文；不匹配时先在对方序列 indexOf 找重对齐（窗口 200），判纯插入/纯删除，都找不到才按同行替换。禁止向 result 队首 unshift 上下文行（乱序）
  - ToolRuntime 构造签名是 (store, {workspace})：workspace 在第二参。曾误传 new ToolRuntime({workspace}) 把 options 塞进 store 形参——workspace 静默落回全局 TOOL_WORKSPACE，测试写文件污染真实工作区（data/workspace/ok.txt 已移至 /tmp/opencode 备份）
  - 沙箱类测试须固定 CONFIG 开关再恢复（TOOL_NET_OPEN / TOOL_NET_SHELL_ENABLED 默认为 1，开发环境与测试假设不一致会让 R5/R2 断言漂移到别的错误分支）
  - 测试全量基线：npm test 175 绿（unit 159 + purification 6 + 其他）；曾见的"test 31 技能提炼"偶发失败是一次性状态残留，复跑即绿

[Project Knowledge Summary]
- Date: 2026-08-26（v1.5.6 插件生态集成）
- Context: 补齐 dual-agent 仓库中与本项目对齐的缺失插件（diff/probe/query/stat/todo/doc/verify/usage）
- Category: Build Methods
- Instructions:
  - 新增 8 个零 token 工具：diff（unified diff）、probe（HTTP 冒烟）、query（JSON路径/CSV筛选）、stat（文件客观统计）、todo（workspace/.todo.json 持久化清单）、doc（txt/md/json/html/csv/log/pdf/docx/xlsx 零依赖解析）、verify（多规则批量断言，10种type）、usage（get/history/budget 三态查询）
  - doc 工具 PDF 解析用线性扫文本流（UTF-16BE BOM + ISO-8859-1 PDF 映射表）；DOCX 解 ZIP 取 word/document.xml 中 <w:t> 标签；XLSX 解 ZIP 取 sharedStrings.xml + worksheet，.xls 二进制格式返回不支持提示
  - verify 多规则一次调用：type 支持 exists/contains/regex/json_valid/min_length/max_length/eq/not_contains/file_exists/line_count
  - query 工具源参数：source 既是 JSON 字符串也是文件路径（存在且不以 { 开头视为文件），where 子句用简单正则匹配 col op val（op ∈ ==/!=/>/< />=/>=/contains/like）
  - todo 工作区持久化在 <workspace>/.todo.json，action 支持 list/add/toggle/clear/delete；跨轮状态由 TUI 和 web UI 共用同一文件
  - tool-runtime.js 统一注册入口，planner 通过 tools.list() 动态获取完整工具列表，无需手动同步
  - 单元测试新增 45 项（7 文件），全量 unit 测试 68 项绿；purification/sandbox.test.js 3 个预存失败与本次无关
  - npm self-evolve@1.5.6 published；GitHub tag v1.5.6 pushed，Release 需手动通过 Web UI 创建

