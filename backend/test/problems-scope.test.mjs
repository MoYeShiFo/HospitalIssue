// v1.18.80 问题登记「角色可见范围 + 批量导入」回归：
//   平台管理员 / 院方管理员（role=admin）→ 看全部；
//   登记员（院方 reporter）→ 只看自己登记的（createdBy 账号匹配，或 registrar 显示名匹配——兼容代登记/导入）；
//   公司用户 → 处理人或登记人是自己（显示名），或 createdBy 是自己（账号）。
//   导入：逐行校验、行级错误不中断、registrar 缺省为导入人显示名、createdBy 恒为导入人账号。
// 详情按 id 读取同样受 viewer 过滤（他人记录 404）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3580 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = `${process.pid}-${Date.now()}`;
const tmp = (n) => path.join(os.tmpdir(), `probscope-${n}-${stamp}.json`);
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin123';

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
    SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
    CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
    FILES_DEV_PATH: tmp('files'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[srv] ${d}`));

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未就绪');
}
function cleanup() { try { server.kill(); } catch { /* ignore */ } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

const J = async (url, token, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
};
const login = async (username, password) => {
  const r = await J(`${BASE}/api/auth/login`, null, { method: 'POST', body: JSON.stringify({ username, password }) });
  if (r.status !== 200 || !r.body || !r.body.token) throw new Error(`登录失败 ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
};
const listTitles = async (tk) => {
  const r = await J(`${BASE}/api/problems?page=1&pageSize=200`, tk);
  if (r.status !== 200) throw new Error(`列表失败 ${r.status}: ${JSON.stringify(r.body)}`);
  const items = (r.body && r.body.rows) || [];
  return items.map((x) => x.title);
};

let pass = 0; const failed = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed.push(name); console.error(`  ✗ ${name} ${extra}`); }
}

