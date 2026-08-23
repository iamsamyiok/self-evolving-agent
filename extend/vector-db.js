// extend/vector-db.js —— 向量库适配层（§9.1）：统一五接口，本地索引与外部库同构
// MVP+ 实现：本地内存索引（float32 余弦暴力扫，≤5 万条可接受）+ 可选 OpenAI 兼容 Embedding
import { embed } from '../core/llm-adapter.js';

export class LocalVectorIndex {
  constructor() {
    this.vectors = new Map(); // id -> Float32Array
  }

  async upsert(id, text) {
    const v = await embed(text);
    if (v) this.vectors.set(id, v);
    return v != null;
  }

  batchSearch(queryText, topK = 8) {
    // 同步余弦扫（queryText 需先 embed）；无法 embed 时返回空，调用方回落 BM25
    return [];
  }

  delete(id) { this.vectors.delete(id); }
  size() { return this.vectors.size; }

  /** 余弦相似度（float32 TypedArray，禁对象数组逐元素运算，§4.3） */
  static cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
  }

  async search(queryText, topK = 8) {
    const q = await embed(queryText);
    if (!q) return [];
    const out = [];
    for (const [id, v] of this.vectors) {
      out.push({ id, score: LocalVectorIndex.cosine(q, v) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }

  healthCheck() { return { ok: true, size: this.vectors.size, backend: 'local-memory' }; }
}

/** 统一适配层接口（本地与外部实现同构，运行时按 system_state 切换，§9.1） */
export class VectorDB {
  constructor(store, impl = new LocalVectorIndex()) {
    this.store = store;
    this.impl = impl;
    this.enabled = false; // Embedding 端点未配置时禁用（检索回落 BM25）
  }

  async probe() {
    const v = await embed('健康检查 probe');
    this.enabled = v != null;
    this.store.setState('vector_backend', this.impl.healthCheck());
    return this.enabled;
  }

  async upsert(id, text) { return this.enabled ? this.impl.upsert(id, text) : false; }
  async search(query, topK) { return this.enabled ? this.impl.search(query, topK) : []; }
  delete(id) { this.impl.delete(id); }
  status() { return { enabled: this.enabled, ...this.impl.healthCheck() }; }
}
