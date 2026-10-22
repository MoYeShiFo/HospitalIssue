// 问题登记角色可见范围（v1.18.80）：
//   平台管理员 / 院方管理员（role=admin）→ 不限制（服务端不传 viewer 即可）；
//   公司用户（userType=company）→ 处理人或登记人是自己（按显示名），或 createdBy 是自己（按账号）；
//   登记员（院方 reporter）→ 自己登记的（createdBy 按账号，或登记人姓名匹配——兼容代登记/导入场景）。
// dev（JS）与 mssql（SQL WHERE）必须逐条等价（红线）；比较口径统一为 trim 后相等。
export function buildViewer({ userType, role, username, name } = {}) {
  if (role === 'admin') return null; // 平台管理员恒 admin；院方机构管理员 role 亦为 admin
  const acct = String(username || '').trim();
  const disp = String(name || '').trim();
  if (!acct && !disp) return { mode: 'none' };
  return userType === 'company'
    ? { mode: 'company', name: disp, acct }
    : { mode: 'reporter', name: disp, acct };
}

// 单条记录是否对 viewer 可见（viewer=null 表示不限；mode=none 无法识别身份时 fail-closed 不可见）
export function viewerMatches(rec, viewer) {
  if (!viewer) return true;
  if (viewer.mode === 'none') return false;
  const handler = String(rec.handler || '').trim();
  const registrar = String(rec.registrar || '').trim();
  const createdBy = String(rec.createdBy || '').trim();
  if (viewer.mode === 'company') {
    return (viewer.name && (handler === viewer.name || registrar === viewer.name)) || (viewer.acct && createdBy === viewer.acct);
  }
  return (viewer.name && registrar === viewer.name) || (viewer.acct && createdBy === viewer.acct);
}