async function main() {
  await waitReady();

  // ---- 建机构与账号 ----
  const atk = await login('admin', ADMIN_PW);
  const mk = await J(`${BASE}/api/orgs`, atk, { method: 'POST', body: JSON.stringify({ code: 'hyyz', name: '海盐县人民医院' }) });
  check('创建机构', mk.status === 200 || mk.status === 201, JSON.stringify(mk.body));
  const orgId = mk.body && (mk.body.id || (mk.body.org && mk.body.org.id));
  const sw = await J(`${BASE}/api/auth/switch-org`, atk, { method: 'POST', body: JSON.stringify({ orgId }) });
  const atk1 = (sw.body && sw.body.token) || atk;

  const mkUser = (username, extra) => J(`${BASE}/api/users`, atk1, {
    method: 'POST', body: JSON.stringify({ username, name: username, password: 'pass123456', ...extra }),
  });
  const rMgr = await mkUser('mgr1', { role: 'admin', name: '管理员一' });
  const rRep = await mkUser('rep1', { role: 'reporter', name: '登记员甲' });
  const rCom = await mkUser('com1', { role: 'reporter', userType: 'company', name: '工程师乙' });
  check('创建院方管理员 mgr1', rMgr.status === 200 || rMgr.status === 201, JSON.stringify(rMgr.body));
  check('创建登记员 rep1', rRep.status === 200 || rRep.status === 201, JSON.stringify(rRep.body));
  check('创建公司用户 com1', rCom.status === 200 || rCom.status === 201, JSON.stringify(rCom.body));

  const mtk = await login('mgr1', 'pass123456');
  const rtk = await login('rep1', 'pass123456');
  const ctk = await login('com1', 'pass123456');

  // ---- 造数据 ----
  const mkProblem = (tk, fields) => J(`${BASE}/api/problems`, tk, { method: 'POST', body: JSON.stringify({
    title: 'T', department: '信息科', reporter: '张三', type: '故障', severity: '低', description: 'd', ...fields,
  }) });

  // P1: rep1 自己登记 → rep1 可见
  const p1 = await mkProblem(rtk, { title: 'SCOPE-P1-自己登记' });
  // P2: mgr 代登记但登记人写「登记员甲」→ rep1 按姓名可见
  const p2 = await mkProblem(mtk, { title: 'SCOPE-P2-代登记匹配', registrar: '登记员甲' });
  // P3: mgr 登记，与 rep1 无关 → rep1 不可见
  const p3 = await mkProblem(mtk, { title: 'SCOPE-P3-无关' });
  // P4: 处理人=工程师乙 → com1 按姓名可见
  const p4 = await mkProblem(mtk, { title: 'SCOPE-P4-处理人匹配', handler: '工程师乙' });
  // P5: 登记人=工程师乙 → com1 按姓名可见
  const p5 = await mkProblem(mtk, { title: 'SCOPE-P5-登记人匹配', registrar: '工程师乙' });
  // P6: com1 自己登记 → com1 按 createdBy 可见
  const p6 = await mkProblem(ctk, { title: 'SCOPE-P6-公司自建' });
  // P7: 与 com1 无关 → com1 不可见
  const p7 = await mkProblem(mtk, { title: 'SCOPE-P7-公司无关' });

  for (const [n, r] of [['P1', p1], ['P2', p2], ['P3', p3], ['P4', p4], ['P5', p5], ['P7', p7]]) {
    check(`造数据 ${n}`, r.status === 200 || r.status === 201, JSON.stringify(r.body));
  }
  check('造数据 P6（公司用户可登记）', p6.status === 200 || p6.status === 201, JSON.stringify(p6.body));
  const pid = (r) => r.body && (r.body.id || (r.body.rec && r.body.rec.id));
  const id3 = pid(p3);

  // ---- 列表可见范围 ----
  const mgrTitles = await listTitles(mtk);
  const repTitles = await listTitles(rtk);
  const comTitles = await listTitles(ctk);
  check('院方管理员看全部（7 条 SCOPE 记录）', ['P1','P2','P3','P4','P5','P6','P7'].every((k) => mgrTitles.some((t) => t.startsWith(`SCOPE-${k}`))), JSON.stringify(mgrTitles));
  check('登记员只见自己相关（P1/P2）', repTitles.includes('SCOPE-P1-自己登记') && repTitles.includes('SCOPE-P2-代登记匹配'), JSON.stringify(repTitles));
  check('登记员不见无关 P3', !repTitles.some((t) => t.startsWith('SCOPE-P3')), JSON.stringify(repTitles));
  check('登记员不见他人 P4/P5/P7', !repTitles.some((t) => /SCOPE-(P4|P5|P7)/.test(t)), JSON.stringify(repTitles));
  check('公司用户见 P4/P5/P6', ['P4','P5','P6'].every((k) => comTitles.some((t) => t.startsWith(`SCOPE-${k}`))), JSON.stringify(comTitles));
  check('公司用户不见 P1/P2/P3/P7', !comTitles.some((t) => /SCOPE-(P1|P2|P3|P7)/.test(t)), JSON.stringify(comTitles));

  // ---- 详情按 id 同样受限 ----
  const dRep = await J(`${BASE}/api/problems/${id3}`, rtk);
  check('登记员读他人详情 404', dRep.status === 404, `status=${dRep.status}`);
  const dMgr = await J(`${BASE}/api/problems/${id3}`, mtk);
  check('院方管理员读详情 200', dMgr.status === 200, `status=${dMgr.status}`);
  const dCom = await J(`${BASE}/api/problems/${id3}`, ctk);
  check('公司用户读无关详情 404', dCom.status === 404, `status=${dCom.status}`);

  // ---- 平台管理员（admin，未限定成员角色）看全部 ----
  const admTitles = await listTitles(atk1);
  check('平台管理员看全部', ['P1','P3','P7'].every((k) => admTitles.some((t) => t.startsWith(`SCOPE-${k}`))), JSON.stringify(admTitles));

  // ---- 批量导入：2 合法 + 1 缺描述，registrar 缺省为导入人显示名 ----
  const rows = [
    { title: 'SCOPE-IMP-1', department: '内科', reporter: '李四', type: '需求', severity: '中', description: '导入行1' },
    { title: 'SCOPE-IMP-2', department: '外科', reporter: '王五', type: '咨询', severity: '低', description: '导入行2', registrar: '指定登记人' },
    { title: 'SCOPE-IMP-3', department: '骨科', reporter: '赵六', type: '故障', severity: '高' }, // 缺 description → 失败
  ];
  const imp = await J(`${BASE}/api/problems/import`, rtk, { method: 'POST', body: JSON.stringify({ rows }) });
  check('导入返回 200', imp.status === 200, `status=${imp.status} ${JSON.stringify(imp.body)}`);
  check('导入成功 2 失败 1', imp.body && imp.body.created === 2 && imp.body.failed === 1, JSON.stringify(imp.body));
  check('行级错误带行号与原因', imp.body && Array.isArray(imp.body.results) && imp.body.results.some((x) => x.ok === false && x.row === 3 && /描述/.test(x.error || '')), JSON.stringify(imp.body && imp.body.results));

  const repTitles2 = await listTitles(rtk);
  check('导入后登记员可见导入记录（registrar 缺省=登记员甲）', repTitles2.includes('SCOPE-IMP-1'), JSON.stringify(repTitles2));
  const comTitles2 = await listTitles(ctk);
  check('导入记录对公司用户不可见（无关联）', !comTitles2.some((t) => t.startsWith('SCOPE-IMP')), JSON.stringify(comTitles2));

  // 导入空行 / 超限
  const impEmpty = await J(`${BASE}/api/problems/import`, rtk, { method: 'POST', body: JSON.stringify({ rows: [] }) });
  check('空导入 400', impEmpty.status === 400, `status=${impEmpty.status}`);
  const imp501 = await J(`${BASE}/api/problems/import`, rtk, { method: 'POST', body: JSON.stringify({ rows: Array.from({ length: 501 }, (_, i) => ({ title: `X${i}`, department: 'a', reporter: 'b', type: '其他', severity: '低', description: 'c' })) }) });
  check('超 500 行 400', imp501.status === 400, `status=${imp501.status}`);

  // ---- 导出同样遵循可见范围（CSV 行数 = 可见数 + 表头） ----
  const expRep = await fetch(`${BASE}/api/problems/export?format=csv`, { headers: { Authorization: `Bearer ${rtk}` } });
  const csvText = await expRep.text();
  const csvLines = csvText.split('\n').filter((l) => l.trim() !== '');
  const expectedRepCount = (await listTitles(rtk)).length;
  // CSV 首行为「导出条件」说明行，随后是表头，再是数据行 → 数据行数 = 总行数 - 2
  check('导出 CSV 行数与登记员可见数一致', expRep.status === 200 && csvLines.length === expectedRepCount + 2, `lines=${csvLines.length} expected=${expectedRepCount + 2}\n${csvLines.map((l) => l.slice(0, 80)).join('\n')}`);

  console.log(`\n结果：${pass} 通过 / ${failed.length} 失败`);
  if (failed.length) { console.error('失败项：', failed.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); }).finally(() => setTimeout(cleanup, 200));
