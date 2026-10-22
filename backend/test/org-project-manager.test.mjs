// v1.18.81 机构管理「项目经理」回归：
//   org 加 project_manager（公司用户 user_id，可空）；PUT /orgs/:id 校验身份（必须是启用的公司用户）；
//   GET /orgs 附 projectManagerId + projectManagerName（账号被删兜底）；GET /orgs/company-users 候选接口。
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3600 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = `${process.pid}-${Date.now()}`;
const tmp = (n) => path.join(os.tmpdir(), `orgpm-${n}-${stamp}.json`);
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

let pass = 0; const failed = [];
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { failed.push(name); console.error(`  ✗ ${name} ${extra}`); }
}

async function main() {
  await waitReady();

  const atk = await login('admin', ADMIN_PW);
  const mk = await J(`${BASE}/api/orgs`, atk, { method: 'POST', body: JSON.stringify({ code: 'pmorg', name: '项目经理测试医院' }) });
  check('创建机构', mk.status === 200 || mk.status === 201, JSON.stringify(mk.body));
  const orgId = mk.body && (mk.body.id || (mk.body.org && mk.body.org.id));

  const mkUser = (username, extra) => J(`${BASE}/api/users`, atk, {
    method: 'POST', body: JSON.stringify({ username, name: username, password: 'pass123456', ...extra }),
  });
  const rCom = await mkUser('pm_com', { role: 'reporter', userType: 'company', name: '王项目经理' });
  const rHos = await mkUser('pm_hos', { role: 'reporter', name: '李院方' });
  check('创建公司用户', rCom.status === 200 || rCom.status === 201, JSON.stringify(rCom.body));
  check('创建院方用户', rHos.status === 200 || rHos.status === 201, JSON.stringify(rHos.body));
  const comId = rCom.body.id; const hosId = rHos.body.id;

  // ---- company-users 候选接口 ----
  const cu = await J(`${BASE}/api/orgs/company-users`, atk);
  check('company-users 返回 200', cu.status === 200, `status=${cu.status}`);
  check('company-users 仅含公司用户', Array.isArray(cu.body) && cu.body.some((u) => String(u.id) === String(comId)) && !cu.body.some((u) => String(u.id) === String(hosId)), JSON.stringify(cu.body));
  check('company-users 含显示名与账号', cu.body.every((u) => u.name && u.username), JSON.stringify(cu.body));

  // ---- 身份校验 ----
  const rHosPm = await J(`${BASE}/api/orgs/${orgId}`, atk, { method: 'PUT', body: JSON.stringify({ projectManagerId: hosId }) });
  check('院方用户设为项目经理 400', rHosPm.status === 400 && /公司用户/.test(rHosPm.body?.error || ''), JSON.stringify(rHosPm.body));
  const rBad = await J(`${BASE}/api/orgs/${orgId}`, atk, { method: 'PUT', body: JSON.stringify({ projectManagerId: 999999 }) });
  check('不存在用户 404', rBad.status === 404, JSON.stringify(rBad.body));
  const rNeg = await J(`${BASE}/api/orgs/${orgId}`, atk, { method: 'PUT', body: JSON.stringify({ projectManagerId: -5 }) });
  check('非法参数 400', rNeg.status === 400, JSON.stringify(rNeg.body));

  // ---- 设置与回读 ----
  const rSet = await J(`${BASE}/api/orgs/${orgId}`, atk, { method: 'PUT', body: JSON.stringify({ projectManagerId: comId }) });
  check('设置公司用户为项目经理 200', rSet.status === 200, JSON.stringify(rSet.body));
  const ls1 = await J(`${BASE}/api/orgs`, atk);
  const o1 = (ls1.body?.orgs || []).find((o) => String(o.id) === String(orgId));
  check('列表回读 projectManagerId', o1 && Number(o1.projectManagerId) === Number(comId), JSON.stringify(o1));
  check('列表回读 projectManagerName（显示名）', o1 && o1.projectManagerName === '王项目经理', JSON.stringify(o1));

  // ---- 改名不影响项目经理 ----
  const rRename = await J(`${BASE}/api/orgs/${orgId}`, atk, { method: 'PUT', body: JSON.stringify({ name: '项目经理测试医院改' }) });
  check('改名 200', rRename.status === 200, JSON.stringify(rRename.body));
  const ls2 = await J(`${BASE}/api/orgs`, atk);
  const o2 = (ls2.body?.orgs || []).find((o) => String(o.id) === String(orgId));
  check('改名后项目经理保持', o2 && Number(o2.projectManagerId) === Number(comId), JSON.stringify(o2));

  // ---- 清空 ----
  const rClr = await J(`${BASE}/api/orgs/${orgId}`, atk, { method: 'PUT', body: JSON.stringify({ projectManagerId: null }) });
  check('清空项目经理 200', rClr.status === 200, JSON.stringify(rClr.body));
  const ls3 = await J(`${BASE}/api/orgs`, atk);
  const o3 = (ls3.body?.orgs || []).find((o) => String(o.id) === String(orgId));
  check('清空后 projectManagerId=null、名称空', o3 && o3.projectManagerId == null && o3.projectManagerName === '', JSON.stringify(o3));

  console.log(`\n结果：${pass} 通过 / ${failed.length} 失败`);
  if (failed.length) { console.error('失败项：', failed.join(' | ')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1); }).finally(() => setTimeout(cleanup, 200));
