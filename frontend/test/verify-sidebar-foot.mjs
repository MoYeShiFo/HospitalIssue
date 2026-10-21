// v1.18.69 验证：侧栏布局收尾（顶部紧凑 + 底部页脚终点）+ 行悬停/选中可读性（浅/深两主题）。
// 用法：node test/verify-sidebar-foot.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { findChromium, startChrome, openPage, closePage, waitFor, evaluate, settle, waitAnimations, waitDevtools, screenshot } from './_cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'frontend', 'dist');
const BACKEND = path.join(ROOT, 'backend');
const NODE = 'C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe';
const BPORT = 3130, PPORT = 8095, CPORT = 8135;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-sfoot-'));
const devEnv = { ...process.env, PORT: String(BPORT), DB_DRIVER: 'dev',
  DEV_DB_PATH: path.join(TMP, 'issues.json'), DEV_USERS_PATH: path.join(TMP, 'users.json'),
  AUDIT_DEV_PATH: path.join(TMP, 'audit.json'), SETTINGS_DEV_PATH: path.join(TMP, 'settings.json'),
  NOTIFICATIONS_DEV_PATH: path.join(TMP, 'notifications.json'), CHAT_DEV_PATH: path.join(TMP, 'chat.json'),
  SCHEDULE_DEV_PATH: path.join(TMP, 'schedules.json'), TIMESHEET_USER_DEV_PATH: path.join(TMP, 'timesheet-user.json'),
  ORGS_DEV_PATH: path.join(TMP, 'orgs.json'), UPLOADS_DIR: path.join(TMP, 'uploads') };

function serveStatic(res, file) { const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[path.extname(file)] || 'application/octet-stream'; res.writeHead(200, { 'Content-Type': ct }); fs.createReadStream(file).pipe(res); }
function startProxy() { return new Promise((resolve) => { const s = http.createServer((req, res) => { if (req.url.startsWith('/api')) { const p = http.request({ host: '127.0.0.1', port: BPORT, method: req.method, path: req.url, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); }); p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return; } let u = req.url.split('?')[0]; if (u === '/') u = '/index.html'; const f = path.join(DIST, u); if (fs.existsSync(f) && fs.statSync(f).isFile()) serveStatic(res, f); else serveStatic(res, path.join(DIST, 'index.html')); }); s.listen(PPORT, () => resolve(s)); }); }
function postJSON(url, body) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const u = new URL(url); const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { reject(e); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
async function waitServer() { for (let i = 0; i < 100; i++) { try { const r = await postJSON(`http://127.0.0.1:${BPORT}/api/auth/login`, { username: 'admin', password: '___' }); if (r.status === 401 || r.status === 400) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 150)); } throw new Error('后端未就绪'); }

let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) { pass++; console.log('PASS ', name, detail || ''); } else { fail++; console.log('FAIL ', name, detail || ''); } }
// 兼容两种计算色格式：rgb(r, g, b)（0-255）与 color-mix 产生的 color(srgb r g b)（0-1，需 ×255）。
// ⚠️ color(srgb …) 的括号内第一个 token 是颜色空间名 "srgb"（非数字），必须滤除，否则 Number('srgb')=NaN 整串报废。
function rgbOf(sel) { return `(() => { const el=document.querySelector('${sel}'); if(!el) return null; const s=getComputedStyle(el).backgroundColor; if(!s||s==='transparent') return null; let p; if(s.indexOf('color(')===0){ const inner=s.slice(s.indexOf('(')+1, s.indexOf(')')); p=inner.split(' ').filter(x=>x!==''&&!isNaN(Number(x))).map(Number).map(v=>v*255); } else { const inner=(s.split('(')[1]||'').split(')')[0]; p=inner.split(',').map(x=>parseFloat(x)); } if(p.length<3||p.some(isNaN)) return null; return p.slice(0,3).map(v=>Math.round(v)); })()`; }
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }

