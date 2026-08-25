// core/store-base.js —— SQLite 单一事实源：会话、迁移、实体 DAO、互斥事务、状态机、快照、隔离区、墓碑
// 纪律（§2.3 / §3.5）：所有实体写操作必须经 transact(entityId, fn)；乐观锁 version；幂等键静默忽略。
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config/index.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 状态机定义（§3.3，禁自造状态；迁移合法性唯一校验点）──
export const STATE_MACHINES = {
  skill: {
    initial: 'DRAFT',
    transitions: {
      DRAFT: ['ACTIVE', 'REJECTED'],
      ACTIVE: ['COOLING', 'QUARANTINED'],
      COOLING: ['ACTIVE', 'FROZEN', 'QUARANTINED'],
      FROZEN: ['ACTIVE', 'QUARANTINED'],
      REJECTED: ['QUARANTINED'],
      QUARANTINED: ['ACTIVE', 'PURGED'],   // ACTIVE = 隔离区恢复/复审翻案
      PURGED: [],
    },
  },
  memory: {
    initial: 'ACTIVE',
    transitions: {
      ACTIVE: ['EXPIRED', 'QUARANTINED'],
      EXPIRED: ['QUARANTINED'],
      QUARANTINED: ['ACTIVE', 'PURGED'],
      PURGED: [],
    },
  },
  experience: {
    initial: 'ACTIVE',
    transitions: {
      ACTIVE: ['DEPRECATED', 'QUARANTINED'],
      DEPRECATED: ['QUARANTINED'],
      QUARANTINED: ['ACTIVE', 'PURGED'],
      PURGED: [],
    },
  },
};

export const TABLES = { skill: 'skills', memory: 'memories', experience: 'experiences' };

