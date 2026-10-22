// v1.18.70 验证：文件管理模块真实排版与交互（CDP + 隔离 dev 后端 + 同源代理）。
// 断言：导航位置（业务工作组、kb 之后）/ 空态 / 分类 tab 与计数 / 上传弹窗三档
//       （平台管理员 all_orgs 可选）/ UI 上传 → 列表徽标 / 在线预览文本 / tab 即时筛选 /
//       白名单外类型预览按钮置灰（v1.18.71 修「两个下载」）/ 深色主题。
// 用法：node test/verify-files.mjs
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
const BPORT = 3135, PPORT = 8097, CPORT = 8137;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-files-'));
const uploadSample = path.join(TMP, 'CDP验证文件.txt');
fs.writeFileSync(uploadSample, 'CDP-PREVIEW-TEXT\n文件管理预览验证', 'utf8');

const devEnv = { ...process.env, PORT: String(BPORT), DB_DRIVER: 'dev',
  DEV_DB_PATH: path.join(TMP, 'issues.json'), DEV_USERS_PATH: path.join(TMP, 'users.json'),
  AUDIT_DEV_PATH: path.join(TMP, 'audit.json'), SETTINGS_DEV_PATH: path.join(TMP, 'settings.json'),
  NOTIFICATIONS_DEV_PATH: path.join(TMP, 'notifications.json'), CHAT_DEV_PATH: path.join(TMP, 'chat.json'),
  SCHEDULE_DEV_PATH: path.join(TMP, 'schedules.json'), TIMESHEET_USER_DEV_PATH: path.join(TMP, 'timesheet-user.json'),
  ORGS_DEV_PATH: path.join(TMP, 'orgs.json'), FILES_DEV_PATH: path.join(TMP, 'files.json'),
  UPLOADS_DIR: path.join(TMP, 'uploads') };

function serveStatic(res, file) { const ct = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[path.extname(file)] || 'application/octet-stream'; res.writeHead(200, { 'Content-Type': ct }); fs.createReadStream(file).pipe(res); }
function startProxy() { return new Promise((resolve) => { const s = http.createServer((req, res) => { if (req.url.startsWith('/api')) { const p = http.request({ host: '127.0.0.1', port: BPORT, method: req.method, path: req.url, headers: req.headers }, (pr) => { res.writeHead(pr.statusCode, pr.headers); pr.pipe(res); }); p.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(p); return; } let u = req.url.split('?')[0]; if (u === '/') u = '/index.html'; const f = path.join(DIST, u); if (fs.existsSync(f) && fs.statSync(f).isFile()) serveStatic(res, f); else serveStatic(res, path.join(DIST, 'index.html')); }); s.listen(PPORT, () => resolve(s)); }); }
function postJSON(url, body) { return new Promise((resolve, reject) => { const data = JSON.stringify(body); const u = new URL(url); const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d || '{}') }); } catch (e) { reject(e); } }); }); req.on('error', reject); req.write(data); req.end(); }); }
async function waitServer() { for (let i = 0; i < 100; i++) { try { const r = await postJSON(`http://127.0.0.1:${BPORT}/api/auth/login`, { username: 'admin', password: '___' }); if (r.status === 401 || r.status === 400) return true; } catch { /* */ } await new Promise((r) => setTimeout(r, 150)); } throw new Error('后端未就绪'); }

let pass = 0, fail = 0;
function check(name, ok, detail) { if (ok) { pass++; console.log('PASS ', name, detail || ''); } else { fail++; console.log('FAIL ', name, detail || ''); } }

async function openFilesPage(page) {
  // 展开所在分组（默认展开含当前视图的组；防御性处理折叠态）
  await evaluate(page, `(() => { const heads=[...document.querySelectorAll('.nav-group-head')]; const g=heads.find(h=>(h.textContent||'').includes('业务工作')); if(g && !g.classList.contains('open')) g.click(); return true; })()`);
  await settle(page);
  await evaluate(page, `(() => { const it=[...document.querySelectorAll('.nav-item')].find(b=>(b.textContent||'').trim()==='文件管理'); if(it) it.click(); return !!it; })()`);
  await waitFor(page, "document.querySelector('.fm-page') && document.querySelector('.fm-page').offsetParent !== null", 'files-page');
  await settle(page); await waitAnimations(page);
}

