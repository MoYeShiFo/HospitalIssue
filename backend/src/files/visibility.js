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

// 单条文件对「当前用户」是否可见：
// - 平台管理员：三档全可见（含公司用户档，不要求本人是公司用户）；
// - all_orgs：任何登录用户可见（跨机构）；
// - org / org_company：仅上传者所属机构（orgId）内可见；org_company 还要求用户类型为公司用户。
// orgId 为 null 时不做机构匹配（保持与 db/orgScope.js 一致的缺省语义）。
export function canSeeFile(file, user, orgId) {
  if (!file || !user) return false;
  if (user.platformAdmin) return true;
  if (file.visibility === VISIBILITY.ALL_ORGS) return true;
  if (orgId != null && Number(file.org_id) !== Number(orgId)) return false;
  if (file.visibility === VISIBILITY.ORG) return true;
  if (file.visibility === VISIBILITY.ORG_COMPANY) return user.userType === 'company';
  return false;
}

// 上传时的档位选择边界：all_orgs 影响面覆盖全部机构，仅平台管理员可选（防跨机构误泄露）。
export function canUploadWith(file, visibility) {
  if (visibility === VISIBILITY.ALL_ORGS) return !!(file && file.platformAdmin);
  return VISIBILITY_LIST.includes(visibility);
}
