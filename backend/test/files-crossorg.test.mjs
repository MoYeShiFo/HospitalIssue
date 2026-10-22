// v1.18.72 端到端：文件管理跨机构可见性修正（平台管理员切换机构后不应看到他机构的文件）。
//
// 背景：v1.18.70 的 canSeeFile 曾对 platformAdmin 直接放行（「平台管理员看全部三档」），
// 与 problems 等模块「切换机构后按当前机构过滤」的口径不一致，也与文件管理自己的
// by-id 路由（getFileById 按 orgId 作用域，跨机构 404）自相矛盾——列表里看得见、
// 点预览/下载却 404。本套件钉住修正后的行为：
//   1) 平台管理员在机构 1 上传 org 档文件 → 切到机构 2 后列表不可见（分档计数 org=0）；
//   2) all_orgs 档文件跨机构可见（该档的设计用途），且任何登录用户可下载；
//   3) 切换后上传落到新机构（切回机构 1 看不到机构 2 的 org 档文件）；
//   4) 平台管理员豁免 org_company 档的用户类型要求，但仅限当前机构内；
//   5) 列表与 by-id 一致：平台管理员在机构 2 按 id 读/预览/下载机构 1 的 org 档文件 → 404。
//
// 运行：cd backend && node test/files-crossorg.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3720 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `filesxorg-${n}-${stamp}.json`);

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
  FILES_DEV_PATH: tmp('files'),
};
const uploads = path.join(os.tmpdir(), `filesxorg-uploads-${stamp}`);

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'files-crossorg-test-secret',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: 'admin123', ADMIN_NAME: 'SystemAdmin',
    UPLOADS_DIR: uploads,
    ...files,
  },
  stdio: 'ignore',
});

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  PASS', msg); }
  else { failed++; console.error('  FAIL', msg); }
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${BASE}/api/config`); if (r.ok) return; } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未就绪');
}
function cleanup() {
  try { server.kill(); } catch { /* ignore */ }
  for (const f of Object.values(files)) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmSync(uploads, { recursive: true, force: true }); } catch { /* ignore */ }
}
const J = async (url, token, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
};
const login = async (username, password) => J(`${BASE}/api/auth/login`, null, {
  method: 'POST', body: JSON.stringify({ username, password }),
});
// 上传（multipart）：字段 file + visibility + remark
async function upload(token, name, visibility, remark = '') {
  const fd = new FormData();
  fd.append('file', new Blob([`文件内容：${name}`], { type: 'text/plain' }), name);
  fd.append('visibility', visibility);
  if (remark) fd.append('remark', remark);
  const r = await fetch(`${BASE}/api/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
}
const listFiles = (token) => J(`${BASE}/api/files`, token);
const switchOrg = (token, orgId) => J(`${BASE}/api/auth/switch-org`, token, {
  method: 'POST', body: JSON.stringify({ orgId }),
});