async function main() {
  const be = spawn(NODE, ['start3000.mjs'], { cwd: BACKEND, env: devEnv, stdio: 'ignore' });
  await waitServer();
  const proxy = await startProxy();
  const login = await postJSON(`http://127.0.0.1:${PPORT}/api/auth/login`, { username: 'admin', password: 'admin123' });
  const token = login.json?.token || login.json?.data?.token;
  check('登录成功', !!token, 'status=' + login.status);
  if (!token) { process.exit(1); }
  const chrome = findChromium();
  if (!chrome) { console.log('SKIP 未找到 Chromium'); process.exit(0); }
  startChrome({ port: CPORT, width: 1280, height: 900 });
  await waitDevtools(CPORT);
  const page = await openPage(CPORT, `http://127.0.0.1:${PPORT}/`);
  await waitFor(page, `location.origin.startsWith('http://127.0.0.1:${PPORT}') && document.readyState === 'complete'`, 'page-ready', 15000);
  await evaluate(page, `localStorage.setItem('hit_token', ${JSON.stringify(token)}); location.reload();`);
  await waitFor(page, "document.querySelector('.sidebar')", 'sidebar');
  await settle(page); await waitAnimations(page);

  // ===== 1. 导航位置：业务工作组内，位于「运维知识库」之后 =====
  const navPos = await evaluate(page, `(() => {
    const groups=[...document.querySelectorAll('.nav-group')];
    const work=groups.find(g=>{ const h=g.querySelector('.nav-group-head'); return h && (h.textContent||'').includes('业务工作'); });
    if(!work) return null;
    const items=[...work.querySelectorAll('.nav-item')].map(b=>(b.textContent||'').trim());
    return { items, kbIdx: items.indexOf('运维知识库'), filesIdx: items.indexOf('文件管理') };
  })()`);
  check('「文件管理」在业务工作组', !!navPos && navPos.filesIdx >= 0, JSON.stringify(navPos && navPos.items));
  check('「文件管理」排在「运维知识库」之后', !!navPos && navPos.filesIdx === navPos.kbIdx + 1, `kb=${navPos && navPos.kbIdx} files=${navPos && navPos.filesIdx}`);

  // ===== 2. 空态 =====
  await openFilesPage(page);
  const head = await evaluate(page, `(() => { const h=document.querySelector('.fm-page h1'); const s=document.querySelector('.fm-page .sub'); return { title:h && h.textContent, sub:s && (s.textContent||'').replace(/\\s+/g,' ') }; })()`);
  check('页面标题为「文件管理」', head.title === '文件管理', head.title);
  check('副标题含总数说明', /共\s*0\s*个文件/.test(head.sub || ''), head.sub);
  const emptyText = await evaluate(page, `(() => { const e=document.querySelector('.fm-empty'); return e && (e.textContent||'').trim(); })()`);
  check('空态提示可见', !!emptyText && emptyText.length > 4, emptyText);

  // ===== 3. 分类 tab 与计数 =====
  const tabs = await evaluate(page, `(() => [...document.querySelectorAll('.fm-tab')].map(b=>({ label:(b.textContent||'').replace(/\\s+/g,' ').trim(), active:b.classList.contains('active') })) )()`);
  check('四个分类 tab 齐全', tabs.length === 4 && tabs[0].active, JSON.stringify(tabs));
  check('tab 计数初始为 0', tabs.every((t) => t.label.endsWith('0')), JSON.stringify(tabs.map((t) => t.label)));

  // ===== 4. 上传弹窗：平台管理员三档全可选 =====
  await evaluate(page, `document.querySelector('.fm-page .page-head .btn.primary').click()`);
  await waitFor(page, "document.querySelector('.fm-modal')", 'upload-modal');
  await settle(page);
  const tiers = await evaluate(page, `(() => [...document.querySelectorAll('.fm-tier')].map(l=>({ label:(l.querySelector('b')||{}).textContent, disabled:!!l.querySelector('input:disabled') })) )()`);
  check('上传弹窗含三档可选范围', tiers.length === 3, JSON.stringify(tiers));
  check('平台管理员 all_orgs 档可选（不禁用）', tiers.every((t) => !t.disabled), JSON.stringify(tiers));
  await screenshot(page, path.join(__dirname, 'files-upload.png'));

  // ===== 5. UI 上传（DOM.setFileInputFiles 走真实文件选择路径）=====
  const doc = await page.send('DOM.getDocument', { depth: -1 });
  const inputNode = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.fm-modal input[type=file]' });
  check('上传弹窗有文件选择框', !!inputNode && inputNode.nodeId > 0, 'nodeId=' + (inputNode && inputNode.nodeId));
  await page.send('DOM.setFileInputFiles', { files: [uploadSample], nodeId: inputNode.nodeId });
  await settle(page);
  const picked = await evaluate(page, `(() => { const i=document.querySelector('.fm-modal input[type=file]'); return { hasFile: !!(i && i.files && i.files.length), name: i && i.files[0] && i.files[0].name, btnDisabled: !!document.querySelector('.fm-modal-foot .primary').disabled }; })()`);
  check('文件已选入且上传按钮可用', picked.hasFile && picked.name === 'CDP验证文件.txt' && !picked.btnDisabled, JSON.stringify(picked));
  await evaluate(page, `document.querySelector('.fm-modal-foot .primary').click()`);
  await waitFor(page, "document.querySelector('.fm-page tbody tr')", 'row-appears', 10000);
  await settle(page); await waitAnimations(page);

  const row1 = await evaluate(page, `(() => { const tr=document.querySelector('.fm-page tbody tr'); const badge=tr.querySelector('.fm-badge'); return { text:(tr.textContent||'').replace(/\\s+/g,' ').trim(), badge:badge && badge.textContent }; })()`);
  check('上传后列表出现文件行', !!row1.text && row1.text.includes('CDP验证文件.txt'), row1.text);
  check('徽标显示「本机构」（默认档位）', row1.badge === '本机构', row1.badge);
  const tabs2 = await evaluate(page, `(() => { return [...document.querySelectorAll('.fm-tab')].map(b=>(b.textContent||'').replace(/\\s+/g,' ').trim()); })()`);
  check('分类计数更新（全部=1、本机构=1）', tabs2[0].includes('1') && tabs2[2].includes('1'), JSON.stringify(tabs2));
  await screenshot(page, path.join(__dirname, 'files-light.png'));

  // ===== 6. 在线预览（白名单 txt → 文本展示）=====
  await evaluate(page, `[...document.querySelectorAll('.fm-page tbody tr td.col-ops button')].find(b=>b.textContent==='预览').click()`);
  await waitFor(page, "document.querySelector('.fm-preview-body')", 'preview-modal');
  await settle(page);
  const pv = await evaluate(page, `(() => { const pre=document.querySelector('.fm-preview-body pre'); return { text: pre && (pre.textContent||'').trim(), title: (document.querySelector('.fm-preview-title')||{}).textContent }; })()`);
  check('预览弹窗展示文件文本内容', !!pv.text && pv.text.includes('CDP-PREVIEW-TEXT'), JSON.stringify(pv));
  check('预览标题为文件名', pv.title === 'CDP验证文件.txt', pv.title);
  await screenshot(page, path.join(__dirname, 'files-preview.png'));
  await evaluate(page, `document.querySelector('.fm-preview-modal .fm-modal-foot .small').click()`);

  // ===== 7. tab 即时筛选：切「全机构共享」→ 0 条；回「全部」→ 1 条 =====
  await evaluate(page, `[...document.querySelectorAll('.fm-tab')].find(b=>b.textContent.includes('全机构共享')).click()`);
  await waitFor(page, "document.querySelector('.fm-empty')", 'scope-empty', 5000);
  const empty2 = await evaluate(page, `(() => { const e=document.querySelector('.fm-empty'); return { rows: document.querySelectorAll('.fm-page tbody tr').length, text: e && (e.textContent||'').trim() }; })()`);
  check('「全机构共享」tab 即时筛选为 0 条', empty2.rows === 0 && /没有匹配/.test(empty2.text || ''), JSON.stringify(empty2));
  await evaluate(page, `[...document.querySelectorAll('.fm-tab')].find(b=>b.textContent.trim().startsWith('全部')).click()`);
  await waitFor(page, "document.querySelector('.fm-page tbody tr')", 'scope-back');
  const back = await evaluate(page, `document.querySelectorAll('.fm-page tbody tr').length`);
  check('切回「全部」恢复 1 条', back === 1, 'rows=' + back);

  // ===== 8. 白名单外类型（xlsx）：预览按钮置灰提示、下载按钮可用（v1.18.71 修「两个下载」）=====
  const xlsxSample = path.join(TMP, 'CDP验证表格.xlsx');
  fs.writeFileSync(xlsxSample, 'XLSXDATA', 'utf8');
  const fd = new FormData();
  fd.append('file', new Blob(['XLSXDATA']), 'CDP验证表格.xlsx');
  fd.append('visibility', 'org');
  const upX = await fetch(`http://127.0.0.1:${PPORT}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  check('API 上传 xlsx 成功', upX.status === 201, 'status=' + upX.status);
  await evaluate(page, `location.reload()`);
  await waitFor(page, "document.querySelector('.sidebar')", 'sidebar-reload');
  await settle(page); await waitAnimations(page);
  await openFilesPage(page);
  await waitFor(page, "[...document.querySelectorAll('.fm-page tbody tr')].some(t=>(t.textContent||'').includes('CDP验证表格.xlsx'))", 'xlsx-row', 10000);
  await settle(page); await waitAnimations(page);
  const ops = await evaluate(page, `(() => {
    const trs=[...document.querySelectorAll('.fm-page tbody tr')];
    const tr=trs.find(t=>(t.textContent||'').includes('CDP验证表格.xlsx'));
    if(!tr) return null;
    const btns=[...tr.querySelectorAll('td.col-ops button')];
    const pv=btns.find(b=>b.textContent==='预览');
    const dl=btns.find(b=>b.textContent==='下载');
    return { pvDisabled: pv ? !!pv.disabled : null, pvTitle: pv ? pv.getAttribute('title') : null, dlDisabled: dl ? !!dl.disabled : null, btnTexts: btns.map(b=>b.textContent) };
  })()`);
  check('白名单外类型：预览按钮置灰并带提示', !!ops && ops.pvDisabled === true && /需下载后查看/.test(ops.pvTitle || ''), JSON.stringify(ops));
  check('白名单外类型：下载按钮可用（不再出现两个下载）', !!ops && ops.dlDisabled === false, JSON.stringify(ops));
  await screenshot(page, path.join(__dirname, 'files-light.png'));

  // ===== 9. 深色主题：页面可读、无浅色底 leak =====
  await evaluate(page, `localStorage.setItem('issue_tracker_theme','dark'); location.reload();`);
  await waitFor(page, "document.querySelector('.sidebar')", 'sidebar-dark');
  await settle(page); await waitAnimations(page);
  await openFilesPage(page);
  const dark = await evaluate(page, `(() => {
    const h=document.querySelector('.fm-page h1'); const badge=document.querySelector('.fm-badge');
    const parseRGB=(s)=>{const i=(s.split('(')[1]||'').split(')')[0];return i.split(',').map(x=>parseFloat(x));};
    const lum=(c)=>{const f=(v)=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);};return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]);};
    // 页面底色取 --bg 变量（hex），徽标文字对它的 WCAG 对比度
    const bgHex=(getComputedStyle(document.documentElement).getPropertyValue('--bg')||'#0b1526').trim();
    const bg=bgHex.replace('#','').match(/../g).map(x=>parseInt(x,16));
    const badgeColor=parseRGB(getComputedStyle(badge).color);
    const cText=lum(badgeColor), cBg=lum(bg);
    const ratio=(Math.max(cText,cBg)+0.05)/(Math.min(cText,cBg)+0.05);
    return { theme: document.documentElement.getAttribute('data-theme'), titleColor: h && getComputedStyle(h).color,
      badgeText: getComputedStyle(badge).color, lumTitle: h ? lum(parseRGB(getComputedStyle(h).color)) : null,
      badgeContrast: Math.round(ratio*100)/100 };
  })()`);
  check('深色主题生效', dark.theme === 'dark', 'theme=' + dark.theme);
  check('深色下标题为亮色（lum>0.5）', dark.lumTitle > 0.5, `lum=${dark.lumTitle} color=${dark.titleColor}`);
  check('深色下徽标文字对比度 ≥ 4.5:1（WCAG）', dark.badgeContrast >= 4.5, `ratio=${dark.badgeContrast} color=${dark.badgeText}`);
  await screenshot(page, path.join(__dirname, 'files-dark.png'));

  await closePage(page);
  try { proxy.close(); } catch {} try { be.kill('SIGTERM'); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n==== 结果 === pass=${pass} fail=${fail} ${fail === 0 ? 'ALL PASS' : 'HAS FAILURES'}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
