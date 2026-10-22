// 实施协同 · AI 技能查询（v1.18.51）：自 HIS.OPS AISkillController 移植 5 个模块的服务端部分。
//   1. WXP 底稿查询   /draft-config /hospitals /draft-list /draft-detail —— 走 WXP HTTP（个人凭据，wxpClient）
//   2. TFS 工作项查询 /tfs-config /tfs-query /tfs-item —— 走 TFS REST（Configs/tfs.json，PAT Basic 认证）
//   3. PMIS 交易查询   /pmis-transactions /pmis-transaction-query —— 走 PMIS-MCP callPmisApi（api_id 白名单 + 参数白名单）
//   4. 应用上线确认单 /golive-config /golive-project-detail —— 本地 go-live.json + PMIS 交易 65
//   5. 变更申请单为纯前端表单页（数据填充复用以上接口）；签名图 /signature/:file 供 <img> 引用（不带鉴权头）。
// 错误约定与 timesheet.js 一致：统一 res.json({ success:false, message })，不抛 HTTP 5xx。

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { authenticate } from '../auth/middleware.js';
import { userContext } from '../timesheet/context.js';
import { getWxpSettings, getHospitalConfigsDict, getTimesheetFileConfig } from '../timesheet/configs.js';
import { queryMyCustomerList, queryHospitalDraftsRaw, findDraftRaw } from '../timesheet/wxpClient.js';
import { publicTfsConfig, tfsQueryWorkitems, tfsWorkitemById } from '../timesheet/tfsClient.js';
import { getPmisUserId, callPmisApi } from '../timesheet/pmisMcp.js';
import { getConfigJson } from '../timesheet/configs.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ok = (res, data) => res.json({ success: true, ...data });
const fail = (res, message, extra = {}) => res.json({ success: false, message: message || '操作失败', ...extra });

// ================= 1. WXP 底稿查询 =================

// 颜色/来源字典（对齐 HIS.OPS GetDraftConfig，前端渲染 badge 用）
const DRAFT_CONFIG = {
  statusColors: { 已关闭: 'badge-green', 处理中: 'badge-blue', 待处理: 'badge-amber', 已取消: 'badge-gray', 挂起: 'badge-gray' },
  levelColors: { 高: 'badge-red', 中: 'badge-amber', 低: 'badge-blue' },
  typeColors: { 问题: 'badge-red', 需求: 'badge-blue', 咨询: 'badge-green', 其他: 'badge-gray' },
  sourceMap: { 1: '用户提出', 2: '实施内部', 3: '产品规划', 8: '其他' },
};
// 「我的」口径（v1.18.59）：登录人绑定的 WXP 工号（工时配置 wxpUserCode）优先，
// 未配置回落实际生效凭据的工号（系统默认账号），最后才退登录名（兼容旧前端）。
// 「只看我的」与个人周报都以此工号匹配底稿，不再用登录名（admin 之类匹配不到任何记录）。
router.get('/draft-config', authenticate, async (req, res) => {
  try {
    const { own, cred } = await userContext(req);
    const userCode = own?.wxpUserCode || cred.userCode || req.user.username;
    const userCodeSource = own?.wxpUserCode ? 'own' : (cred.source || 'none');
    return ok(res, { ...DRAFT_CONFIG, userCode, userCodeSource });
  } catch {
    return ok(res, { ...DRAFT_CONFIG, userCode: req.user.username });
  }
});

// 我的医院列表（WXP queryMyCustomerList，按登录人的 WXP 凭据）
router.post('/hospitals', authenticate, async (req, res) => {
  try {
    const { cred } = await userContext(req);
    const r = await queryMyCustomerList(cred);
    if (!r.ok) return fail(res, r.message || '医院列表获取失败', { authFailed: r.authFailed });
    const kw = String(req.body?.keyWord || '').trim();
    let hospitals = r.hospitals;
    if (kw) hospitals = hospitals.filter((h) => (h.hospitalName + h.hospitalCode).includes(kw));
    return ok(res, { hospitals });
  } catch (e) { return fail(res, e?.message || e); }
});

