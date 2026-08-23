-- store/schema.sql —— 第 3 章 Schema 的唯一实现（所有模块禁止绕过 store-base 直读写）
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ───────── 实体通用列 + 三张实体表 ─────────
CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  parent_id     TEXT,
  origin        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  immunity_until INTEGER NOT NULL,
  execution_count INTEGER NOT NULL DEFAULT 0,
  quality_score  REAL NOT NULL DEFAULT 0.5,
  embedding     BLOB,
  quarantined_at INTEGER,
  purge_after    INTEGER,
  last_used_at   INTEGER,
  name          TEXT NOT NULL,
  scenario      TEXT NOT NULL,
  description   TEXT NOT NULL,
  steps         TEXT NOT NULL,            -- JSON: [{goal, action, expected}]
  params_schema TEXT,
  success_count INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  verified      INTEGER NOT NULL DEFAULT 0,
  heat          TEXT NOT NULL DEFAULT 'warm'
);

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  parent_id     TEXT,
  origin        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  immunity_until INTEGER NOT NULL,
  execution_count INTEGER NOT NULL DEFAULT 0,
  quality_score  REAL NOT NULL DEFAULT 0.5,
  embedding     BLOB,
  quarantined_at INTEGER,
  purge_after    INTEGER,
  last_used_at   INTEGER,
  tier          TEXT NOT NULL,            -- instant | short | long
  kind          TEXT NOT NULL,            -- episodic | semantic | procedural
  content       TEXT NOT NULL,
  importance    REAL NOT NULL DEFAULT 0.5,
  access_count  INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,
  supersede_of  TEXT,
  entities      TEXT,
  task_id       TEXT
);

CREATE TABLE IF NOT EXISTS experiences (
  id            TEXT PRIMARY KEY,
  state         TEXT NOT NULL,
  version       INTEGER NOT NULL DEFAULT 1,
  parent_id     TEXT,
  origin        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  immunity_until INTEGER NOT NULL,
  execution_count INTEGER NOT NULL DEFAULT 0,
  quality_score  REAL NOT NULL DEFAULT 0.5,
  embedding     BLOB,
  quarantined_at INTEGER,
  purge_after    INTEGER,
  last_used_at   INTEGER,
  task_signature TEXT NOT NULL,           -- 检索用关键词集（BM25 降级档）
  summary        TEXT NOT NULL,
  rules          TEXT NOT NULL,           -- JSON: string[]
  pitfalls       TEXT NOT NULL,           -- JSON: string[]
  failure_taxonomy TEXT,                  -- plan|tool|llm|data|env
  evidence       TEXT NOT NULL,           -- JSON: [{task_id, outcome, trace_hash}]
  sample_count   INTEGER NOT NULL DEFAULT 1,
  success_count  INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0
);

-- ───────── 净化留痕（先写日志再执行状态变更，§3.2 强制） ─────────
CREATE TABLE IF NOT EXISTS purge_logs (
  id            TEXT PRIMARY KEY,
  epoch         INTEGER NOT NULL,
  entity_type   TEXT NOT NULL,            -- skill | memory | experience | data
  entity_id     TEXT NOT NULL,
  action        TEXT NOT NULL,            -- QUARANTINE | PURGE | EXPIRE | SUPERSEDE | DEDUP_SKIP | RESTORE | LOST_AND_FOUND
  dimension     TEXT NOT NULL,            -- memory | experience | skill | data | strategy | risk
  reason        TEXT NOT NULL,
  evidence      TEXT NOT NULL,            -- JSON: 判定依据（含 prev_state 供回滚）
  confidence    REAL,
  judge_meta    TEXT,                     -- JSON: {model, promptVer, sample1, sample2} 判定器留痕
  snapshot_id   TEXT,
  status        TEXT NOT NULL,            -- EXECUTING | DONE | ROLLED_BACK
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purge_entity ON purge_logs(entity_type, entity_id);

-- ───────── 墓碑（硬清除登记，阻止被净化内容立即复活，§6.5-3） ─────────
CREATE TABLE IF NOT EXISTS tombstones (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT NOT NULL,
  content_digest TEXT NOT NULL,           -- 内容摘要（前 200 token 化）
  tokens        TEXT NOT NULL,            -- JSON: token 集（供相似度比对）
  created_at    INTEGER NOT NULL
);

-- ───────── 快照登记 ─────────
CREATE TABLE IF NOT EXISTS snapshots (
  id            TEXT PRIMARY KEY,
  file          TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  reason        TEXT
);

-- ───────── 任务轨迹（全系统唯一事实凭证，§5.4） ─────────
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  input         TEXT NOT NULL,
  plan          TEXT,                     -- JSON: steps
  steps         TEXT,                     -- JSON: [{goal, output}]
  answer        TEXT,
  outcome       TEXT NOT NULL,            -- SUCCESS | FAIL
  outcome_basis TEXT,                     -- assertion | judge | judge_abstain
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL
);

-- ───────── 黄金任务集（§10.1，只增不删） ─────────
CREATE TABLE IF NOT EXISTS golden_tasks (
  id            TEXT PRIMARY KEY,
  input         TEXT NOT NULL,
  assertion     TEXT NOT NULL,            -- JSON: {type: contains|regex|equals|judge, value}
  origin        TEXT NOT NULL,            -- cold-start | user
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

-- ───────── 系统状态（epoch、净利率滚动值、当日用量、自动调参当前值） ─────────
CREATE TABLE IF NOT EXISTS system_state (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,            -- JSON
  updated_at    INTEGER NOT NULL
);
