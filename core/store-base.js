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
    this.db = new DatabaseSync(join(dataDir, 'agent.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  migrate() {
    const sql = readFileSync(join(ROOT, 'store', 'schema.sql'), 'utf8');
    this.db.exec(sql);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
    if (!row || row.v == null) {
      this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(Date.now());
    }
  }

  close() { this.db.close(); }

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
    s.tasks = this.db.prepare("SELECT outcome, COUNT(*) AS n FROM tasks GROUP BY outcome").all()
      .reduce((acc, r) => { acc[r.outcome] = r.n; return acc; }, {});
    s.golden = this.db.prepare('SELECT COUNT(*) AS n FROM golden_tasks WHERE enabled = 1').get().n;
    return s;
  }
}
