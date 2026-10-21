// v1.18.68 验证（补）：深色主题下「聊天」界面不再出现白底看不见的问题。
//
// 复用 verify-global-theme.mjs 的同款隔离后端 + 同源代理 + 真实登录思路，
// 但聚焦 Chat：登录后强制 dark + violet，打开「聊天」标签，断言消息画布 .msg-box
// 的计算背景已转深色（不再是 #f7f9fc），并截图 theme-chat-dark.png 作为证据。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findChromium, startChrome, openPage, closePage, waitFor, evaluate, screenshot, settle, waitAnimations, getJson, waitDevtools } from './_cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'frontend', 'dist');
const BACKEND = path.join(ROOT, 'backend');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
const BPORT = 3100;   // 隔离后端
const PPORT = 8089;   // 同源静态 + 代理

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-chat-'));
const devEnv = {
  ...process.env,
  PORT: String(BPORT),
  DB_DRIVER: 'dev',
  DEV_DB_PATH: path.join(TMP, 'issues.json'),
  DEV_USERS_PATH: path.join(TMP, 'users.json'),
  AUDIT_DEV_PATH: path.join(TMP, 'audit.json'),
  SETTINGS_DEV_PATH: path.join(TMP, 'settings.json'),
  NOTIFICATIONS_DEV_PATH: path.join(TMP, 'notifications.json'),
  CHAT_DEV_PATH: path.join(TMP, 'chat.json'),
  SCHEDULE_DEV_PATH: path.join(TMP, 'schedules.json'),
  TIMESHEET_USER_DEV_PATH: path.join(TMP, 'timesheet-user.json'),
  ORGS_DEV_PATH: path.join(TMP, 'orgs.json'),
  UPLOADS_DIR: path.join(TMP, 'uploads'),
};

const ADMIN = process.env.HIT_ADMIN_USER || 'admin';
const ADMIN_PW = process.env.HIT_ADMIN_PW || 'admin123';
const THEME_KEY = 'issue_tracker_theme';
const ACCENT_KEY = 'issue_tracker_accent';
const TOKEN_KEY = 'hit_token';

const fail = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) fail.push(name);
}

function serveStatic(res, file) {
  const ct = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff',
  }[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  fs.createReadStream(file).pipe(res);
}