async function main() {
  const be = spawn(NODE, ['start3000.mjs'], { cwd: BACKEND, env: devEnv, stdio: 'ignore' });
  await waitServer();
  const proxy = await startProxy();
  const login = await postJSON(`http://127.0.0.1:${PPORT}/api/auth/login`, { username: 'admin', password: 'admin123' });
  const token = login.json?.token || login.json?.data?.token;
  check('登录成功', !!token, 'status=' + login.status);
  if (!token) { process.exit(1); }
  startChrome({ port: CPORT, width: 1280, height: 900 });
  await waitDevtools(CPORT);
  const page = await openPage(CPORT, `http://127.0.0.1:${PPORT}/`);
  await waitFor(page, `location.origin.startsWith('http://127.0.0.1:${PPORT}') && document.readyState === 'complete'`, 'page-ready', 15000);
  await evaluate(page, `localStorage.setItem('hit_token', ${JSON.stringify(token)}); location.reload();`);
  await waitFor(page, "document.querySelector('.sidebar')", 'sidebar');
  await settle(page); await waitAnimations(page);

  // 打开用户管理（同用户截图路径：展开系统管理 → 用户管理），系统管理展开态最考验布局
  await evaluate(page, `(() => { const heads=[...document.querySelectorAll('.nav-group-head')]; const sys=heads.find(h=>(h.textContent||'').includes('系统管理')); if(sys && !sys.classList.contains('open')) sys.click(); return true; })()`);
  await settle(page); await waitAnimations(page);
  await evaluate(page, `(() => { const it=[...document.querySelectorAll('.nav-item')].find(b=>(b.textContent||'').includes('用户管理')); if(it) it.click(); return !!it; })()`);
  await waitFor(page, "document.querySelector('.nav-item.active') && (document.querySelector('.nav-item.active').textContent||'').includes('用户管理')", 'users-active');
  await settle(page); await waitAnimations(page);

  // ===== 布局断言（浅色）=====
  const layout = await evaluate(page, `(() => {
    const sb=document.querySelector('.sidebar').getBoundingClientRect();
    const foot=document.querySelector('.side-foot');
    const fr=foot.getBoundingClientRect();
    const gs=[...document.querySelectorAll('.nav-group')].map(g=>{const r=g.getBoundingClientRect();return {t:Math.round(r.top),b:Math.round(r.bottom),h:Math.round(r.height)};});
    const gaps=[]; for(let i=1;i<gs.length;i++) gaps.push(gs[i].t-gs[i-1].b);
    const nav=document.querySelector('.nav').getBoundingClientRect();
    return { sbH:Math.round(sb.height), sbBottom:Math.round(sb.bottom), footTop:Math.round(fr.top), footBottom:Math.round(fr.bottom),
      footText:(foot.textContent||'').replace(/\\s+/g,' ').trim(), gaps, navBottom:Math.round(nav.bottom), groupCount:gs.length };
  })()`);
  console.log('LAYOUT:', JSON.stringify(layout));
  check('侧栏页脚存在且含版本号', /v1\.18\.69/.test(layout.footText || ''), layout.footText);
  check('页脚吸底（页脚底 ≈ 侧栏底-16px 内边距）', Math.abs(layout.sbBottom - layout.footBottom) <= 20, `sbBottom=${layout.sbBottom} footBottom=${layout.footBottom}`);
  check('分组紧凑（组间距全部 ≤ 16px）', layout.gaps.every((g) => g <= 16), JSON.stringify(layout.gaps));
  check('四个分组齐全', layout.groupCount === 4, 'groups=' + layout.groupCount);
  check('系统管理不再吸底（末组底 < 页脚顶）', layout.navBottom <= layout.footTop + 1, `navBottom=${layout.navBottom} footTop=${layout.footTop}`);
  await screenshot(page, path.join(__dirname, 'sidebar-foot-light.png'));

  // ===== 选中态对比度（侧栏当前项 vs 普通项）=====
  const navContrast = await evaluate(page, `(() => {
    const act=document.querySelector('.nav-item.active'); const plain=[...document.querySelectorAll('.nav-item:not(.active)')].find(b=>b.offsetParent);
    const ab=getComputedStyle(act).backgroundColor, pb=getComputedStyle(plain).backgroundColor;
    const parse=(s)=>{const i=(s.split('(')[1]||'').split(')')[0];return i.split(',').map(x=>parseFloat(x));};
    return { activeBg:ab, plainBg:pb, activeText:getComputedStyle(act).color, plainText:getComputedStyle(plain).color,
      activeBgRGB:parse(ab), plainBgRGB:parse(pb) };
  })()`);
  const dLum = Math.abs(lum(navContrast.activeBgRGB) - lum(navContrast.plainBgRGB));
  check('侧栏当前项底色与普通项亮度差 > 0.02', dLum > 0.02, `Δlum=${dLum.toFixed(3)} active=${navContrast.activeBg}`);
  console.log('NAV-ACTIVE:', JSON.stringify(navContrast));

  // ===== 表格行悬停（浅色）：鼠标移到数据行上，读计算色 =====
  await waitFor(page, "document.querySelectorAll('.content tbody tr').length > 3", 'users-table-rows', 10000);
  await settle(page);
  const rowRect = await evaluate(page, `(() => { const trs=[...document.querySelectorAll('.content tbody tr')]; const tr=trs.find(t=>t.offsetParent && t.getBoundingClientRect().height>0); if(!tr) return null; tr.scrollIntoView({block:'center'}); const r=tr.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
  check('找到数据行', !!rowRect, JSON.stringify(rowRect));
  if (rowRect) {
    // 两步移动：先移开再移入——CDP 鼠标位置跨 reload 持久驻留，若原地重发同一坐标会被当作「无移动」而不刷新 :hover
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    await new Promise((r) => setTimeout(r, 120));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect.x, y: rowRect.y });
    await new Promise((r) => setTimeout(r, 250));
    const hover = await evaluate(page, rgbOf('.content tbody tr:hover'));
    check('浅色行悬停为可见蓝 #e8effc', !!hover && hover[0] === 232 && hover[1] === 239 && hover[2] === 252, JSON.stringify(hover));
    await screenshot(page, path.join(__dirname, 'row-hover-light.png'));
  }

  // ===== 深色主题：行悬停不得再是浅色（白行 leak 已修）=====
  await evaluate(page, `localStorage.setItem('issue_tracker_theme','dark'); location.reload();`);
  await waitFor(page, "document.querySelector('.sidebar')", 'sidebar-dark');
  await settle(page); await waitAnimations(page);
  await evaluate(page, `(() => { const heads=[...document.querySelectorAll('.nav-group-head')]; const sys=heads.find(h=>(h.textContent||'').includes('系统管理')); if(sys && !sys.classList.contains('open')) sys.click(); return true; })()`);
  await settle(page); await waitAnimations(page);
  await evaluate(page, `(() => { const it=[...document.querySelectorAll('.nav-item')].find(b=>(b.textContent||'').includes('用户管理')); if(it) it.click(); return !!it; })()`);
  await waitFor(page, "document.querySelector('.nav-item.active') && (document.querySelector('.nav-item.active').textContent||'').includes('用户管理')", 'users-active-dark');
  await settle(page); await waitAnimations(page);
  const rowRect2 = await evaluate(page, `(() => { const trs=[...document.querySelectorAll('.content tbody tr')]; const tr=trs.find(t=>t.offsetParent && t.getBoundingClientRect().height>0); if(!tr) return null; tr.scrollIntoView({block:'center'}); const r=tr.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}; })()`);
  if (rowRect2) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10 });
    await new Promise((r) => setTimeout(r, 120));
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rowRect2.x, y: rowRect2.y });
    await new Promise((r) => setTimeout(r, 250));
    const diag = await evaluate(page, `(() => { const trs=[...document.querySelectorAll('.content tbody tr')]; const el=document.elementFromPoint(${rowRect2.x}, ${rowRect2.y}); return { rowCount:trs.length, hoverCount:trs.filter(t=>t.matches(':hover')).length, at: el ? (el.tagName + '.' + (el.className||'')) : null, firstRowRect: trs[0] ? JSON.stringify(trs[0].getBoundingClientRect()) : null }; })()`);
    console.log('DARK-HOVER-DIAG:', JSON.stringify(diag), 'target=', JSON.stringify(rowRect2));
    const hoverD = await evaluate(page, rgbOf('.content tbody tr:hover'));
    check('深色行悬停不是浅色（无白行 leak）', !!hoverD && lum(hoverD) < 0.25, JSON.stringify(hoverD));
    await screenshot(page, path.join(__dirname, 'row-hover-dark.png'));
  }
  const footD = await evaluate(page, `(() => { const f=document.querySelector('.side-foot'); const c=getComputedStyle(f); return { color:c.color, borderTop:c.borderTopColor, text:(f.textContent||'').replace(/\\s+/g,' ').trim() }; })()`);
  console.log('FOOT-DARK:', JSON.stringify(footD));
  check('深色页脚可见（含版本号）', /v1\.18\.69/.test(footD.text || ''), footD.text);
  await screenshot(page, path.join(__dirname, 'sidebar-foot-dark.png'));

  await closePage(page);
  try { proxy.close(); } catch {} try { be.kill('SIGTERM'); } catch {}
  console.log(`\n==== 结果 === pass=${pass} fail=${fail} ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