/** 时间有序 uuid（v7 简化版：48bit 时间戳 + 随机，利于排序调试） */
export function uuid7() {
  const ts = Date.now().toString(16).padStart(12, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 20);
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-${rand.slice(0, 4)}-a${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

// ── 实体级互斥租约（单写者原则 §3.5；进程内 Map + SQLite 事务兜底）──
const leases = new Map(); // key -> Promise 链尾
export function runExclusive(key, fn) {
  const prev = leases.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 前序失败不阻断后继
  leases.set(key, next.catch(() => {}));
  next.finally(() => { if (leases.get(key) === next) leases.delete(key); });
  return next;
}

export class Store {
  constructor(dataDir = CONFIG.DATA_DIR) {
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, 'lost_and_found'), { recursive: true });
    this._db = new DatabaseSync(join(dataDir, 'agent.db'));
    this._db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  /** closed 守卫：close() 后所有库访问统一抛 store_closed（比 better-sqlite 的 "database is not open" 语义明确，上层可精确捕获静默） */
  get db() {
    if (this._closed) throw new Error('store_closed');
    return this._db;
  }

  get closed() { return !!this._closed; }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._db.close();
  }

  /** 快照回滚后重绑新库句柄（auto-control.rollbackSnapshot 使用） */
  reattach(fresh) {
    this._closed = false;
    this._db = fresh._db;
    this.dataDir = fresh.dataDir;
  }

  migrate() {
    const sql = readFileSync(join(ROOT, 'store', 'schema.sql'), 'utf8');
    this.db.exec(sql);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
    if (!row || row.v == null) {
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
    }
    this.migrateV2();
    this.migrateV3();
    this.migrateV4();
  }

  /** v2：增量列（幂等，SQLite 无 IF NOT EXISTS 的 ADD COLUMN 用 pragma 守卫） */
  migrateV2() {
    const applied = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v ?? 1;
    if (applied >= 2) return;
    const cols = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols('skills').includes('frozen_at')) {
      this.db.exec('ALTER TABLE skills ADD COLUMN frozen_at INTEGER');
    }
    if (!cols('memories').includes('frozen_at')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN frozen_at INTEGER');
    }
    if (!cols('experiences').includes('frozen_at')) {
      this.db.exec('ALTER TABLE experiences ADD COLUMN frozen_at INTEGER');
    }
    this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(Date.now());
  }

  /** v3：fail_streak 列（技能连续失败计数，2 连败快速 COOLING 用） */
  migrateV3() {
    const applied = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v ?? 1;
    if (applied >= 3) return;
    const cols = (table) => this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols('skills').includes('fail_streak')) {
      this.db.exec('ALTER TABLE skills ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0');
    }
    this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(Date.now());
  }

  /** v4：技能版本快照表（污染回滚用）+ tasks 生命周期状态（重启中断恢复用） */
  migrateV4() {
    const applied = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v ?? 1;
    if (applied >= 4) return;
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    if (!tables.includes('skill_versions')) {
      this.db.exec(`CREATE TABLE IF NOT EXISTS skill_versions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT, scenario TEXT, description TEXT, steps TEXT,
        quality_score REAL, success_count INTEGER, fail_count INTEGER,
        snapshot_at INTEGER NOT NULL,
        reason TEXT,
        sha TEXT
      )`);
    }
    const tcols = this.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!tcols.includes('status')) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'done'");
    }
    this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(Date.now());
  }

  /** 启动恢复：上次运行中未完成的任务标记为 interrupted（会话端如实展示，进化钩子不补跑） */
  markInterruptedTasks() {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()) return 0;
    const r = this.db.prepare("UPDATE tasks SET status = 'interrupted', error = COALESCE(error, '服务重启，任务中断') WHERE status = 'running'").run();
    return r.changes;
  }

  // ── system_state ──
  getState(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  setState(key, value) {
    this.db.prepare(
      'INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, JSON.stringify(value), Date.now());
  }
  bumpEpoch() {
    const e = (this.getState('epoch', 0)) + 1;
    this.setState('epoch', e);
    return e;
  }
  get epoch() { return this.getState('epoch', 0); }

  // ── 实体 DAO（乐观锁：WHERE version = ?，冲突返回 0 行即放弃本次写）──
  insert(entityType, row) {
    const table = TABLES[entityType];
    if (!table) throw new Error(`未知实体类型: ${entityType}`);
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    this.db.prepare(sql).run(...cols.map((c) => row[c]));
    return row.id;
  }

  get(entityType, id) {
    const table = TABLES[entityType];
    return this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  }

  /** 带乐观锁的字段更新；version 冲突抛错（§3.5） */
  update(entityType, id, fields, expectedVersion) {
    const table = TABLES[entityType];
    const cur = this.get(entityType, id);
    if (!cur) throw new Error(`${entityType} ${id} 不存在`);
    const ver = expectedVersion ?? cur.version;
    if (cur.version !== ver) throw new Error(`乐观锁冲突: ${entityType} ${id} expect v${ver} got v${cur.version}`);
    const cols = [...Object.keys(fields), 'version', 'updated_at'];
    const vals = [...Object.values(fields), ver + 1, Date.now()];
    const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND version = ?`;
    const r = this.db.prepare(sql).run(...vals, id, ver);
    if (r.changes === 0) throw new Error(`乐观锁冲突: ${entityType} ${id}`);
    return this.get(entityType, id);
  }

  list(entityType, where = '', params = []) {
    const table = TABLES[entityType];
    return this.db.prepare(`SELECT * FROM ${table} ${where}`).all(...params);
  }

  /** 检索记账直写：只动访问计数/最近使用时间，不递增 version/updated_at（避免检索索引缓存每次任务后失效） */
  touch(entityType, ids, { access = false, lastUsed = true } = {}) {
    if (!ids?.length) return;
    const table = TABLES[entityType];
    const cols = [];
    const vals = [];
    if (access) cols.push('access_count = access_count + 1');
    if (lastUsed) { cols.push('last_used_at = ?'); vals.push(Date.now()); }
    if (!cols.length) return;
    this.db.prepare(`UPDATE ${table} SET ${cols.join(', ')} WHERE id IN (${ids.map(() => '?').join(', ')})`)
      .run(...vals, ...ids);
  }

  /** 统计记账直写（成功/失败/执行计数/质量分等）：不走乐观锁版本递增，供高频路径（recordExecution/recordOutcome）使用 */
  bumpStats(entityType, id, fields) {
    const table = TABLES[entityType];
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  }

  /** 状态迁移唯一入口（§3.3）：非法迁移直接抛错 */
  transition(entityType, id, toState, extraFields = {}) {
    const table = TABLES[entityType];
    const cur = this.get(entityType, id);
    if (!cur) throw new Error(`${entityType} ${id} 不存在`);
    const legal = STATE_MACHINES[entityType].transitions[cur.state] ?? [];
    if (!legal.includes(toState)) {
      throw new Error(`非法状态迁移: ${entityType} ${id} ${cur.state} → ${toState}（合法: ${legal.join('/') || '无'}）`);
    }
    return this.update(entityType, id, { state: toState, ...extraFields });
  }

  hardDelete(entityType, id) {
    const table = TABLES[entityType];
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  }

  // ── purge_logs（先写日志、后执行变更；EXECUTING → DONE 由调用方驱动）──
  logPurge(entry) {
    const id = entry.id ?? uuid7();
    this.db.prepare(
      `INSERT INTO purge_logs (id, epoch, entity_type, entity_id, action, dimension, reason, evidence, confidence, judge_meta, snapshot_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, entry.epoch, entry.entityType, entry.entityId, entry.action, entry.dimension,
      entry.reason, JSON.stringify(entry.evidence ?? {}), entry.confidence ?? null,
      entry.judgeMeta ? JSON.stringify(entry.judgeMeta) : null, entry.snapshotId ?? null,
      entry.status ?? 'EXECUTING', Date.now());
    return id;
  }
  markPurgeDone(id) {
    this.db.prepare('UPDATE purge_logs SET status = ? WHERE id = ?').run('DONE', id);
  }
  markPurgeRolledBack(id) {
    this.db.prepare('UPDATE purge_logs SET status = ? WHERE id = ?').run('ROLLED_BACK', id);
  }
  purgeLogs(limit = 50) {
    return this.db.prepare('SELECT * FROM purge_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  }
  executingPurges() {
    return this.db.prepare("SELECT * FROM purge_logs WHERE status = 'EXECUTING'").all();
  }

  // ── 墓碑 ──
  addTombstone(entityType, entityId, tokens) {
    this.db.prepare('INSERT INTO tombstones (id, entity_type, content_digest, tokens, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid7(), entityType, entityId, JSON.stringify(tokens.slice(0, 60)), Date.now());
  }
  tombstones() { return this.db.prepare('SELECT * FROM tombstones').all(); }

  // ── 快照（VACUUM INTO + SHA-256，写入 data/snapshots/）──
  snapshot(reason = 'manual') {
    const snapDir = join(this.dataDir, 'snapshots');
    mkdirSync(snapDir, { recursive: true });
    const file = join(snapDir, `snap-${Date.now()}.db`);
    this.db.exec(`VACUUM INTO '${file.replace(/\\/g, '/')}'`);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    const id = uuid7();
    this.db.prepare('INSERT INTO snapshots (id, file, sha256, created_at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(id, basename(file), sha, Date.now(), reason);
    this.trimSnapshots();
    return { id, file, sha256: sha };
  }

  /** 快照滚动保留（最近 SNAPSHOT_KEEP 份，§6.2.4） */
  trimSnapshots() {
    const rows = this.db.prepare('SELECT id, file FROM snapshots ORDER BY created_at DESC').all();
    const excess = rows.slice(CONFIG.SNAPSHOT_KEEP);
    for (const r of excess) {
      const p = join(this.dataDir, 'snapshots', r.file);
      if (existsSync(p)) unlinkSync(p);
      this.db.prepare('DELETE FROM snapshots WHERE id = ?').run(r.id);
    }
  }
  snapshots() { return this.db.prepare('SELECT * FROM snapshots ORDER BY created_at DESC').all(); }

  // ── 坏行转移（数据净化 §6.2.4：禁止原地改写）──
  moveToLostAndFound(entityType, row, problem) {
    const name = `${entityType}-${row.id}.json`;
    const path = join(this.dataDir, 'lost_and_found', name);
    writeFileSync(path, JSON.stringify({ problem, row }, null, 2));
    return name;
  }

  // ── Prompt 注册表（策略净化）──
  activePrompt(role) {
    return this.db.prepare("SELECT * FROM prompt_registry WHERE role = ? AND status = 'active' ORDER BY version DESC LIMIT 1").get(role);
  }
  shadowPrompt(role) {
    return this.db.prepare("SELECT * FROM prompt_registry WHERE role = ? AND status = 'shadow' ORDER BY version DESC LIMIT 1").get(role);
  }
  insertPrompt({ id, role, version, content, sha256, status = 'shadow' }) {
    this.db.prepare('INSERT INTO prompt_registry (id, role, version, content, sha256, status, created_at, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, role, version, content, sha256, status, Date.now(), status === 'active' ? Date.now() : null);
  }
  setPromptStatus(id, status) {
    this.db.prepare('UPDATE prompt_registry SET status = ?, activated_at = CASE WHEN ? = \'active\' THEN ? ELSE activated_at END WHERE id = ?').run(status, status, Date.now(), id);
  }
  prompts(role = null) {
    return role
      ? this.db.prepare('SELECT * FROM prompt_registry WHERE role = ? ORDER BY version DESC').all(role)
      : this.db.prepare('SELECT * FROM prompt_registry ORDER BY role, version DESC').all();
  }

  // ── 调参留痕（§8.3.1：每步变更可审计可回退）──
  logTune({ keyName, oldValue, newValue, reason, goldenGate = 0 }) {
    this.db.prepare('INSERT INTO tune_logs (id, key_name, old_value, new_value, reason, golden_gate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(uuid7(), keyName, JSON.stringify(oldValue), JSON.stringify(newValue), reason, goldenGate ? 1 : 0, Date.now());
  }
  tuneLogs(limit = 30) {
    return this.db.prepare('SELECT * FROM tune_logs ORDER BY created_at DESC LIMIT ?').all(limit);
  }

  // ── 统计 ──
  stats() {
    const s = {};
    for (const [type, table] of Object.entries(TABLES)) {
      s[type] = this.db.prepare(
        `SELECT state, COUNT(*) AS n FROM ${table} GROUP BY state`
      ).all().reduce((acc, r) => { acc[r.state] = r.n; return acc; }, {});
      s[type].total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    }
    s.purge_logs = this.db.prepare("SELECT COUNT(*) AS n FROM purge_logs WHERE status != 'ROLLED_BACK'").get().n;
    // embedding 覆盖率：各实体类型有语义向量的比例
    const embedCoverage = {};
    for (const [type, table] of Object.entries(TABLES)) {
      const total = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
      const withEmbed = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE embedding IS NOT NULL`).get().n;
      if (total > 0) embedCoverage[type] = { withEmbed, total, ratio: Number((withEmbed / total).toFixed(3)) };
    }
    s.embedding_coverage = embedCoverage;
    s.tasks = this.db.prepare("SELECT outcome, COUNT(*) AS n FROM tasks WHERE status != 'running' GROUP BY outcome").all()
      .reduce((acc, r) => { acc[r.outcome] = r.n; return acc; }, {});
    s.golden = this.db.prepare('SELECT COUNT(*) AS n FROM golden_tasks WHERE enabled = 1').get().n;
    return s;
  }
}