function startProxy() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/api')) {
        const p = http.request(
          { host: '127.0.0.1', port: BPORT, method: req.method, path: req.url, headers: req.headers },
          (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); },
        );
        p.on('error', () => { res.writeHead(502); res.end('proxy error'); });
        req.pipe(p);
        return;
      }
      let u = req.url.split('?')[0];
      if (u === '/') u = '/index.html';
      const f = path.join(DIST, u);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) serveStatic(res, f);
      else serveStatic(res, path.join(DIST, 'index.html'));
    });
    server.listen(PPORT, () => resolve(server));
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (r) => {
      let d = ''; r.on('data', (c) => { d += c; });
      r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function waitServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await postJSON(`http://127.0.0.1:${BPORT}/api/auth/login`, { username: ADMIN, password: '___probe___' });
      if (r.status === 401 || r.status === 400) return true;
    } catch { /* 端口未就绪，继续等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('后端未在超时内就绪');
}

// 浏览器内：读某元素背景色，返回 [r,g,b]（兼容 rgb() 与 color(srgb ...) 两种格式）
const RGB_OF = `(sel) => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el).backgroundColor; const inner = (s.split('(')[1] || '').split(')')[0]; const p = inner.split(',').map((x) => parseFloat(x)); return p.length >= 3 ? p : null; }`;

async function main() {
  if (!fs.existsSync(DIST)) { console.error('未找到 frontend/dist，请先构建'); process.exit(2); }
  const chromium = findChromium();
  if (!chromium) { console.log('SKIP：未找到 Chromium'); process.exit(0); }

  console.log('启动隔离后端（端口 ' + BPORT + '）…');
  const be = spawn(NODE, ['start3000.mjs'], { cwd: BACKEND, env: devEnv, stdio: 'ignore' });
  be.on('exit', (c) => { if (c) console.log('后端进程退出码 ' + c); });
  await waitServer();
  console.log('后端就绪');

  const proxy = await startProxy();
  console.log('同源代理就绪（端口 ' + PPORT + '）');

  const login = await postJSON(`http://127.0.0.1:${PPORT}/api/auth/login`, { username: ADMIN, password: ADMIN_PW });
  const token = login.json?.token || login.json?.data?.token || login.json?.access_token;
  check('登录成功', !!token, 'status=' + login.status);
  if (!token) { cleanup(); return; }

  const cport = 8123;
  startChrome({ port: cport, width: 1280, height: 880 });
  await waitDevtools(cport);
  const page = await openPage(cport, `http://127.0.0.1:${PPORT}/`);
  // ⚠️ openPage 不等页面提交：导航未 commit 就访问 localStorage 会抛 SecurityError（竞态，偶发）。
  // 先等 origin/readyState 就绪再注入 token。
  await waitFor(page, `location.origin.startsWith('http://127.0.0.1:${PPORT}') && document.readyState === 'complete'`, 'page-ready', 15000);
  await evaluate(page, `localStorage.setItem('${TOKEN_KEY}', ${JSON.stringify(token)}); localStorage.setItem('${THEME_KEY}','dark'); localStorage.setItem('${ACCENT_KEY}','violet'); location.reload();`);
  await waitFor(page, "document.querySelector('.layout') || document.querySelector('.sidebar')", '登录后进入主界面');
  await settle(page);
  await waitAnimations(page);

  const themeAttr = await evaluate(page, "document.documentElement.getAttribute('data-theme')");
  check('data-theme=dark 已应用', themeAttr === 'dark', 'attr=' + themeAttr);

  const bg = await evaluate(page, "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase()");
  check('--bg 为深色 #0b1526', bg === '#0b1526', '--bg=' + bg);

  // 打开聊天（侧栏「沟通协作」分组 → 「聊天」）
  const clickRes = await evaluate(page, `(() => {
    const groups = [...document.querySelectorAll('.nav-group')];
    for (const g of groups) {
      const head = g.querySelector('.nav-group-head');
      if (head && head.textContent.includes('沟通协作')) {
        const items = [...g.querySelectorAll('.nav-item')];
        const anyVisible = items.some((e) => e.offsetParent !== null);
        if (!anyVisible && head) head.click();
      }
    }
    const items = [...document.querySelectorAll('.nav-item')];
    const chat = items.find((e) => e.textContent.includes('聊天'));
    if (chat) { chat.click(); return 'clicked'; }
    return 'notfound';
  })()`);
  check('找到并点击「聊天」导航', clickRes === 'clicked', 'res=' + clickRes);

  if (clickRes === 'clicked') {
    await waitFor(page, "document.querySelector('.msg-box')", '.msg-box 渲染');
    await settle(page);
    await waitAnimations(page);

    const msgBoxRgb = await evaluate(page, `(${RGB_OF})(${JSON.stringify('.msg-box')})`);
    const isF7 = msgBoxRgb && msgBoxRgb[0] === 247 && msgBoxRgb[1] === 249 && msgBoxRgb[2] === 252;
    check('消息画布 .msg-box 不再是白底 #f7f9fc', !isF7, 'rgb=' + (msgBoxRgb ? msgBoxRgb.join(',') : 'null'));
    check('消息画布 .msg-box 为深色', !!msgBoxRgb && msgBoxRgb[0] < 60, 'rgb=' + (msgBoxRgb ? msgBoxRgb.join(',') : 'null'));

    const chatRgb = await evaluate(page, `(${RGB_OF})(${JSON.stringify('.chat')})`);
    check('聊天容器 .chat 为深色', !!chatRgb && chatRgb[0] < 60, 'rgb=' + (chatRgb ? chatRgb.join(',') : 'null'));

    const convRgb = await evaluate(page, `(${RGB_OF})(${JSON.stringify('.conv-item')})`);
    if (!convRgb) console.log('SKIP  会话列表项（当前无会话数据）');
    else {
      const white = convRgb[0] > 230 && convRgb[1] > 230 && convRgb[2] > 230;
      check('会话列表项非白底', !white, 'rgb=' + convRgb.join(','));
    }
  } else {
    console.log('SKIP 聊天相关断言（未能定位聊天导航）');
  }

  const shot = path.join(__dirname, 'theme-chat-dark.png');
  await screenshot(page, shot);
  console.log('截图已保存：' + shot);

  await closePage(page);

  console.log('\\n==== 结果 ====');
  if (fail.length) console.log('FAIL: ' + fail.join(' | '));
  else console.log('ALL PASS');

  cleanup();
  process.exit(fail.length ? 1 : 0);

  function cleanup() {
    try { proxy.close(); } catch { /* ignore */ }
    try { be.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
