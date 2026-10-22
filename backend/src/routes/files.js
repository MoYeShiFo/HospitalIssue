import express from 'express';
import path from 'node:path';
import { getFileStore } from '../files/index.js';
import { authenticate } from '../auth/middleware.js';
import { requirePermission, isPlatformAdmin } from '../auth/authorize.js';
import { getSettings } from '../settings/index.js';
import { permissionsFor } from '../permissions.js';
import { config } from '../config.js';
import { upload, repairMojibakeName, removeStoredFiles } from '../services/uploads.js';
import { audit } from '../audit/index.js';
import { send500 } from '../errors.js';
import { canSeeFile, VISIBILITY_LIST } from '../files/visibility.js';

const router = express.Router();

// ── 文件管理（v1.18.70）──
// 三档可见范围由文件的 visibility 字段承载，服务端按 org_id + user_type 强制判定；
// 跨机构按 id 读取一律 404（不暴露存在性）。上传/删除为功能权限（file.upload / file.delete）。

// 预览白名单：仅这些类型允许站内 inline 渲染；其余（含 HTML/SVG —— 同源渲染可窃 token）一律走下载。
const PREVIEW_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv', 'application/json',
]);
// 扩展名 → 固定 Content-Type（优先于上传时记录的 mime，杜绝伪造/误判）
const EXT_TYPE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.log': 'text/plain',
};

// 可预览则返回固定 Content-Type，否则 null（调用方转强制下载）
function previewTypeOf(originalName, mime) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  const byExt = EXT_TYPE[ext];
  if (byExt) return byExt;
  if (mime && PREVIEW_TYPES.has(mime)) return mime;
  return null;
}

// 取文件记录（读路径用）：先按当前机构查；查不到且为 all_orgs 档（显式跨机构共享）时
// 按 id 裸查放行——该档在任何机构的列表可见，按 id 的读/预览/下载必须与列表一致
// （v1.18.72：修正「列表可见但预览/下载 404」）。org / org_company 档跨机构仍一律
// 404（多机构红线，不暴露存在性）。删除路径不用本函数（见 DELETE 路由内的跨机构守卫）。
async function loadFileInOrg(id, orgId) {
  const store = await getFileStore();
  let rec = await store.getFileById(id, orgId);
  if (!rec) {
    const any = await store.getFileById(id, null);
    if (any && any.visibility === 'all_orgs') rec = any;
  }
  if (!rec) return null;
  return { store, rec };
}

// 路由内权限判定（与 problems.js canSeeDeleted 同款模式）：删除他人文件需要 file.delete
async function hasFileDeletePermission(req) {
  const { permissions } = await getSettings(req.orgId);
  return permissionsFor(permissions, req.user.role).actions['file.delete'] === true;
}

// 上传（需「上传文件」权限）。字段：file（multipart）+ visibility + remark。
// all_orgs 档影响面覆盖全部机构，仅平台管理员可选（以库为准，不信 token 声明）。
router.post('/', authenticate, requirePermission('file.upload'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const visibility = String(req.body.visibility || 'org');
    if (!VISIBILITY_LIST.includes(visibility)) {
      return res.status(400).json({ error: '无效的可见范围' });
    }
    if (visibility === 'all_orgs' && !(await isPlatformAdmin(req))) {
      return res.status(403).json({ error: '「全机构共享」仅平台管理员可上传' });
    }
    const remark = String(req.body.remark || '').slice(0, 500);
    const originalName = repairMojibakeName(req.file.originalname);
    const store = await getFileStore();
    const rec = await store.createFile({
      org_id: req.orgId,
      visibility,
      original_name: originalName,
      stored_name: req.file.filename,
      size: req.file.size,
      mime: req.file.mimetype || '',
      remark,
      uploaded_by: req.user.username,
      uploader_name: req.user.name || req.user.username,
      created_at: new Date().toISOString(),
    });
    await audit({
      username: req.user.username,
      action: 'UPLOAD_FILE',
      target: originalName,
      detail: `可见范围：${visibility}`,
    });
    res.status(201).json(rec);
  } catch (e) {
    send500(res, e);
  }
});

