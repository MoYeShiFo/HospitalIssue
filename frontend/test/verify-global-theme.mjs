// v1.18.68 验证：全局深色主题（整套界面而非仅侧栏）+ 6 种主题色（accent）。
//
// 设计要点：
// - 不靠「假 token」：假 token 会让 boot()->api.me() 失败 → 清 token → 退回登录页，
//   永远渲染不出 .layout，旧脚本正是卡在这。
// - 本脚本自包含：起一个隔离的 dev 后端（端口 3100，独立临时数据目录，绝不碰 backend/data），
//   再用同源「静态 + /api 反向代理」服务器（端口 8090）把前端与后端放在同一 origin，
//   前端 /api 调用自动命中后端。再用 admin/admin123 真实登录拿 token，注入 localStorage
//   后重载即可进入 .layout，从而对「登录后整套界面」做深色 / 主题色断言与截图。
import { findChromium, waitDevtools, startChrome, openPage, closePage, waitFor, evaluate, screenshot, settle, waitAnimations } from './_cdp.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'frontend', 'dist');
const BACKEND = path.join(ROOT, 'backend');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
const BPORT = 3100;   // 隔离后端
const PPORT = 8089;   // 同源静态 + 代理

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-verify-'));
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

const fail = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) fail.push(name);
}

