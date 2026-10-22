// v1.18.70 验证：文件管理模块真实排版与交互（CDP + 隔离 dev 后端 + 同源代理）。
// 断言：导航位置（业务工作组、kb 之后）/ 空态 / 分类 tab 与计数 / 上传弹窗三档
//       （平台管理员 all_orgs 可选）/ UI 上传 → 列表徽标 / 在线预览（文本 + Excel + Word + PPT）/ tab 即时筛选 / 深色主题。
// 用法：node test/verify-files.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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

// Office 样例（用前端同款库在 node 端生成，确保真实可读；验证 v1.18.73 全类型预览）
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const JSZip = require('jszip');
const xlsxSample = path.join(TMP, 'CDP验证表格.xlsx');
{
  const ws = XLSX.utils.aoa_to_sheet([['CDP-XLS-HELLO', '列B'], ['数值', '2']]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  fs.writeFileSync(xlsxSample, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const docxSample = path.join(TMP, 'CDP验证文档.docx');
{
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>CDP-DOCX-HELLO</w:t></w:r></w:p></w:body></w:document>');
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  z.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>');
  fs.writeFileSync(docxSample, await z.generateAsync({ type: 'nodebuffer' }));
}
const pptxSample = path.join(TMP, 'CDP验证演示.pptx');
{
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  z.file('ppt/slides/slide1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>CDP-PPT-HELLO</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
  fs.writeFileSync(pptxSample, await z.generateAsync({ type: 'nodebuffer' }));
}

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

// 通过上传弹窗上传一个本地文件（真实走 DOM.setFileInputFiles → multipart 上传）
async function uploadFile(page, filePath) {
  const name = path.basename(filePath);
  await evaluate(page, `document.querySelector('.fm-page .page-head .btn.primary').click()`);
  await waitFor(page, "document.querySelector('.fm-modal')", 'upload-modal2');
  await settle(page);
  const doc = await page.send('DOM.getDocument', { depth: -1 });
  const inputNode = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.fm-modal input[type=file]' });
  await page.send('DOM.setFileInputFiles', { files: [filePath], nodeId: inputNode.nodeId });
  await settle(page);
  await evaluate(page, `document.querySelector('.fm-modal-foot .primary').click()`);
  // 等待「包含该文件名」的行真正出现（列表里可能已有其他行，不能只等 tbody tr 存在）
  await waitFor(page, `[...document.querySelectorAll('.fm-page tbody tr')].some(r=>(r.textContent||'').includes(${JSON.stringify(name)}))`, 'row-' + name, 10000);
  await settle(page); await waitAnimations(page);
}
// 点击指定文件名所在行的「预览」按钮
async function previewByFile(page, name) {
  await evaluate(page, `(() => { const tr=[...document.querySelectorAll('.fm-page tbody tr')].find(r=>(r.textContent||'').includes(${JSON.stringify(name)})); const b=tr && [...tr.querySelectorAll('td.col-ops button')].find(x=>x.textContent==='预览'); if(b) b.click(); return !!b; })()`);
  await waitFor(page, "document.querySelector('.fm-preview-body')", 'preview-modal2');
  await settle(page); await waitAnimations(page);
}

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
  // 等侧栏分组真正渲染出来（开发后端冷启动可能稍慢），避免查到空结构导致误判
  await waitFor(page, "[...document.querySelectorAll('.nav-group-head')].some(h=>(h.textContent||'').includes('业务工作'))", 'nav-work-group', 5000);
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
  check('副标题含总数说明', /共\s*0\s*项/.test(head.sub || ''), head.sub);
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

  // ===== 6.5 全类型预览（v1.18.73）：Excel / Word / PPT 站内渲染 =====
  await uploadFile(page, xlsxSample);
  await previewByFile(page, 'CDP验证表格.xlsx');
  const xls = await evaluate(page, `(() => { const t=document.querySelector('.fm-xls table'); return { has: t!==null, txt: t && (t.textContent||'').replace(/\\s+/g,' ').trim() }; })()`);
  check('Excel 预览渲染为 HTML 表格且含单元格内容', !!xls.has && (xls.txt || '').includes('CDP-XLS-HELLO'), JSON.stringify(xls));
  await evaluate(page, `document.querySelector('.fm-preview-modal .fm-modal-foot .small').click()`);

  await uploadFile(page, docxSample);
  await previewByFile(page, 'CDP验证文档.docx');
  await waitFor(page, "document.querySelector('.fm-docx-wrap') && document.querySelector('.fm-docx-wrap').childElementCount > 0 && (document.querySelector('.fm-docx-wrap').textContent||'').includes('CDP-DOCX-HELLO')", 'docx-render', 8000);
  const docx = await evaluate(page, `(() => { const w=document.querySelector('.fm-docx-wrap'); return { kids: w? w.childElementCount : 0, txt: w && (w.textContent||'').replace(/\\s+/g,' ').trim() }; })()`);
  check('Word 预览经 docx-preview 渲染出正文', docx.kids > 0 && (docx.txt || '').includes('CDP-DOCX-HELLO'), JSON.stringify(docx));
  await evaluate(page, `document.querySelector('.fm-preview-modal .fm-modal-foot .small').click()`);

  await uploadFile(page, pptxSample);
  await previewByFile(page, 'CDP验证演示.pptx');
  const ppt = await evaluate(page, `(() => { const pre=document.querySelector('.fm-preview-body pre'); return { txt: pre && (pre.textContent||'').replace(/\\s+/g,' ').trim() }; })()`);
  check('PPT 预览抽取大纲文本', (ppt.txt || '').includes('CDP-PPT-HELLO'), JSON.stringify(ppt));
  await evaluate(page, `document.querySelector('.fm-preview-modal .fm-modal-foot .small').click()`);

  // ===== 6.6 添加在线文档链接（v1.18.76）：弹窗 → 提交 → 链接行出现「打开」 =====
  await evaluate(page, `[...document.querySelectorAll('.fm-head-btns .btn')].find(b=>b.textContent.includes('添加链接')).click()`);
  await waitFor(page, "document.querySelector('.fm-modal input[type=url]')", 'link-dialog', 5000);
  await evaluate(page, `(() => {
    const name = document.querySelector('.fm-modal input[type=text]');
    name.value = 'CDP 在线文档链接'; name.dispatchEvent(new Event('input', { bubbles: true }));
    const url = document.querySelector('.fm-modal input[type=url]');
    url.value = 'https://docs.example.com/cdp-link'; url.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(page, `[...document.querySelectorAll('.fm-modal .fm-modal-foot button')].find(b=>b.textContent.includes('添加链接')).click()`);
  await waitFor(page, `[...document.querySelectorAll('.fm-page tbody tr')].some(tr=>tr.textContent.includes('CDP 在线文档链接'))`, 'link-row', 6000);
  const linkRow = await evaluate(page, `(() => {
    const tr = [...document.querySelectorAll('.fm-page tbody tr')].find(tr=>tr.textContent.includes('CDP 在线文档链接'));
    return { hasOpen: !!tr && [...tr.querySelectorAll('button')].some(b=>b.textContent.trim()==='打开'),
      noPreviewDl: !!tr && ![...tr.querySelectorAll('button')].some(b=>b.textContent.trim()==='预览'||b.textContent.trim()==='下载'),
      linkCls: !!tr && !!tr.querySelector('.fm-link-name'),
      badge: tr ? (tr.querySelector('.fm-badge')||{}).textContent : null };
  })()`);
  check('链接行显示「打开」按钮且无预览/下载（🔗 样式 + 徽标）', linkRow.hasOpen && linkRow.noPreviewDl && linkRow.linkCls && (linkRow.badge||'').includes('本机构'), JSON.stringify(linkRow));

  // ===== 6.7 编辑登记信息（v1.18.77）：改链接行备注 → 行内容同步更新 =====
  const linkTr = `[...document.querySelectorAll('.fm-page tbody tr')].find(tr=>tr.textContent.includes('CDP 在线文档链接'))`;
  await evaluate(page, `(() => { const tr = ${linkTr}; if (!tr) return; const b = [...tr.querySelectorAll('button')].find(x=>x.textContent.trim()==='编辑'); if (b) b.click(); })()`);
  await waitFor(page, `document.querySelector('.modal[aria-label="编辑登记信息"] input')`, 'edit-dialog', 5000);
  await evaluate(page, `(() => {
    const remark = document.querySelector('.modal[aria-label="编辑登记信息"] input[placeholder="例如：补充说明"]');
    remark.value = 'CDP 已编辑备注'; remark.dispatchEvent(new Event('input', { bubbles: true }));
    const catSel = document.querySelector('.modal[aria-label="编辑登记信息"] select');
    catSel.value = '运维'; catSel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluate(page, `[...document.querySelectorAll('.modal[aria-label="编辑登记信息"] .fm-modal-foot button')].find(b=>b.textContent.trim()==='保存修改').click()`);
  await waitFor(page, `[...document.querySelectorAll('.fm-page tbody tr')].some(tr=>tr.textContent.includes('CDP 已编辑备注'))`, 'edit-saved', 6000);
  const editChk = await evaluate(page, `(() => {
    const tr = [...document.querySelectorAll('.fm-page tbody tr')].find(tr=>tr.textContent.includes('CDP 已编辑备注'));
    return { found: !!tr, cat: tr ? (tr.querySelector('.fm-cat')||{}).textContent : null,
      badge: tr ? (tr.querySelector('.fm-badge')||{}).textContent : null };
  })()`);
  check('编辑备注/分类保存后行内容同步更新（可见范围徽标不变）', editChk.found && editChk.cat === '运维' && (editChk.badge||'').includes('本机构'), JSON.stringify(editChk));

  // ===== 6.8 分类筛选（v1.18.79）：选「运维」只剩 1 条，回「全部分类」恢复 5 条 =====
  await evaluate(page, `(() => { const s = document.querySelector('.fm-tools .fm-cat-select'); s.value = '运维'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(page, `document.querySelectorAll('.fm-page tbody tr').length === 1`, 'cat-filter', 6000);
  const catF = await evaluate(page, `(() => { const trs=[...document.querySelectorAll('.fm-page tbody tr')]; return { n: trs.length, allOps: trs.every(tr=>(tr.querySelector('.fm-cat')||{}).textContent==='运维') }; })()`);
  check('分类筛选「运维」仅剩该分类条目', catF.n === 1 && catF.allOps, JSON.stringify(catF));
  await evaluate(page, `(() => { const s = document.querySelector('.fm-tools .fm-cat-select'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(page, `document.querySelectorAll('.fm-page tbody tr').length === 5`, 'cat-filter-back', 6000);

  // ===== 7. tab 即时筛选：切「全机构共享」→ 0 条；回「全部」→ 1 条 =====
  await evaluate(page, `[...document.querySelectorAll('.fm-tab')].find(b=>b.textContent.includes('全机构共享')).click()`);
  await waitFor(page, "document.querySelector('.fm-empty')", 'scope-empty', 5000);
  const empty2 = await evaluate(page, `(() => { const e=document.querySelector('.fm-empty'); return { rows: document.querySelectorAll('.fm-page tbody tr').length, text: e && (e.textContent||'').trim() }; })()`);
  check('「全机构共享」tab 即时筛选为 0 条', empty2.rows === 0 && /没有匹配/.test(empty2.text || ''), JSON.stringify(empty2));
  await evaluate(page, `[...document.querySelectorAll('.fm-tab')].find(b=>b.textContent.trim().startsWith('全部')).click()`);
  await waitFor(page, "document.querySelector('.fm-page tbody tr')", 'scope-back');
  const back = await evaluate(page, `document.querySelectorAll('.fm-page tbody tr').length`);
  // 当前列表已有 5 项（txt + xlsx + docx + pptx 4 个文件 + 1 条在线链接，均为本机构档），切回「全部」应恢复 5 条
  check('切回「全部」恢复全部条目（5 条）', back === 5, 'rows=' + back);

  // ===== 8. 深色主题：页面可读、无浅色底 leak =====
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