// 列表 + 分档计数：q（文件名/备注/上传人模糊）、scope（档位 tab）、page、pageSize。
// 可见性过滤在存储层完成（与 visibility.js 等价）；counts 为可见集合内匹配 q 的各档条数。
// mine：是否本人上传（删除按钮显隐用「本人或 file.delete 权限」，服务端计算，前端不自行比对）。
router.get('/', authenticate, async (req, res) => {
  try {
    const store = await getFileStore();
    const result = await store.listFiles({
      q: req.query.q ? String(req.query.q) : '',
      scope: req.query.scope ? String(req.query.scope) : '',
      page: req.query.page ? Number(req.query.page) : 1,
      pageSize: req.query.pageSize ? Number(req.query.pageSize) : 20,
      orgId: req.orgId,
      user: req.user,
    });
    result.rows = (result.rows || []).map((r) => ({ ...r, mine: r.uploaded_by === req.user.username }));
    res.json(result);
  } catch (e) {
    send500(res, e);
  }
});

// 元信息：不可见（含跨机构）一律 404，不暴露存在性
router.get('/:id', authenticate, async (req, res) => {
  try {
    const found = await loadFileInOrg(req.params.id, req.orgId);
    if (!found || !canSeeFile(found.rec, req.user, req.orgId)) {
      return res.status(404).json({ error: '文件不存在或您无权查看' });
    }
    res.json({ ...found.rec, mine: found.rec.uploaded_by === req.user.username });
  } catch (e) {
    send500(res, e);
  }
});

// 强制下载
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const found = await loadFileInOrg(req.params.id, req.orgId);
    if (!found || !canSeeFile(found.rec, req.user, req.orgId)) {
      return res.status(404).json({ error: '文件不存在或您无权查看' });
    }
    const stored = path.basename(String(found.rec.stored_name || ''));
    if (!stored) return res.status(404).json({ error: '文件不存在或您无权查看' });
    res.download(path.join(config.uploadsDir, stored), repairMojibakeName(found.rec.original_name));
  } catch (e) {
    send500(res, e);
  }
});

// 在线预览：白名单类型 inline（固定 Content-Type + nosniff）；其余 302 转强制下载。
router.get('/:id/preview', authenticate, async (req, res) => {
  try {
    const found = await loadFileInOrg(req.params.id, req.orgId);
    if (!found || !canSeeFile(found.rec, req.user, req.orgId)) {
      return res.status(404).json({ error: '文件不存在或您无权查看' });
    }
    const type = previewTypeOf(found.rec.original_name, found.rec.mime);
    if (!type) {
      // HTML/SVG/Office 等：不允许站内渲染，转强制下载（防同源 XSS）
      return res.redirect(302, `/api/files/${encodeURIComponent(req.params.id)}/download`);
    }
    const stored = path.basename(String(found.rec.stored_name || ''));
    if (!stored) return res.status(404).json({ error: '文件不存在或您无权查看' });
    const full = path.join(config.uploadsDir, stored);
    res.setHeader('Content-Type', type.startsWith('text/') ? `${type}; charset=utf-8` : type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(found.rec.original_name)}`);
    res.sendFile(full);
  } catch (e) {
    send500(res, e);
  }
});

// 删除：上传者本人可删自己的文件；删除他人文件需「删除文件」权限。
// 跨机构（仅可能为 all_orgs 档）仅放行上传者本人——全机构共享文件归上传者所有；
// 非本人的跨机构删除一律 404（多机构红线，不暴露存在性）。物理删磁盘 + 登记记录，写审计日志。
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const found = await loadFileInOrg(req.params.id, req.orgId);
    if (!found) return res.status(404).json({ error: '文件不存在或已被删除' });
    const isOwner = found.rec.uploaded_by === req.user.username;
    if (Number(found.rec.org_id) !== Number(req.orgId) && !isOwner) {
      return res.status(404).json({ error: '文件不存在或已被删除' });
    }
    if (!isOwner && !(await hasFileDeletePermission(req))) {
      return res.status(403).json({ error: '没有执行此操作的权限' });
    }
    const removed = await found.store.deleteFile(req.params.id, found.rec.org_id);
    if (!removed) return res.status(404).json({ error: '文件不存在或已被删除' });
    try {
      await removeStoredFiles([{ storedName: removed.stored_name }]);
    } catch { /* 磁盘文件不存在等情况直接忽略 */ }
    await audit({
      username: req.user.username,
      action: 'DELETE_FILE',
      target: removed.original_name,
      detail: isOwner ? '删除本人上传的文件' : '删除他人上传的文件',
    });
    res.json({ ok: true });
  } catch (e) {
    send500(res, e);
  }
});

export default router;
