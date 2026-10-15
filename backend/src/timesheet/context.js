// 生效凭据/上下文解析（v1.18.51 自 routes/timesheet.js 抽出共用）：
// 工时登记与 AI 技能各查询模块（底稿/TFS/PMIS 交易/上线确认单）都用同一套
// 「个人配置优先，未配置回落系统默认」的凭据规则。

import { getWxpSettings } from './configs.js';
import { getUserTsConfig } from './userConfig.js';

/** 生效凭据：个人配置（工号+密码齐备）优先，否则回落系统默认账号 */
export function resolveCred(own) {
  const g = getWxpSettings();
  if (own?.wxpUserCode && own?.wxpPassword) {
    return { userCode: own.wxpUserCode, password: own.wxpPassword, source: 'own' };
  }
  if (g.userCode && g.password) {
    return { userCode: g.userCode, password: g.password, source: 'global' };
  }
  return { userCode: '', password: '', source: 'none' };
}

/** 个人 PMIS-MCP token：配置了 = 整条链路走本人 token（覆盖全局 mcp.json）；未配置 = null */
export function normAuthOverride(own) {
  const t = String(own?.pmisToken || '').trim();
  return t || null;
}

/** 每次请求的上下文：个人配置（可能为 null）+ 生效凭据 + 个人 token 覆盖 */
export async function userContext(req) {
  const own = await getUserTsConfig({ userId: req.user.id, username: req.user.username });
  return { own, cred: resolveCred(own), auth: normAuthOverride(own) };
}
