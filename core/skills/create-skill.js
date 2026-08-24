// core/skills/create-skill.js
// create_skill: 用户创建新技能（DRAFT，经进化门禁审核后可激活）
import { randomUUID } from 'node:crypto';

export async function createSkill(params, { store }) {
  const { target_name, scenario, description, steps } = params || {};
  if (!store || !scenario || !description) {
    return { output: '请提供：目标技能名（可选）、使用场景、功能描述。示例：{scenario:"查询API文档",description:"自动检索官方文档",steps:["http_get(url)"]}' };
  }
  const id = randomUUID();
  const now = Date.now();
  const name = String(target_name || `skill_${Date.now()}`).slice(0, 60);
  const scenarioStr = String(scenario).slice(0, 200);
  const descStr = String(description).slice(0, 300);
  const stepsJson = JSON.stringify(Array.isArray(steps) ? steps.slice(0, 8) : []);
  store.db.prepare(
    `INSERT INTO skills (id,state,version,parent_id,origin,created_at,updated_at,immunity_until,execution_count,quality_score,embedding,quarantined_at,purge_after,last_used_at,name,scenario,description,steps,params_schema,success_count,fail_count,verified,heat,frozen_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, 'DRAFT', 1, null, 'user_created',
    now, now, 0, 0, 0.5, null, null, null, null,
    name, scenarioStr, descStr, stepsJson, null,
    0, 0, 0, 'warm', null,
  );
  return { output: `技能「${name}」已创建（DRAFT，状态ID：${id}）\n场景：${scenarioStr}\n描述：${descStr}\n步骤：${stepsJson}\n（技能已入库，需经进化门禁审核后生效）` };
}
