// v1.18.70 端到端：文件管理模块（上传 / 列表分档 / 预览 / 下载 / 删除 / 三档可见性）。
//
// 规则钉住：
//   1) 上传需 file.upload 权限；all_orgs 档仅平台管理员可选（以库为准）；
//   2) 可见性服务端强制：all_orgs=全机构可见 / org=本机构 / org_company=本机构公司用户；
//      平台管理员三档全可见；外机构用户只看得到 all_orgs；
//   3) 跨机构按 id 读（元信息/下载/预览）一律 404，不暴露存在性；
//   4) 预览白名单 inline + nosniff；HTML 等白名单外 302 转强制下载（防同源 XSS）；
//   5) 删除：本人可删自己的；他人需 file.delete；可见不等于可删；
//   6) 删除机构级联清理文件登记 + 磁盘文件；
//   7) 审计日志记录 UPLOAD_FILE / DELETE_FILE。
//
// 运行：cd backend && node test/files-api.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3540 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const tmp = (n) => path.join(os.tmpdir(), `files-${n}-${stamp}.json`);
const uploads = path.join(os.tmpdir(), `files-uploads-${stamp}`);
const tmpFilesDb = tmp('filesdb');

const files = {
  DEV_DB_PATH: tmp('issues'), DEV_USERS_PATH: tmp('users'), AUDIT_DEV_PATH: tmp('audit'),
  SETTINGS_DEV_PATH: tmp('settings'), NOTIFICATIONS_DEV_PATH: tmp('notif'),
  CHAT_DEV_PATH: tmp('chat'), ORGS_DEV_PATH: tmp('orgs'), SCHEDULE_DEV_PATH: tmp('sched'),
  FILES_DEV_PATH: tmpFilesDb,
};

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'files-api-test-secret',
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
  return { status: r.status, body, headers: r.headers };
};
// multipart 上传（字段名 file，与路由 upload.single('file') 一致）
const U = async (url, token, { name, type, content, visibility, remark }) => {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type }), name);
  if (visibility) fd.append('visibility', visibility);
  if (remark != null) fd.append('remark', remark);
  const r = await fetch(url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  let body = null;
  try { body = await r.json(); } catch { /* 空响应 */ }
  return { status: r.status, body };
};
const login = async (username, password) => J(`${BASE}/api/auth/login`, null, {
  method: 'POST', body: JSON.stringify({ username, password }),
});