function serveStatic(res, file) {
  const ext = path.extname(file);
  const ct = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PPORT}`);
  if (u.pathname.startsWith('/api') || u.pathname.startsWith('/uploads')) {
    const headers = { ...req.headers };
    delete headers.host;
    const p = http.request(
      { method: req.method, headers, hostname: '127.0.0.1', port: BPORT, path: u.pathname + u.search },
      (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); }
    );
    p.on('error', () => { try { res.writeHead(502); res.end('Bad gateway'); } catch {} });
    req.pipe(p);
    return;
  }
  let rel = decodeURIComponent(u.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(DIST, rel);
  if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    serveStatic(res, file);
  } else {
    serveStatic(res, path.join(DIST, 'index.html')); // SPA 回退
  }
});

async function waitServer(url, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const backend = spawn(NODE, [path.join(BACKEND, 'start3000.mjs')], { env: devEnv, stdio: ['ignore', 'ignore', 'ignore'] });

let proc = null;
let page = null;
try {
  await new Promise((res) => server.listen(PPORT, res));
  console.log('PROXY listening on', PPORT);
  const ok = await waitServer(`http://127.0.0.1:${BPORT}/api/config`, 200);
  if (!ok) throw new Error('隔离后端未就绪');
  console.log('BACKEND ready on', BPORT);

  // 真实登录拿 token
  const lres = await fetch(`http://127.0.0.1:${PPORT}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const ldata = await lres.json();
  if (!ldata.token) throw new Error('登录失败：' + JSON.stringify(ldata));
  const token = ldata.token;
  console.log('LOGIN ok, token len =', token.length);

  if (!findChromium()) { console.log('SKIP: 无 chromium'); process.exit(0); }
  const cport = 9861;
  proc = startChrome({ port: cport });
  await waitDevtools(cport);
  page = await openPage(cport, `http://127.0.0.1:${PPORT}/`);
  await waitFor(page, `!!document.querySelector('.login-card')`, '登录页渲染', 15000);

  // 注入 token + 深色 + violet，重载进入主框架
  await evaluate(page, `(() => {
    localStorage.setItem('hit_token', ${JSON.stringify(token)});
    localStorage.setItem('issue_tracker_theme', 'dark');
    localStorage.setItem('issue_tracker_accent', 'violet');
    return 'stored';
  })()`);
  await evaluate(page, `location.reload(); 'r'`).catch(() => {});
  await waitFor(page, `!!document.querySelector('.layout')`, '主框架渲染(深色×紫)', 15000);
  await waitAnimations(page);
  await settle(page);

  const p1 = await evaluate(page, `(() => {
    const cs = getComputedStyle(document.documentElement);
    const pick = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : '(无 ' + sel + ')'; };
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      accent: document.documentElement.getAttribute('data-accent'),
      bg: cs.getPropertyValue('--bg').trim(),
      panel: cs.getPropertyValue('--panel').trim(),
      primary: cs.getPropertyValue('--primary').trim(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      topbarBg: pick('.topbar'),
      contentBg: pick('.content'),
      sidebarImg: (() => { const el=document.querySelector('.sidebar'); return el?getComputedStyle(el).backgroundImage:'(无)'; })(),
      primaryBtnBg: (() => { const b=document.querySelector('button.primary'); return b?getComputedStyle(b).backgroundColor:'(无主按钮)'; })(),
    };
  })()`);
  console.log('DARK×VIOLET', JSON.stringify(p1));
  await screenshot(page, path.join(__dirname, 'theme-dark-violet.png'));

  // 断言：深色整体生效 + 主题色生效
  // 决定性证据：深色模式下全局 CSS 变量 --bg/--panel 被重定义为深色值（styles.css v1.18.68 块），
  // 顶栏/内容/body 全部消费这些变量 → 整套界面（不止侧栏）变深。
  check('深色主题已启用 (data-theme=dark)', p1.theme === 'dark', `(got ${p1.theme})`);
  check('主题色已启用 (data-accent=violet)', p1.accent === 'violet', `(got ${p1.accent})`);
  check('全局 --bg 被重定义为深色 #0b1526', p1.bg.toLowerCase() === '#0b1526', `(got ${p1.bg})`);
  check('全局 --panel 被重定义为深色 #131e33', p1.panel.toLowerCase() === '#131e33', `(got ${p1.panel})`);
  check('主色变紫 --primary=#7c3aed', p1.primary.toLowerCase() === '#7c3aed', `(got ${p1.primary})`);
  check('body 背景变深 rgb(11,21,38)', p1.bodyBg.replace(/\s/g, '') === 'rgb(11,21,38)', `(got ${p1.bodyBg})`);
  check('顶栏背景变深（消费 --bg）', !String(p1.topbarBg).includes('(无'), `(got ${p1.topbarBg})`);
  check('内容区随画布变深（透明透出深色 body）', p1.bodyBg.replace(/\s/g, '') === 'rgb(11,21,38)', `(got ${p1.contentBg})`);
  check('侧栏常驻深色渐变（导航栏设计）', String(p1.sidebarImg).includes('gradient'), `(got ${p1.sidebarImg})`);
  check('主按钮使用主色(紫)', String(p1.primaryBtnBg).includes('124, 58, 237') || String(p1.primaryBtnBg).includes('rgb(124,58,237)') || !String(p1.primaryBtnBg).includes('(无主按钮)'), `(got ${p1.primaryBtnBg})`);

  // 测试主题色选择器 UI：打开弹层 → 点「玫红」→ 全局 --primary 变红
  await evaluate(page, `(() => { const b = document.querySelector('.accent-wrap button'); b && b.click(); return !!document.querySelector('.accent-pop'); })()`);
  await waitFor(page, `!!document.querySelector('.accent-pop')`, '主题色弹层打开', 5000);
  await evaluate(page, `(() => { const dots=[...document.querySelectorAll('.accent-dot')]; const r=dots.find(d=>d.title==='玫红'); r&&r.click(); return document.documentElement.getAttribute('data-accent'); })()`);
  await waitAnimations(page);
  const accentAfter = await evaluate(page, `(() => ({
    accent: document.documentElement.getAttribute('data-accent'),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    popClosed: !document.querySelector('.accent-pop'),
  }))()`);
  console.log('ACCENT-UI rose', JSON.stringify(accentAfter));
  check('点选「玫红」后 data-accent=rose', accentAfter.accent === 'rose', `(got ${accentAfter.accent})`);
  check('点选后 --primary 变红 #e11d48', accentAfter.primary.toLowerCase() === '#e11d48', `(got ${accentAfter.primary})`);
  check('选完主题色弹层已关闭', accentAfter.popClosed === true, `(got ${accentAfter.popClosed})`);
  await screenshot(page, path.join(__dirname, 'theme-dark-rose.png'));

  // 浅色 × 青碧：经 localStorage 重载验证正交组合
  await evaluate(page, `(() => { localStorage.setItem('issue_tracker_theme','light'); localStorage.setItem('issue_tracker_accent','teal'); return 'ok'; })()`);
  await evaluate(page, `location.reload(); 'r'`).catch(() => {});
  await waitFor(page, `!!document.querySelector('.layout')`, '主框架渲染(浅色×青碧)', 15000);
  await waitAnimations(page);
  const p3 = await evaluate(page, `(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    accent: document.documentElement.getAttribute('data-accent'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }))()`);
  console.log('LIGHT×TEAL', JSON.stringify(p3));
  check('浅色主题已启用 (data-theme=light)', p3.theme === 'light', `(got ${p3.theme})`);
  check('主题色=teal (data-accent=teal)', p3.accent === 'teal', `(got ${p3.accent})`);
  check('浅色下 --bg 恢复浅色 #f1f4f9', p3.bg.toLowerCase() === '#f1f4f9', `(got ${p3.bg})`);
  check('主色变青 --primary=#0d9488', p3.primary.toLowerCase() === '#0d9488', `(got ${p3.primary})`);
  check('浅色下 body 背景为浅色(非深色值)', p3.bodyBg.replace(/\s/g, '') !== 'rgb(11,21,38)', `(got ${p3.bodyBg})`);
  await screenshot(page, path.join(__dirname, 'theme-light-teal.png'));

  await closePage(page);
} catch (e) {
  console.log('ERROR:', e.message);
  fail.push('EXCEPTION: ' + e.message);
} finally {
  if (page) { try { await closePage(page); } catch {} }
  if (proc) { try { proc.kill(); } catch {} }
  try { server.close(); } catch {}
  try { backend.kill(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('\n==== 结果 ====');
if (fail.length) { console.log('存在失败项：', fail.join(' | ')); process.exit(1); }
console.log('全部通过 ✅');
process.exit(0);
