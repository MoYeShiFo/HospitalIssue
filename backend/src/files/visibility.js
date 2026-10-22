// 文件管理（v1.18.70）：三档可见范围的共享判定规则。
// dev 存储（JS 过滤）与 mssql 存储（SQL WHERE）必须与这里逐条等价——
// 新增测试套 files-api.test.mjs 对 dev 驱动全量断言；mssql 侧 SQL 为手工镜像，改动需同步两处。

// 三档可见范围（与前端 FileManage.vue 的 SCOPE_TABS 常量一致）
export const VISIBILITY = {
  ALL_ORGS: 'all_orgs',   // 全机构共享：所有机构的登录用户均可查看、下载
  ORG: 'org',             // 本机构：上传者所属机构的全部用户
  ORG_COMPANY: 'org_company', // 公司用户：仅上传者所属机构中 user_type=company 的用户
};

export const VISIBILITY_LIST = [VISIBILITY.ALL_ORGS, VISIBILITY.ORG, VISIBILITY.ORG_COMPANY];

export const VISIBILITY_LABELS = {
  all_orgs: '全机构共享',
  org: '本机构',
  org_company: '公司用户',
};

// 单条文件对「当前用户」是否可见（v1.18.72 修正：与 problems 等模块口径统一——
// 切换机构后一律按「当前机构」过滤，平台管理员也不例外；唯一跨机构可见的通道是
// 显式选择「全机构共享」档。旧版曾对 platformAdmin 直接放行，导致平台管理员切到
// 其他机构仍看到他机构上传的 org/org_company 文件，且列表可见但按 id 预览/下载
// 会 404（by-id 路由本就按 orgId 作用域），自相矛盾）：
// - all_orgs：任何登录用户可见（跨机构，该档的设计用途）；
// - org / org_company：仅当前机构（orgId）内可见；org_company 还要求公司用户类型
//   （平台管理员豁免类型要求——其管理当前机构，档内数据应完整可见）。
// orgId 为 null 时不做机构匹配（保持与 db/orgScope.js 一致的缺省语义）。
export function canSeeFile(file, user, orgId) {
  if (!file || !user) return false;
  if (file.visibility === VISIBILITY.ALL_ORGS) return true;
  if (orgId != null && Number(file.org_id) !== Number(orgId)) return false;
  if (file.visibility === VISIBILITY.ORG) return true;
  if (file.visibility === VISIBILITY.ORG_COMPANY) return user.userType === 'company' || user.platformAdmin === true;
  return false;
}

// 上传时的档位选择边界：all_orgs 影响面覆盖全部机构，仅平台管理员可选（防跨机构误泄露）。
export function canUploadWith(file, visibility) {
  if (visibility === VISIBILITY.ALL_ORGS) return !!(file && file.platformAdmin);
  return VISIBILITY_LIST.includes(visibility);
}