// 底稿列表：单医院或全部授权医院并发（限流 5，对齐 C# SemaphoreSlim(5)）
router.post('/draft-list', authenticate, async (req, res) => {
  try {
    const { cred } = await userContext(req);
    if (!cred.userCode) return fail(res, '请先在「工时配置」里填写 WXP 工号与密码');
    const hospitalId = String(req.body?.hospitalId || '').trim();
    const forceAll = req.body?.forceAll === true;
    const viewId = String(req.body?.viewId || '').trim() || getWxpSettings().draftViewId;

    if (hospitalId && !forceAll) {
      const r = await queryHospitalDraftsRaw(cred, hospitalId, viewId);
      if (!r.ok && r.authFailed) {
        await (await import('../timesheet/wxpClient.js')).invalidateAndRefresh(cred);
        const retry = await queryHospitalDraftsRaw(cred, hospitalId, viewId);
        if (!retry.ok) return fail(res, retry.message || '底稿列表获取失败', { authFailed: retry.authFailed });
        return ok(res, { rows: retry.rows, total: retry.rows.length, errors: [] });
      }
      if (!r.ok) return fail(res, r.message || '底稿列表获取失败', { authFailed: false });
      return ok(res, { rows: r.rows, total: r.rows.length, errors: [] });
    }

    // 全量：并发抓全部授权医院
    const hosp = await queryMyCustomerList(cred);
    if (!hosp.ok) return fail(res, hosp.message || '医院列表获取失败', { authFailed: hosp.authFailed });
    const list = hosp.hospitals.filter((h) => h.hospitalCode);
    const rows = [];
    const errors = [];
    let cursor = 0;
    async function worker() {
      while (cursor < list.length) {
        const h = list[cursor++];
        const r = await queryHospitalDraftsRaw(cred, h.hospitalCode, viewId);
        if (r.ok) {
          for (const row of r.rows) rows.push({ ...row, __hospitalName: h.hospitalName, __hospitalCode: h.hospitalCode });
        } else {
          errors.push(`${h.hospitalName}(${h.hospitalCode}): ${r.message}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, list.length) }, worker));
    return ok(res, { rows, total: rows.length, errors, hospitalCount: list.length });
  } catch (e) { return fail(res, e?.message || e); }
});

// 底稿详情（sheetId 为 19 位长整型字符串，防精度丢失）
router.post('/draft-detail', authenticate, async (req, res) => {
  try {
    const { cred } = await userContext(req);
    const r = await findDraftRaw(cred, req.body?.sheetId);
    if (!r.ok) return fail(res, r.message || '底稿详情获取失败', { authFailed: r.authFailed });
    return ok(res, { data: r.data });
  } catch (e) { return fail(res, e?.message || e); }
});

// ================= 2. TFS 工作项查询 =================

router.get('/tfs-config', authenticate, (req, res) => res.json(publicTfsConfig()));

router.post('/tfs-query', authenticate, async (req, res) => {
  try {
    const b = req.body || {};
    const r = await tfsQueryWorkitems({
      userId: String(b.userId || '').trim(),
      startDate: String(b.startDate || '').trim(),
      endDate: String(b.endDate || '').trim(),
      dateType: ['ResolvedDate', 'ChangedDate', 'CreatedDate'].includes(b.dateType) ? b.dateType : 'ChangedDate',
      collections: Array.isArray(b.collections) ? b.collections : [],
      states: Array.isArray(b.states) ? b.states : [],
      keyword: String(b.keyword || '').trim(),
    });
    return res.json({ success: r.success, total: r.total, rows: r.rows, errors: r.errors });
  } catch (e) { return fail(res, e?.message || e); }
});

router.post('/tfs-item', authenticate, async (req, res) => {
  try {
    const r = await tfsWorkitemById({ id: req.body?.id, collection: req.body?.collection });
    if (!r.success) return fail(res, r.message || 'TFS 工作项查询失败');
    return ok(res, { row: r.row });
  } catch (e) { return fail(res, e?.message || e); }
});

// ================= 3. PMIS 交易查询 =================

// 交易定义（api_id 白名单 + 动态筛选/列定义），来自 Configs/pmis-transactions.json
function pmisTransactions() {
  const j = getConfigJson('pmis-transactions.json', {}) || {};
  const arr = Array.isArray(j.transactions) ? j.transactions : [];
  return arr.filter((t) => t && t.api_id && t.enabled !== false);
}

router.get('/pmis-transactions', authenticate, (req, res) => {
  const list = pmisTransactions().map((t) => ({
    api_id: String(t.api_id),
    name: t.name || `交易 ${t.api_id}`,
    icon: t.icon || '',
    color: t.color || '',
    description: t.description || '',
    params: Array.isArray(t.params) ? t.params : [],
    fields: Array.isArray(t.fields) ? t.fields : [],
    defaultFields: Array.isArray(t.defaultFields) ? t.defaultFields : [],
    longTextFields: Array.isArray(t.longTextFields) ? t.longTextFields : [],
  }));
  return ok(res, { transactions: list });
});

// 交易查询：api_id 必须在白名单内；params 仅保留交易定义声明过的键（防越权，对齐 C#）
router.post('/pmis-transaction-query', authenticate, async (req, res) => {
  try {
    const { auth } = await userContext(req); // 个人 PMIS 令牌（未配置 = null，回落全局 mcp.json）
    const apiId = String(req.body?.api_id || '').trim();
    const t = pmisTransactions().find((x) => String(x.api_id) === apiId);
    if (!t) return fail(res, `交易 ${apiId} 不存在或未启用`);

    const declared = Array.isArray(t.params) ? t.params : [];
    const allowed = new Set(declared.map((p) => p.name));
    const raw = (req.body?.params && typeof req.body.params === 'object') ? req.body.params : {};
    const qp = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!allowed.has(k)) continue; // 白名单外直接丢弃
      const def = declared.find((p) => p.name === k) || {};
      let val = v == null ? '' : String(v).trim();
      if (!val) continue; // 空值不下发
      const dt = def.dataType || def.type || 'text';
      if (dt === 'date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return fail(res, `参数 ${k} 需为 yyyy-MM-dd 日期`);
      } else if (dt === 'int') {
        if (!/^-?\d+$/.test(val)) return fail(res, `参数 ${k} 需为整数`);
      }
      qp[k] = val;
    }
    const userId = await getPmisUserId(auth);
    const { rows, error } = await callPmisApi(apiId, { user_id: userId, query_params: JSON.stringify(qp) }, auth);
    if (error) return fail(res, error);
    return ok(res, { total: rows.length, rows });
  } catch (e) { return fail(res, e?.message || e); }
});

// ================= 4. 应用上线确认单 =================

router.get('/golive-config', authenticate, (req, res) => {
  const j = getConfigJson('go-live.json', {}) || {};
  const hospitals = [];
  for (const [hid, h] of Object.entries(j.HospitalConfigs || {})) {
    if (hid === '__TEMPLATE__' || !h || typeof h !== 'object') continue;
    hospitals.push({
      hospitalId: hid,
      hospitalName: h.hospitalName || '',
      inProjectId: h.inProjectId || '',
      inProjectName: h.inProjectName || '',
    });
  }
  return ok(res, {
    defaultDeveloper: j.DefaultDeveloper || '',
    defaultConclusion: j.DefaultConclusion || '',
    defaultEngineer: j.DefaultEngineer || '',
    modules: Array.isArray(j.Modules) ? j.Modules : [],
    hospitals,
  });
});

// PMIS 交易 65：在建项目详情（按在建项目ID 精确匹配）
router.post('/golive-project-detail', authenticate, async (req, res) => {
  try {
    const pid = parseInt(req.body?.inProjectId, 10);
    if (!Number.isFinite(pid) || pid <= 0) return fail(res, '在建项目 ID 不合法');
    const { auth } = await userContext(req); // 个人 PMIS 令牌（未配置 = null，回落全局 mcp.json）
    const userId = await getPmisUserId(auth);
    if (!userId) return fail(res, '获取 PMIS 用户 ID 失败（PMIS-MCP get_user_token 调用失败）');
    const qp = JSON.stringify({ project_cost_id: pid, execute_status: '', project_status: '' });
    const { rows, error } = await callPmisApi('65', { user_id: userId, query_params: qp }, auth);
    if (error) return fail(res, error);
    const pick = (r, keys) => {
      for (const k of keys) {
        const v = r?.[k];
        if (v != null && String(v).trim()) return String(v).trim();
      }
      return '';
    };
    const row = rows.find((r) => String(r['在建项目ID'] ?? r['项目ID'] ?? '').trim() === String(pid)) || rows[0] || null;
    if (!row) return fail(res, `PMIS 未返回项目 ${pid} 的信息（可能已结项或无权限）`);
    return ok(res, {
      projectName: pick(row, ['在建项目名称', '项目名称']),
      customerName: pick(row, ['客户', '客户名称']),
      managerName: pick(row, ['项目经理', '项目负责人']),
      orgName: pick(row, ['实施机构', '机构名称']),
      contractName: pick(row, ['合同', '合同名称']),
      contractCode: pick(row, ['合同编号']),
      executeStatus: pick(row, ['执行状态', '项目状态']),
      projectType: pick(row, ['项目类型']),
      handoverDate: pick(row, ['移交日期']),
    });
  } catch (e) { return fail(res, e?.message || e); }
});

// ================= 5. 签名图（变更申请单用；<img> 标签带不了 Authorization，故不挂鉴权） =================

router.get('/signature/:name', (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(name) || name.includes('..')) {
    return res.status(400).json({ error: '签名文件名不合法' });
  }
  const dir = path.join(__dirname, '..', '..', 'Configs', 'signatures');
  const file = path.join(dir, name);
  if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.status(404).json({ error: '签名文件不存在' });
  }
  res.sendFile(file);
});

export default router;
