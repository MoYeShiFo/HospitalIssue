import fs from 'node:fs/promises';
import path from 'node:path';
import { VISIBILITY, VISIBILITY_LIST, canSeeFile } from './visibility.js';
import { DEFAULT_ORG_ID } from '../db/orgScope.js';

// dev / 测试用：本地 JSON 文件存储（文件管理，v1.18.70）。
// 统一记录字段：{ id, org_id, visibility, original_name, stored_name, size, mime, remark,
//                uploaded_by, uploader_name, created_at }
export function createDevFileStore(filePath) {
  let cache = null;

  async function load() {
    if (cache) return cache;
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      cache = JSON.parse(raw);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      cache = [];
      await fs.writeFile(filePath, '[]', 'utf8');
    }
    return cache;
  }

  async function save(data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    cache = data;
  }

  function normalize(rec, id) {
    return {
      id,
      org_id: rec.org_id == null ? DEFAULT_ORG_ID : Number(rec.org_id),
      visibility: VISIBILITY_LIST.includes(rec.visibility) ? rec.visibility : VISIBILITY.ORG,
      original_name: rec.original_name || '',
      stored_name: rec.stored_name || '',
      size: Number(rec.size) || 0,
      mime: rec.mime || '',
      remark: rec.remark || '',
      uploaded_by: rec.uploaded_by || '',
      uploader_name: rec.uploader_name || '',
      link_url: rec.link_url || '',
      created_at: rec.created_at || new Date().toISOString(),
    };
  }

  function nextId(records) {
    return records.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  }

  return {
    async init() { await load(); },

    // 列表：先按可见性规则过滤（visibility.js），再应用搜索词与档位 tab，分页 + 分档计数。
    // counts 口径 = 可见集合内匹配搜索词、忽略 scope 的各档条数（搜索时计数同步变化）。
    async listFiles({ q, scope, page = 1, pageSize = 20, orgId, user } = {}) {
      const records = await load();
      let visible = records.filter((r) => canSeeFile(r, user, orgId));
      if (q) {
        const k = String(q).toLowerCase();
        visible = visible.filter((r) =>
          [r.original_name, r.remark, r.uploader_name].join(' ').toLowerCase().includes(k));
      }
      const counts = { all: visible.length, all_orgs: 0, org: 0, org_company: 0 };
      for (const r of visible) {
        if (counts[r.visibility] != null) counts[r.visibility] += 1;
      }
      if (scope) visible = visible.filter((r) => r.visibility === scope);
      const sorted = [...visible].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id);
      const total = sorted.length;
      const start = (Number(page) - 1) * Number(pageSize);
      const rows = sorted.slice(start, start + Number(pageSize)).map((r) => ({ ...r }));
      return { rows, total, counts, page: Number(page), pageSize: Number(pageSize) };
    },

    // 按 id 取原始记录（仅限当前机构；跨机构一律视为不存在 —— 多机构红线）。
    // 可见性判定不在此处：由路由层用 canSeeFile 决定 404/403。
    async getFileById(id, orgId) {
      const records = await load();
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const rec = records.find((r) => r.id === num
        && (orgId == null || Number(r.org_id) === Number(orgId))) || null;
      return rec ? { ...rec } : null;
    },

    async createFile(rec) {
      const records = await load();
      const row = normalize(rec, nextId(records));
      records.push(row);
      await save(records);
      return { ...row };
    },

    // 物理删除：返回被删记录（含 stored_name，调用方据此清理磁盘文件）；不存在返回 null。
    async deleteFile(id, orgId) {
      const records = await load();
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const idx = records.findIndex((r) => r.id === num
        && (orgId == null || Number(r.org_id) === Number(orgId)));
      if (idx === -1) return null;
      const [rec] = records.splice(idx, 1);
      await save(records);
      return { ...rec };
    },

    // 局部更新（v1.18.77 编辑：可见范围/备注；链接行还可改名称与 URL）。仅改传入字段。
    async updateFile(id, orgId, patch = {}) {
      const records = await load();
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const rec = records.find((r) => r.id === num
        && (orgId == null || Number(r.org_id) === Number(orgId)));
      if (!rec) return null;
      for (const k of ['visibility', 'remark', 'original_name', 'link_url']) {
        if (patch[k] != null) rec[k] = patch[k];
      }
      await save(records);
      return { ...rec };
    },

    // 机构级联清理（删除机构时用）：返回被删记录的 stored_name 列表，调用方清理磁盘。
    async removeByOrg(orgId) {
      const records = await load();
      if (orgId == null) return [];
      const target = Number(orgId);
      const removed = records.filter((r) => Number(r.org_id) === target);
      if (!removed.length) return [];
      await save(records.filter((r) => Number(r.org_id) !== target));
      return removed.map((r) => ({ id: r.id, stored_name: r.stored_name, original_name: r.original_name }));
    },
  };
}
