// 文件管理分类（v1.18.79）：预定义分类表，服务端强校验，前端下拉同源渲染。
// 扩充分类只需在本表追加（新值可过滤、可写入；历史数据不受影响）。
export const FILE_CATEGORIES = [
  '项目过程管理',
  '运维',
  '制度规范',
  '培训资料',
  '会议纪要',
  '其他',
];

// 合法性：'' 视为未分类（历史数据与未选择时的缺省）
export function isValidCategory(v) {
  return v == null || v === '' || FILE_CATEGORIES.includes(v);
}

export function normalizeCategory(v) {
  const s = String(v || '').trim();
  return FILE_CATEGORIES.includes(s) ? s : '';
}
