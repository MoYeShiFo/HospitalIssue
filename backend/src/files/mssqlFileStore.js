import sql from 'mssql';
import { VISIBILITY, VISIBILITY_LIST } from './visibility.js';
import { DEFAULT_ORG_ID } from '../db/orgScope.js';

// 生产用：SQL Server 文件管理（dbo.app_file，v1.18.70）。
// 可见性 WHERE 与 files/visibility.js 的 canSeeFile 逐条等价（改一处必须同步另一处）：
//   all_orgs → 任何登录用户可见（跨机构）；
//   org / org_company → 仅当前机构（@org）；org_company 还要求公司用户类型（平台管理员豁免）。
//   v1.18.72 起与 problems 等模块口径统一：切换机构后按当前机构过滤，平台管理员也不例外
//   （旧版 @platform = 1 全量放行，导致平台管理员切机构后仍见他机构文件）。
export function createMssqlFileStore(cfg) {
  let pool;
  async function getPool() {
    if (!pool) {
      pool = await new sql.ConnectionPool(cfg).connect();
      await initTable();
    }
    return pool;
  }
  // 启动时自动建表（若不存在）：与 schema.sql 第 10 节保持一致，正常升级无需手工执行 SQL。
  async function initTable() {
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = N'app_file')
      BEGIN
        CREATE TABLE dbo.app_file (
          id            BIGINT IDENTITY(1,1) PRIMARY KEY,
          org_id        BIGINT NOT NULL DEFAULT 1,
          visibility    NVARCHAR(16) NOT NULL DEFAULT N'org',
          original_name NVARCHAR(255) NOT NULL,
          stored_name   NVARCHAR(255) NOT NULL,
          size          BIGINT NOT NULL DEFAULT 0,
          mime          NVARCHAR(100) NOT NULL DEFAULT N'',
          remark        NVARCHAR(500) NOT NULL DEFAULT N'',
          uploaded_by   NVARCHAR(100) NOT NULL,
          uploader_name NVARCHAR(100) NOT NULL DEFAULT N'',
          created_at    DATETIME NOT NULL DEFAULT GETDATE()
        );
        CREATE INDEX ix_app_file_scope ON dbo.app_file (org_id, visibility, created_at);
      END
      -- v1.18.76：在线文档链接（存量库平滑加列）
      IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.app_file') AND name = N'link_url')
        ALTER TABLE dbo.app_file ADD link_url NVARCHAR(1000) NOT NULL DEFAULT N'';
    `);
  }

  // 数据库列名 -> 统一字段名（与 devFileStore 完全一致）。
  const map = (r) => ({
    id: r.id,
    org_id: r.org_id == null ? DEFAULT_ORG_ID : Number(r.org_id),
    visibility: VISIBILITY_LIST.includes(r.visibility) ? r.visibility : VISIBILITY.ORG,
    original_name: r.original_name || '',
    stored_name: r.stored_name || '',
    size: r.size == null ? 0 : Number(r.size),
    mime: r.mime || '',
    remark: r.remark || '',
    uploaded_by: r.uploaded_by || '',
    uploader_name: r.uploader_name || '',
    link_url: r.link_url || '',
    created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
  });

  // 可见性 WHERE：每个 @ 参数在同一请求上只注册一次（mssql-params 静态检查约束）。
  // org 缺省落默认机构（与 bindOrg 系列一致）；utype 由调用方按 req.user 注入；
  // platform 仅用于豁免 org_company 档的用户类型要求（不再作为全量放行开关，v1.18.72）。
  function visWhere(rq, { orgId, platform, userType } = {}) {
    rq.input('org', sql.BigInt, orgId == null ? DEFAULT_ORG_ID : Number(orgId));
    rq.input('platform', sql.Bit, platform ? 1 : 0);
    rq.input('utype', sql.NVarChar(16), userType === 'company' ? 'company' : 'hospital');
    return `WHERE (visibility = N'all_orgs'
        OR (org_id = @org AND (visibility = N'org'
            OR (visibility = N'org_company' AND (@utype = N'company' OR @platform = 1)))))`;
  }

  // 搜索词 WHERE（可选）：与 dev 侧检索字段一致（original_name / remark / uploader_name）。
  function kwWhere(rq, q) {
    if (!q) return '';
    rq.input('kw', sql.NVarChar(255), `%${q}%`);
    return ' AND (original_name LIKE @kw OR remark LIKE @kw OR uploader_name LIKE @kw)';
  }

  return {
    async init() { await getPool(); },

    async listFiles({ q, scope, page = 1, pageSize = 20, orgId, user } = {}) {
      const p = await getPool();
      const scope0 = {
        orgId,
        platform: !!(user && user.platformAdmin),
        userType: user ? user.userType : 'hospital',
      };
      // 分档计数：可见集合 + 搜索词（忽略 scope），一条 GROUP BY 拿全量
      const cReq = p.request();
      const cRes = await cReq.query(
        `SELECT visibility AS k, COUNT(*) AS c FROM dbo.app_file ${visWhere(cReq, scope0)}${kwWhere(cReq, q)} GROUP BY visibility`
      );
      const counts = { all: 0, all_orgs: 0, org: 0, org_company: 0 };
      for (const row of cRes.recordset) {
        if (counts[row.k] != null) counts[row.k] = Number(row.c);
        counts.all += Number(row.c);
      }

      const req = p.request();
      let sqlText = `SELECT * FROM dbo.app_file ${visWhere(req, scope0)}${kwWhere(req, q)}`;
      if (scope) {
        req.input('scope', sql.NVarChar(16), scope);
        sqlText += ' AND visibility = @scope';
      }
      const totalReq = p.request();
      let totalSql = `SELECT COUNT(*) AS c FROM dbo.app_file ${visWhere(totalReq, scope0)}${kwWhere(totalReq, q)}`;
      if (scope) {
        totalReq.input('scope', sql.NVarChar(16), scope);
        totalSql += ' AND visibility = @scope';
      }
      const totalRes = await totalReq.query(totalSql);
      const total = Number(totalRes.recordset[0].c) || 0;

      req.input('offset', sql.Int, (Number(page) - 1) * Number(pageSize));
      req.input('limit', sql.Int, Number(pageSize));
      const res = await req.query(`${sqlText} ORDER BY created_at DESC, id DESC OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);
      return { rows: res.recordset.map(map), total, counts, page: Number(page), pageSize: Number(pageSize) };
    },

    // 按 id 取原始记录（仅限当前机构；跨机构一律视为不存在 —— 多机构红线）。
    async getFileById(id, orgId) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, num);
      let where = 'id = @id';
      if (orgId != null) { req.input('org', sql.BigInt, Number(orgId)); where += ' AND org_id = @org'; }
      const res = await req.query(`SELECT * FROM dbo.app_file WHERE ${where}`);
      return res.recordset.length ? map(res.recordset[0]) : null;
    },

    async createFile(rec) {
      const p = await getPool();
      const req = p.request();
      req.input('org', sql.BigInt, rec.org_id == null ? DEFAULT_ORG_ID : Number(rec.org_id));
      req.input('visibility', sql.NVarChar(16), VISIBILITY_LIST.includes(rec.visibility) ? rec.visibility : VISIBILITY.ORG);
      req.input('original_name', sql.NVarChar(255), rec.original_name || '');
      req.input('stored_name', sql.NVarChar(255), rec.stored_name || '');
      req.input('size', sql.BigInt, Number(rec.size) || 0);
      req.input('mime', sql.NVarChar(100), rec.mime || '');
      req.input('remark', sql.NVarChar(500), rec.remark || '');
      req.input('uploaded_by', sql.NVarChar(100), rec.uploaded_by || '');
      req.input('uploader_name', sql.NVarChar(100), rec.uploader_name || '');
      req.input('link_url', sql.NVarChar(1000), rec.link_url || '');
      const res = await req.query(`
        INSERT INTO dbo.app_file
          (org_id, visibility, original_name, stored_name, size, mime, remark, uploaded_by, uploader_name, link_url)
        OUTPUT INSERTED.*
        VALUES (@org, @visibility, @original_name, @stored_name, @size, @mime, @remark, @uploaded_by, @uploader_name, @link_url)
      `);
      return map(res.recordset[0]);
    },

    async deleteFile(id, orgId) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, num);
      let where = 'id = @id';
      if (orgId != null) { req.input('org', sql.BigInt, Number(orgId)); where += ' AND org_id = @org'; }
      const res = await req.query(`DELETE FROM dbo.app_file OUTPUT DELETED.* WHERE ${where}`);
      return res.recordset.length ? map(res.recordset[0]) : null;
    },

    // 局部更新（v1.18.77 编辑：可见范围/备注；链接行还可改名称与 URL）。仅改传入字段。
    async updateFile(id, orgId, patch = {}) {
      const num = Number(id);
      if (!Number.isFinite(num)) return null;
      const p = await getPool();
      const req = p.request();
      req.input('id', sql.BigInt, num);
      let where = 'id = @id';
      if (orgId != null) { req.input('org', sql.BigInt, Number(orgId)); where += ' AND org_id = @org'; }
      const sets = [];
      if (patch.visibility != null) { req.input('visibility', sql.NVarChar(16), patch.visibility); sets.push('visibility = @visibility'); }
      if (patch.remark != null) { req.input('remark', sql.NVarChar(500), patch.remark); sets.push('remark = @remark'); }
      if (patch.original_name != null) { req.input('original_name', sql.NVarChar(255), patch.original_name); sets.push('original_name = @original_name'); }
      if (patch.link_url != null) { req.input('link_url', sql.NVarChar(1000), patch.link_url); sets.push('link_url = @link_url'); }
      if (!sets.length) return this.getFileById(num, orgId);
      // 注意：UPDATE 的 OUTPUT 子句必须位于 SET 之后（DELETE/INSERT 可前置，UPDATE 前置会报
      // 「Incorrect syntax near 'OUTPUT'」——v1.18.77 首版即踩此坑，v1.18.78 修正）
      const res = await req.query(`UPDATE dbo.app_file SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE ${where}`);
      return res.recordset.length ? map(res.recordset[0]) : null;
    },

    // 机构级联清理（删除机构时用）：返回被删记录的 stored_name 列表，调用方清理磁盘。
    async removeByOrg(orgId) {
      if (orgId == null) return [];
      const p = await getPool();
      const req = p.request();
      req.input('org', sql.BigInt, Number(orgId));
      const res = await req.query('DELETE FROM dbo.app_file OUTPUT DELETED.id, DELETED.stored_name, DELETED.original_name WHERE org_id = @org');
      return res.recordset.map((r) => ({ id: r.id, stored_name: r.stored_name, original_name: r.original_name }));
    },
  };
}