async function main() {
  await waitReady();

  // ===== 0. 账号与机构准备 =====
  const admin = await login('admin', 'admin123');
  assert(admin.status === 200 && admin.body.user.platformAdmin === true, `平台管理员登录（HTTP ${admin.status}）`);
  const tk = admin.body.token;

  const mk2 = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'zyy', name: '海盐县中医院' }) });
  assert(mk2.status === 201 && mk2.body.id, `新建机构 2（HTTP ${mk2.status}）`);
  const org2 = mk2.body.id;

  // 机构 1：机构管理员（非平台）/ 院方登记员 / 公司用户登记员
  const mkMgr = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'mgr1', name: '信息科管理员', password: 'mgr12345', role: 'admin' }),
  });
  assert(mkMgr.status === 201 || mkMgr.status === 200, `新建机构管理员 mgr1（HTTP ${mkMgr.status}）`);
  const mgr = await login('mgr1', 'mgr12345');
  const mgrTk = mgr.body.token;
  assert(mgr.status === 200 && mgr.body.user.platformAdmin === false, 'mgr1 非平台管理员');

  const mkH = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'huser1', name: '院方用户甲', password: 'huser123', role: 'reporter' }),
  });
  assert(mkH.status === 201 || mkH.status === 200, `新建院方登记员 huser1（HTTP ${mkH.status}）`);
  const huser = await login('huser1', 'huser123');
  const hTk = huser.body.token;

  const mkC = await J(`${BASE}/api/users`, tk, {
    method: 'POST', body: JSON.stringify({ username: 'cuser1', name: '厂商用户甲', password: 'cuser123', role: 'reporter', userType: 'company' }),
  });
  assert((mkC.status === 201 || mkC.status === 200) && mkC.body.userType === 'company', `新建公司用户 cuser1（HTTP ${mkC.status}）`);
  const cuser = await login('cuser1', 'cuser123');
  const cTk = cuser.body.token;

  // 机构 2 专属账号（切到机构 2 再建，归属机构 2）
  const sw2 = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: org2 }) });
  const tk2 = sw2.body.token;
  const mkOrg2 = await J(`${BASE}/api/users`, tk2, {
    method: 'POST', body: JSON.stringify({ username: 'org2user', name: '中医院用户', password: 'org2123', role: 'reporter' }),
  });
  assert(mkOrg2.status === 201 || mkOrg2.status === 200, `机构 2 新建 org2user（HTTP ${mkOrg2.status}）`);
  const org2user = await login('org2user', 'org2123');
  const o2Tk = org2user.body.token;

  // ===== 1. 上传与档位边界 =====
  const upAll = await U(`${BASE}/api/files`, tk, { name: '全机构通报.pdf', type: 'application/pdf', content: 'PDFDATA-ALL', visibility: 'all_orgs', remark: '全员通报' });
  assert(upAll.status === 201 && upAll.body.visibility === 'all_orgs' && upAll.body.org_id === 1,
    `平台管理员上传 all_orgs 档成功（HTTP ${upAll.status}，visibility=${upAll.body.visibility}）`);
  assert(upAll.body.stored_name && upAll.body.uploaded_by === 'admin' && upAll.body.size > 0,
    '上传记录带 stored_name / uploaded_by / size');

  const upOrg = await U(`${BASE}/api/files`, tk, { name: '本机构说明.txt', type: 'text/plain', content: 'TEXTDATA-ORG', visibility: 'org' });
  assert(upOrg.status === 201 && upOrg.body.visibility === 'org', `上传 org 档成功（HTTP ${upOrg.status}）`);

  const upCo = await U(`${BASE}/api/files`, tk, { name: '厂商交付物.png', type: 'image/png', content: 'PNGDATA-CO', visibility: 'org_company' });
  assert(upCo.status === 201 && upCo.body.visibility === 'org_company', `上传 org_company 档成功（HTTP ${upCo.status}）`);

  const mgrUpOrg = await U(`${BASE}/api/files`, mgrTk, { name: '管理员上传.txt', type: 'text/plain', content: 'MGR-ORG', visibility: 'org' });
  assert(mgrUpOrg.status === 201, `机构管理员上传 org 档成功（HTTP ${mgrUpOrg.status}）`);
  const mgrUpAll = await U(`${BASE}/api/files`, mgrTk, { name: '越权共享.pdf', type: 'application/pdf', content: 'X', visibility: 'all_orgs' });
  assert(mgrUpAll.status === 403, `机构管理员上传 all_orgs 档被拒（HTTP ${mgrUpAll.status}）`);

  const hDeny = await U(`${BASE}/api/files`, hTk, { name: '无权限.txt', type: 'text/plain', content: 'X', visibility: 'org' });
  assert(hDeny.status === 403, `无 file.upload 权限的登记员上传被拒（HTTP ${hDeny.status}）`);

  const badVis = await U(`${BASE}/api/files`, tk, { name: '坏档位.txt', type: 'text/plain', content: 'X', visibility: 'everyone' });
  assert(badVis.status === 400, `非法可见范围被拒（HTTP ${badVis.status}）`);

  // ===== 2. 授权 huser1 上传后再传（默认部署为只读资料库，授权后才出现上传面）=====
  const grant = await J(`${BASE}/api/settings`, tk, {
    method: 'PUT',
    body: JSON.stringify({ permissions: { reporter: { menus: ['dashboard', 'issues', 'audited', 'kb', 'files', 'schedule', 'chat', 'timesheet', 'tsconfig'], actions: { 'file.upload': true } } } }),
  });
  assert(grant.status === 200, `平台管理员给登记员授予 file.upload（HTTP ${grant.status}）`);
  const hUp = await U(`${BASE}/api/files`, hTk, { name: '登记员上传.txt', type: 'text/plain', content: 'H-ORG', visibility: 'org' });
  assert(hUp.status === 201, `授权后登记员上传 org 档成功（HTTP ${hUp.status}）`);
  const hUpAll = await U(`${BASE}/api/files`, hTk, { name: '登记员越权.pdf', type: 'application/pdf', content: 'X', visibility: 'all_orgs' });
  assert(hUpAll.status === 403, `登记员上传 all_orgs 档仍被拒（非平台管理员，HTTP ${hUpAll.status}）`);

  // ===== 3. 列表可见性与分档计数 =====
  const hList = await J(`${BASE}/api/files?pageSize=50`, hTk);
  const hNames = (hList.body.rows || []).map((r) => r.original_name);
  assert(hList.status === 200 && hNames.includes('全机构通报.pdf') && hNames.includes('本机构说明.txt') && hNames.includes('管理员上传.txt') && hNames.includes('登记员上传.txt'),
    `院方用户看到 all_orgs + org 全部文件（实测 ${hNames.length} 条）`);
  assert(!hNames.includes('厂商交付物.png'), '院方用户看不到 org_company 档文件');
  assert(hList.body.counts.org_company === 0 && hList.body.counts.all_orgs === 1 && hList.body.counts.org === 3 && hList.body.counts.all === 4,
    `院方用户分档计数正确（all=${hList.body.counts.all}/all_orgs=${hList.body.counts.all_orgs}/org=${hList.body.counts.org}/org_company=${hList.body.counts.org_company}）`);

  const cList = await J(`${BASE}/api/files?pageSize=50`, cTk);
  const cNames = (cList.body.rows || []).map((r) => r.original_name);
  assert(cNames.includes('厂商交付物.png'), '公司用户看到 org_company 档文件');
  assert(cList.body.counts.org_company === 1 && cList.body.counts.org === 3, `公司用户分档计数正确（org_company=${cList.body.counts.org_company}）`);

  const o2List = await J(`${BASE}/api/files?pageSize=50`, o2Tk);
  const o2Names = (o2List.body.rows || []).map((r) => r.original_name);
  assert(o2Names.length === 1 && o2Names[0] === '全机构通报.pdf',
    `外机构用户只看到 all_orgs 档（实测 ${o2Names.length} 条：${o2Names.join('/')}）`);
  assert(o2List.body.counts.org === 0 && o2List.body.counts.org_company === 0, '外机构用户 org / org_company 计数为 0');

  // scope tab 过滤（前端分类即此参数的快捷方式）
  const hScope = await J(`${BASE}/api/files?scope=org_company`, hTk);
  assert(hScope.body.rows.length === 0, `院方用户 scope=org_company → 0 条（实测 ${hScope.body.rows.length}）`);
  const cScope = await J(`${BASE}/api/files?scope=org_company`, cTk);
  assert(cScope.body.rows.length === 1, `公司用户 scope=org_company → 1 条（实测 ${cScope.body.rows.length}）`);

  // 搜索
  const hQ = await J(`${BASE}/api/files?q=${encodeURIComponent('说明')}`, hTk);
  assert((hQ.body.rows || []).length === 1 && hQ.body.rows[0].original_name === '本机构说明.txt',
    `搜索「说明」仅命中 1 条（实测 ${(hQ.body.rows || []).length}）`);

  // ===== 4. 详情 / 下载 / 预览与跨机构红线 =====
  const orgFileId = upOrg.body.id;
  const coFileId = upCo.body.id;
  const o2Meta = await J(`${BASE}/api/files/${orgFileId}`, o2Tk);
  assert(o2Meta.status === 404, `外机构用户按 id 读 org 档文件 → 404（实测 ${o2Meta.status}）`);
  const o2Dl = await J(`${BASE}/api/files/${orgFileId}/download`, o2Tk);
  assert(o2Dl.status === 404, `外机构用户下载 org 档文件 → 404（实测 ${o2Dl.status}）`);
  const hMetaCo = await J(`${BASE}/api/files/${coFileId}`, hTk);
  assert(hMetaCo.status === 404, `院方用户读 org_company 档文件 → 404（实测 ${hMetaCo.status}）`);
  const o2Pv = await J(`${BASE}/api/files/${orgFileId}/preview`, o2Tk);
  assert(o2Pv.status === 404, `外机构用户预览 org 档文件 → 404（实测 ${o2Pv.status}）`);

  const hMeta = await J(`${BASE}/api/files/${orgFileId}`, hTk);
  assert(hMeta.status === 200 && hMeta.body.original_name === '本机构说明.txt', '本机构用户读元信息成功');

  const dlRaw = await fetch(`${BASE}/api/files/${orgFileId}/download`, { headers: { Authorization: `Bearer ${hTk}` } });
  const text = await dlRaw.text();
  assert(dlRaw.status === 200 && /attachment/.test(dlRaw.headers.get('content-disposition') || '') && text === 'TEXTDATA-ORG',
    `下载返回附件头与正确内容（HTTP ${dlRaw.status}）`);

  const pv = await fetch(`${BASE}/api/files/${orgFileId}/preview`, { headers: { Authorization: `Bearer ${hTk}` } });
  const pvText = await pv.text();
  assert(pv.status === 200
    && (pv.headers.get('content-type') || '').startsWith('text/plain')
    && (pv.headers.get('x-content-type-options') || '') === 'nosniff'
    && /inline/.test(pv.headers.get('content-disposition') || '')
    && pvText === 'TEXTDATA-ORG',
    `白名单类型 inline 预览 + nosniff（HTTP ${pv.status}，type=${pv.headers.get('content-type')}）`);

  // HTML 上传 → 预览必须 302 转下载（同源 XSS 防线）。fetch 需 manual 才看得到 302 本身。
  const upHtml = await U(`${BASE}/api/files`, tk, { name: '恶意页面.html', type: 'text/html', content: '<script>alert(1)</script>', visibility: 'org' });
  assert(upHtml.status === 201, `上传 HTML 文件成功（HTTP ${upHtml.status}）`);
  const pvHtml = await fetch(`${BASE}/api/files/${upHtml.body.id}/preview`, {
    headers: { Authorization: `Bearer ${hTk}` }, redirect: 'manual',
  });
  assert(pvHtml.status === 302 && /\/download$/.test(pvHtml.headers.get('location') || ''),
    `HTML 预览被 302 转强制下载（HTTP ${pvHtml.status}，location=${pvHtml.headers.get('location')}）`);

  // ===== 5. 删除边界 =====
  const hFileId = hUp.body.id;
  const delOwn = await J(`${BASE}/api/files/${hFileId}`, hTk, { method: 'DELETE' });
  assert(delOwn.status === 200, `上传者删除本人文件成功（HTTP ${delOwn.status}）`);
  assert(!fs.existsSync(path.join(uploads, hUp.body.stored_name)), '删除后磁盘文件已清理');

  const delOther = await J(`${BASE}/api/files/${orgFileId}`, hTk, { method: 'DELETE' });
  assert(delOther.status === 403, `无 file.delete 权限删他人文件被拒（HTTP ${delOther.status}）`);

  const delMgr = await J(`${BASE}/api/files/${orgFileId}`, mgrTk, { method: 'DELETE' });
  assert(delMgr.status === 200, `有 file.delete 权限的机构管理员删他人文件成功（HTTP ${delMgr.status}）`);
  assert(!fs.existsSync(path.join(uploads, upOrg.body.stored_name)), '他人文件删除后磁盘文件已清理');

  // 可见不等于可删：外机构用户看得见 all_orgs 文件，但删除按「跨机构 id 一律 404」红线处理
  // （删除路由以本机构为作用域，不暴露他机构文件的存在性）
  const o2Del = await J(`${BASE}/api/files/${upAll.body.id}`, o2Tk, { method: 'DELETE' });
  assert(o2Del.status === 404, `外机构用户删除 all_orgs 文件 → 404（跨机构红线，实测 ${o2Del.status}）`);

  // ===== 6. 删除机构 → 级联清理文件 =====
  const mk3 = await J(`${BASE}/api/orgs`, tk, { method: 'POST', body: JSON.stringify({ code: 'fuyou', name: '海盐县妇幼保健院' }) });
  const org3 = mk3.body.id;
  const sw3 = await J(`${BASE}/api/auth/switch-org`, tk, { method: 'POST', body: JSON.stringify({ orgId: org3 }) });
  const up3 = await U(`${BASE}/api/files`, sw3.body.token, { name: '妇幼文件.txt', type: 'text/plain', content: 'ORG3', visibility: 'org' });
  assert(up3.status === 201 && up3.body.org_id === Number(org3), `机构 3 上传文件成功（org_id=${up3.body.org_id}）`);
  const del3 = await J(`${BASE}/api/orgs/${org3}`, tk, { method: 'DELETE' });
  assert(del3.status === 200, `删除机构 3 成功（HTTP ${del3.status}）`);
  const filesDb = JSON.parse(fs.readFileSync(tmpFilesDb, 'utf8'));
  assert(!filesDb.some((r) => String(r.org_id) === String(org3)), '机构删除后文件登记已级联清理');
  assert(!fs.existsSync(path.join(uploads, up3.body.stored_name)), '机构删除后磁盘文件已级联清理');

  // ===== 7. 审计日志 =====
  const auditList = await J(`${BASE}/api/audit?pageSize=100`, tk);
  const auditRows = (auditList.body && auditList.body.rows) || [];
  assert(auditRows.some((a) => a.action === 'UPLOAD_FILE'), '审计日志包含 UPLOAD_FILE');
  assert(auditRows.some((a) => a.action === 'DELETE_FILE'), '审计日志包含 DELETE_FILE');
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
