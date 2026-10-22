// TFS 工作项查询客户端（v1.18.51，自 HIS.OPS AISkillController.TfsWorkitemQuery / TfsWorkitemById 移植）。
// 认证：Basic base64(":{pat_token}")，api-version=3.0。
// 流程：POST {base}/{collection}/_apis/wit/wiql 拿 id 列表 → GET .../workitems?ids=...&$expand=fields 分批取详情。
// 配置：backend/Configs/tfs.json（pat_token 仅服务端使用，下发前端时脱敏），模板见 tfs.example.json。

import { getConfigJson } from './configs.js';

export function getTfsConfig() {
  const c = getConfigJson('tfs.json', {}) || {};
  return {
    _comment: c._comment || '',
    baseUrl: String(c.base_url || '').replace(/\/+$/, ''),
    authMethod: c.auth_method || 'pat',
    patToken: c.pat_token || '',
    userId: c.user_id || '',
    userName: c.user_name || '',
    userDomain: c.user_domain || 'WINNING',
    collections: Array.isArray(c.collections) ? c.collections : [],
    pageSize: Number(c.page_size) > 0 ? Number(c.page_size) : 100,
    defaultFields: Array.isArray(c.defaultFields) ? c.defaultFields : [],
    columns: Array.isArray(c.columns) ? c.columns : [],
    configured: Boolean(c.base_url && c.pat_token && c.user_id),
  };
}

/** 下发给前端的脱敏配置（对齐 C# TfsConfig：pat 只露前4后4） */
export function publicTfsConfig() {
  const c = getTfsConfig();
  const p = c.patToken;
  const masked = p ? (p.length > 8 ? `${p.slice(0, 4)}***${p.slice(-4)}` : '***已配置***') : '';
  return {
    success: true,
    configured: c.configured,
    base_url: c.baseUrl,
    user_id: c.userId,
    user_name: c.userName,
    user_domain: c.userDomain,
    collections: c.collections,
    pat_masked: masked,
    defaultFields: c.defaultFields,
    columns: c.columns,
  };
}

function authHeader(cfg) {
  // C# 实现 Basic base64("user:{pat}")；TFS 对 user 段不敏感，保持一致
  return 'Basic ' + Buffer.from(`user:${cfg.patToken}`, 'utf8').toString('base64');
}

async function tfsFetch(url, options = {}, timeoutMs = 30000) {
  const cfg = getTfsConfig();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        Authorization: authHeader(cfg),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {
      throw new Error(`TFS 返回非 JSON（HTTP ${resp.status}）：${text.slice(0, 200)}`);
    }
    if (!resp.ok) {
      const msg = json?.message || `HTTP ${resp.status}`;
      throw new Error(`TFS 请求失败：${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

const DATE_FIELD = {
  ResolvedDate: '[Microsoft.VSTS.Common.ResolvedDate]',
  ChangedDate: '[System.ChangedDate]',
  CreatedDate: '[System.CreatedDate]',
};

function buildWiql({ userId, userDomain, startDate, endDate, dateType, states, keyword }) {
  const field = DATE_FIELD[dateType] || DATE_FIELD.ChangedDate;
  const assigned = `${userDomain || 'WINNING'}\\${userId}`;
  const conds = [`[System.AssignedTo] = '${assigned.replace(/'/g, "''")}'`];
  if (startDate) conds.push(`${field} >= '${startDate}T00:00:00Z'`);
  if (endDate) conds.push(`${field} <= '${endDate}T23:59:59Z'`);
  if (Array.isArray(states) && states.length) {
    const list = states.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ');
    conds.push(`[System.State] IN (${list})`);
  }
  if (keyword) conds.push(`[System.Title] CONTAINS '${String(keyword).replace(/'/g, "''")}'`);
  return [
    'SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType],',
    '[System.CreatedDate], [System.ChangedDate], [Microsoft.VSTS.Common.ResolvedDate],',
    '[Microsoft.VSTS.Scheduling.OriginalEstimate], [Microsoft.VSTS.Scheduling.RemainingWork], [Microsoft.VSTS.Scheduling.CompletedWork]',
    'FROM WorkItems WHERE', conds.join(' AND '),
    'ORDER BY [System.ChangedDate] DESC',
  ].join(' ');
}

function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return v.displayName || v.uniqueName || JSON.stringify(v);
  return String(v);
}

