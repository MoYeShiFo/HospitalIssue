// v1.18.75 端到端：UPLOADS_DIR 为相对路径时预览/下载必须正常（修 res.sendFile
// 「path must be absolute or specify root」——config 层强制 path.resolve 绝对化）。
// 复刻生产事故场景：服务器 .env 配 UPLOADS_DIR=uploads（相对值），fs.stat/multer
// 按 CWD 成功而 sendFile 抛 TypeError 被 catch 成「服务器内部错误」。
//
// 运行：cd backend && node test/files-relative-uploads.test.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, '..'); // 以 backend 为 CWD（与 run-server.bat 一致）
const PORT = 3840 + (process.pid % 300);
const BASE = `http://localhost:${PORT}`;
const stamp = Date.now();
const REL_UPLOADS = `uploads-rel-${stamp}`; // 相对值，落 backend/uploads-rel-<stamp>
const uploadsAbs = path.join(backendRoot, REL_UPLOADS);
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin123'; // 与 files-api 夹具一致

const files = {
  DEV_DB_PATH: path.join(os.tmpdir(), `relup-issues-${stamp}.json`),
  DEV_USERS_PATH: path.join(os.tmpdir(), `relup-users-${stamp}.json`),
  AUDIT_DEV_PATH: path.join(os.tmpdir(), `relup-audit-${stamp}.json`),
  SETTINGS_DEV_PATH: path.join(os.tmpdir(), `relup-settings-${stamp}.json`),
  NOTIFICATIONS_DEV_PATH: path.join(os.tmpdir(), `relup-notif-${stamp}.json`),
  CHAT_DEV_PATH: path.join(os.tmpdir(), `relup-chat-${stamp}.json`),
  ORGS_DEV_PATH: path.join(os.tmpdir(), `relup-orgs-${stamp}.json`),
  SCHEDULE_DEV_PATH: path.join(os.tmpdir(), `relup-sched-${stamp}.json`),
  FILES_DEV_PATH: path.join(os.tmpdir(), `relup-files-${stamp}.json`),
};

const server = spawn(process.execPath, [path.join(backendRoot, 'src', 'index.js')], {
  cwd: backendRoot, // 关键：相对 UPLOADS_DIR 按 CWD（backend）解析
  env: {
    ...process.env,
    DB_DRIVER: 'dev', PORT: String(PORT),
    JWT_SECRET: 'relup-test-secret',
    ADMIN_USER: 'admin', ADMIN_PASSWORD: ADMIN_PW, ADMIN_NAME: 'SystemAdmin',
    UPLOADS_DIR: REL_UPLOADS,
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
async function login(username, password) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return (await r.json()).token;
}

async function main() {
  await waitReady();
  const tk = await login('admin', ADMIN_PW);

  const fd = new FormData();
  fd.append('file', new Blob(['RELATIVE-UPLOADS-OK'], { type: 'text/plain' }), '相对路径上传.txt');
  fd.append('visibility', 'org');
  const up = await fetch(`${BASE}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${tk}` }, body: fd });
  const upBody = await up.json();
  assert(up.status === 201 && upBody.stored_name, `相对 UPLOADS_DIR 上传成功（HTTP ${up.status}）`);
  assert(fs.existsSync(path.join(uploadsAbs, upBody.stored_name)), '文件落在「CWD+相对值」位置');

  const pv = await fetch(`${BASE}/api/files/${upBody.id}/preview`, { headers: { Authorization: `Bearer ${tk}` } });
  const pvText = await pv.text();
  assert(pv.status === 200 && pvText.includes('RELATIVE-UPLOADS-OK'),
    `相对 UPLOADS_DIR 预览 200 且内容正确（v1.18.75 前此处报 sendFile 绝对路径 TypeError，实测 ${pv.status}）`);

  const dl = await fetch(`${BASE}/api/files/${upBody.id}/download`, { headers: { Authorization: `Bearer ${tk}` } });
  assert(dl.status === 200, `相对 UPLOADS_DIR 下载 200（实测 ${dl.status}）`);
}

try {
  await main();
} catch (e) {
  failed++;
  console.error('  FAIL 套件异常：', (e && e.message) || e);
} finally {
  try { server.kill(); } catch { /* ignore */ }
  try { fs.rmSync(uploadsAbs, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\nRESULT: passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