async function main() {
  await waitReady();

  // ===== 0. 平台管理员登录 + 建第二个机构 =====
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200 && admin.body.user.platformAdmin === true, `平台管理员登录成功（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  const mk = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mk.status === 201 && mk.body.id, `新建机构 2 成功（id=${mk.body && mk.body.id}）`);
  const org2 = mk.body.id;

  // ===== 1. 机构 1 上传 org 档 + all_orgs 档 =====
  const up1 = await upload(tk, 'org1-本机构资料.txt', 'org', '机构 1 内部资料');
  assert(up1.status === 201 && up1.body.visibility === 'org', `机构 1 上传 org 档文件成功（id=${up1.body && up1.body.id}）`);
  const org1FileId = up1.body.id;
  const upShared = await upload(tk, '全机构通报.txt', 'all_orgs', '全院通报');
  assert(upShared.status === 201 && upShared.body.visibility === 'all_orgs',
    `平台管理员上传 all_orgs 档文件成功（id=${upShared.body && upShared.body.id}）`);
  const sharedFileId = upShared.body.id;

  // ===== 2. 切到机构 2：org 档文件不可见（v1.18.72 修正点），all_orgs 档仍可见 =====
  const sw2 = await switchOrg(tk, org2);
  assert(sw2.status === 200 && sw2.body.token, `平台管理员切换到机构 2 成功（HTTP ${sw2.status}）`);
  const tk2 = sw2.body.token;
  const l2 = await listFiles(tk2);
  const names2 = (l2.body.rows || []).map((r) => r.original_name);
  assert(l2.status === 200 && !names2.includes('org1-本机构资料.txt'),
    `切换到机构 2 后看不到机构 1 的 org 档文件（实测 ${names2.length} 条：${names2.join('/') || '空'}）`);
  assert(names2.includes('全机构通报.txt'), '切换到机构 2 后仍能看到 all_orgs 档文件（该档设计用途）');
  assert(l2.body.counts && l2.body.counts.org === 0 && l2.body.counts.all_orgs === 1,
    `机构 2 视角分档计数 org=0、all_orgs=1（实测 org=${l2.body.counts && l2.body.counts.org}/all_orgs=${l2.body.counts && l2.body.counts.all_orgs}）`);

  // ===== 3. 列表与 by-id 一致：机构 2 视角按 id 读/预览/下载机构 1 的 org 档文件 → 404 =====
  const byId = await J(`${BASE}/api/files/${org1FileId}`, tk2);
  assert(byId.status === 404, `机构 2 视角按 id 读机构 1 org 档文件 → 404（实测 ${byId.status}）`);
  const dl = await fetch(`${BASE}/api/files/${org1FileId}/download`, { headers: { Authorization: `Bearer ${tk2}` } });
  assert(dl.status === 404, `机构 2 视角下载机构 1 org 档文件 → 404（实测 ${dl.status}）`);
  const pv = await fetch(`${BASE}/api/files/${org1FileId}/preview`, { headers: { Authorization: `Bearer ${tk2}` }, redirect: 'manual' });
  assert(pv.status === 404, `机构 2 视角预览机构 1 org 档文件 → 404（实测 ${pv.status}）`);
  const dlShared = await fetch(`${BASE}/api/files/${sharedFileId}/download`, { headers: { Authorization: `Bearer ${tk2}` } });
  assert(dlShared.status === 200, `all_orgs 档文件跨机构可下载（HTTP ${dlShared.status}）`);

  // ===== 4. 切换后上传落到新机构；切回机构 1 看不到机构 2 的 org 档文件 =====
  const up2 = await upload(tk2, 'org2-中医院资料.txt', 'org', '机构 2 内部资料');
  assert(up2.status === 201 && String(up2.body.org_id) === String(org2),
    `切换到机构 2 后上传落到机构 2（org_id=${up2.body && up2.body.org_id}）`);
  const swBack = await switchOrg(tk, 1);
  assert(swBack.status === 200 && swBack.body.token, `切回机构 1 成功（HTTP ${swBack.status}）`);
  const tkBack = swBack.body.token;
  const lBack = await listFiles(tkBack);
  const namesBack = (lBack.body.rows || []).map((r) => r.original_name);
  assert(namesBack.includes('org1-本机构资料.txt') && !namesBack.includes('org2-中医院资料.txt'),
    `切回机构 1 后只看机构 1 文件（实测 ${namesBack.join('/') || '空'}）`);
  assert(namesBack.includes('全机构通报.txt'), '切回机构 1 后 all_orgs 档文件仍可见');

  // ===== 5. org_company 档：平台管理员豁免类型要求，但仅限当前机构内 =====
  // 机构 1 建一个公司用户并上传 org_company 档文件
  const mkVendor = await J(`${BASE}/api/users`, tkBack, {
    method: 'POST', body: JSON.stringify({ username: 'vendor1', name: '设备厂商小王', password: 'vendor123', role: 'admin', userType: 'company' }),
  });
  assert((mkVendor.status === 201 || mkVendor.status === 200) && mkVendor.body.userType === 'company',
    `平台管理员创建公司用户 vendor1（HTTP ${mkVendor.status}）`);
  const vendor = await login('vendor1', 'vendor123');
  assert(vendor.status === 200, `vendor1 登录成功（HTTP ${vendor.status}）`);
  const upCompany = await upload(vendor.body.token, 'vendor1-厂商图纸.txt', 'org_company', '仅公司用户可见');
  assert(upCompany.status === 201 && upCompany.body.visibility === 'org_company',
    `公司用户上传 org_company 档文件成功（id=${upCompany.body && upCompany.body.id}）`);

  // 平台管理员（院方类型）在机构 1 → 豁免可见
  const lCompanyAdmin = await listFiles(tkBack);
  const companyNamesAdmin = (lCompanyAdmin.body.rows || []).map((r) => r.original_name);
  assert(companyNamesAdmin.includes('vendor1-厂商图纸.txt'),
    `平台管理员（院方类型）在本机构内可见 org_company 档文件（实测 ${companyNamesAdmin.join('/') || '空'}）`);
  assert(lCompanyAdmin.body.counts && lCompanyAdmin.body.counts.org_company === 1,
    `本机构视角 org_company 计数=1（实测 ${lCompanyAdmin.body.counts && lCompanyAdmin.body.counts.org_company}）`);

  // 切到机构 2 → 不可见（旧 bug 的 org_company 变体）
  const sw2b = await switchOrg(tkBack, org2);
  assert(sw2b.status === 200 && sw2b.body.token, `再次切换到机构 2 成功（HTTP ${sw2b.status}）`);
  const l2b = await listFiles(sw2b.body.token);
  const names2b = (l2b.body.rows || []).map((r) => r.original_name);
  assert(!names2b.includes('vendor1-厂商图纸.txt') && !names2b.includes('org1-本机构资料.txt'),
    `机构 2 视角看不到机构 1 的 org_company / org 档文件（实测 ${names2b.join('/') || '空'}）`);
  assert(l2b.body.counts && l2b.body.counts.org_company === 0,
    `机构 2 视角 org_company 计数=0（实测 ${l2b.body.counts && l2b.body.counts.org_company}）`);
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('  FAIL 套件异常：', (e && e.message) || e);
} finally {
  cleanup();
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