function toRow(wi, collection, project, cfg) {
  const f = wi.fields || {};
  const row = {
    id: wi.id,
    title: str(f['System.Title']),
    state: str(f['System.State']),
    type: str(f['System.WorkItemType']),
    project: str(f['System.TeamProject']) || str(project),
    iterationPath: str(f['System.IterationPath']),
    areaPath: str(f['System.AreaPath']),
    createdDate: str(f['System.CreatedDate']),
    changedDate: str(f['System.ChangedDate']),
    resolvedDate: str(f['Microsoft.VSTS.Common.ResolvedDate']),
    originalEstimate: f['Microsoft.VSTS.Scheduling.OriginalEstimate'] ?? '',
    remainingWork: f['Microsoft.VSTS.Scheduling.RemainingWork'] ?? '',
    completedWork: f['Microsoft.VSTS.Scheduling.CompletedWork'] ?? '',
    collection,
    assignedTo: str(f['System.AssignedTo']),
  };
  const stat = row.resolvedDate || row.changedDate;
  row.statDate = stat;
  const est = Number(row.originalEstimate);
  const rem = Number(row.remainingWork);
  row.aiScore = Number.isFinite(est) && est > 0 && Number.isFinite(rem) ? Math.round((rem / est) * 100) / 100 : '';
  row.url = `${cfg.baseUrl}/${collection}/${row.project}/_workitems?_a=edit&id=${wi.id}`;
  return row;
}

/**
 * 工作项查询。入参 { userId, startDate, endDate, dateType, collections, states, keyword }。
 * 返回 { success, total, rows, errors }。
 */
export async function tfsQueryWorkitems({ userId, startDate, endDate, dateType, collections, states, keyword }) {
  const cfg = getTfsConfig();
  if (!cfg.configured) return { success: false, total: 0, rows: [], errors: ['TFS 未配置：请复制 Configs/tfs.example.json 为 tfs.json 并填入 base_url / pat_token / user_id'] };
  const cols = (Array.isArray(collections) && collections.length) ? collections : cfg.collections;
  const rows = [];
  const errors = [];
  for (const col of cols) {
    try {
      const wiql = await tfsFetch(`${cfg.baseUrl}/${encodeURIComponent(col)}/_apis/wit/wiql?api-version=3.0`, {
        method: 'POST',
        body: JSON.stringify({ query: buildWiql({ userId: userId || cfg.userId, userDomain: cfg.userDomain, startDate, endDate, dateType, states, keyword }) }),
      });
      const ids = (wiql.workItems || []).map((w) => w.id);
      if (!ids.length) continue;
      for (let i = 0; i < ids.length; i += cfg.pageSize) {
        const batch = ids.slice(i, i + cfg.pageSize);
        const detail = await tfsFetch(`${cfg.baseUrl}/_apis/wit/workitems?ids=${batch.join(',')}&api-version=3.0&$expand=fields`);
        for (const wi of detail.value || []) rows.push(toRow(wi, col, col, cfg));
      }
    } catch (err) {
      errors.push(`${col}: ${err?.message || err}`);
    }
  }
  rows.sort((a, b) => String(b.changedDate).localeCompare(String(a.changedDate)));
  return { success: errors.length < cols.length, total: rows.length, rows, errors };
}

/** 单条工作项详情（变更申请单「查找填充」用）。返回 { success, row, message } */
export async function tfsWorkitemById({ id, collection }) {
  const cfg = getTfsConfig();
  if (!cfg.configured) return { success: false, row: null, message: 'TFS 未配置（Configs/tfs.json）' };
  const num = parseInt(id, 10);
  if (!Number.isFinite(num) || num <= 0) return { success: false, row: null, message: 'TFS 编号不合法' };
  const cols = collection ? [collection] : cfg.collections;
  let lastErr = null;
  for (const col of cols) {
    try {
      const wi = await tfsFetch(`${cfg.baseUrl}/_apis/wit/workitems/${num}?api-version=3.0&$expand=fields`);
      if (wi && wi.id) return { success: true, row: toRow(wi, col, wi.fields?.['System.TeamProject'] || col, cfg), message: '' };
    } catch (err) {
      lastErr = err;
    }
  }
  return { success: false, row: null, message: lastErr?.message || `在 ${cols.join('/')} 中未找到工作项 ${num}` };
}
