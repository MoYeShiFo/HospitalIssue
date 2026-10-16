<script setup>
// 实施协同 · WXP底稿查询（v1.18.51，自 HIS.OPS AISkill/WxpDraft 移植为 Vue）。
// 流程：选医院（我的客户列表）→ 拉底稿（单医院 / 全部授权医院）→ 内存筛选排序 → 导出 CSV / 详情弹窗。
// v1.18.58：字典筛选改多选下拉（MultiSelect）；新增 项目周报 / 个人周报（Markdown 下载，可嵌 Chart.js 图）。
// 数据走后端 /api/aiskill/*（个人 WXP 凭据由后端按登录人解析），19 位底稿号全程用字符串防精度丢失。
import { ref, computed, onMounted, nextTick } from 'vue';
import Chart from 'chart.js/auto';
import { api } from '../api.js';
import MultiSelect from './MultiSelect.vue';
import { useHScroll } from '../composables/useHScroll.js';

const toast = ref({ show: false, text: '', kind: 'info' });
let toastTimer = null;
function showToast(text, kind = 'info') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3600);
}

const cfg = ref(null);
const stage = ref('hospital'); // hospital | draft
const hospLoading = ref(false);
const hospKw = ref('');
const hospitals = ref([]);
const curHosp = ref(null); // { hospitalCode, hospitalName } | 'ALL'
const loading = ref(false);
const rows = ref([]);
const errors = ref([]);
const detail = ref(null);
const detailLoading = ref(false);

// —— 筛选（v1.18.58：字典类多选下拉，[] = 全部） ——
const fStatus = ref([]); const fLevel = ref([]); const fType = ref([]);
const fKeyword = ref(''); const fDateFrom = ref(''); const fDateTo = ref('');
const fMine = ref(false); const fMineOpen = ref(false);

const DRAFT_COLS = [
  { key: 'index', label: '底稿号', w: 120 },
  { key: '__hospitalName', label: '医院', w: 130 },
  { key: 'batch', label: '批次', w: 90 },
  { key: 'sourceName', label: '来源', w: 80 },
  { key: 'groupName', label: '责任组', w: 90 },
  { key: 'typeName', label: '类型', w: 70 },
  { key: 'levelName', label: '优先级', w: 70 },
  { key: 'delay', label: '延期(d)', w: 70 },
  { key: 'statusName', label: '状态', w: 80 },
  { key: 'description', label: '问题描述', w: 320 },
  { key: 'department', label: '提出科室', w: 110 },
  { key: 'createdBy', label: '登记人', w: 80 },
  { key: 'createdTime', label: '登记日期', w: 100 },
  { key: 'closeBy', label: '关闭人', w: 80 },
  { key: 'closeTime', label: '关闭时间', w: 100 },
  { key: 'assignTo', label: '指派人', w: 80 },
  { key: 'implementManager', label: '实施负责人', w: 90 },
  { key: 'planFinishDate', label: '计划完成', w: 100 },
  { key: 'tfsDemandNo', label: 'TFS号', w: 90 },
  { key: 'tfsStatusName', label: 'TFS状态', w: 90 },
  { key: 'businessTypeName', label: '业务分类', w: 90 },
];

const statusOptions = computed(() => uniq(rows.value.map((r) => r.statusName).filter(Boolean)));
const levelOptions = computed(() => uniq(rows.value.map((r) => r.levelName).filter(Boolean)));
const typeOptions = computed(() => uniq(rows.value.map((r) => r.typeName).filter(Boolean)));
function uniq(arr) { return [...new Set(arr)]; }

const filtered = computed(() => {
  const kw = fKeyword.value.trim().toLowerCase();
  const df = fDateFrom.value; const dt = fDateTo.value;
  const me = cfg.value?.userCode || '';
  return rows.value.filter((r) => {
    if (fStatus.value.length && !fStatus.value.includes(r.statusName)) return false;
    if (fLevel.value.length && !fLevel.value.includes(r.levelName)) return false;
    if (fType.value.length && !fType.value.includes(r.typeName)) return false;
    if (df || dt) {
      const d = String(r.createdTime || '').slice(0, 10);
      if (df && d < df) return false;
      if (dt && d > dt) return false;
    }
    if (fMine.value) { if (!isMyDraft(r, me)) return false; }
    if (fMineOpen.value) { if (!isMyDraft(r, me)) return false; if (r.statusName === '已关闭') return false; }
    if (kw) {
      const hay = DRAFT_COLS.map((c) => String(r[c.key] ?? '')).join('\n').toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
});

const sortKey = ref(''); const sortDir = ref(0); // 0 原序 1 asc 2 desc
function sortBy(k) {
  if (sortKey.value !== k) { sortKey.value = k; sortDir.value = 1; }
  else if (sortDir.value === 1) sortDir.value = 2;
  else { sortDir.value = 0; sortKey.value = ''; return; }
  const dir = sortDir.value === 1 ? 1 : -1;
  const numeric = ['delay', 'index'].includes(k);
  rows.value.sort((a, b) => {
    const va = a[k] ?? ''; const vb = b[k] ?? '';
    if (numeric) return (Number(va) || 0) - (Number(vb) || 0) === 0 ? 0 : ((Number(va) || 0) > (Number(vb) || 0) ? dir : -dir);
    return String(va).localeCompare(String(vb), 'zh-CN') * dir;
  });
}

// 字典配色（v1.18.59，对齐 WXP 原版观感：柔和底色 + 深色文字，一眼区分类型/状态/优先级）。
// 未命中的值回落到后端 draft-config 下发的 statusColors/levelColors/typeColors，再回落无色。
const DICT_COLORS = {
  status: {
    已关闭: 'green', 已完成: 'green', 关闭: 'green',
    实施处理中: 'teal', 开发处理中: 'blue', 需求确认中: 'blue',
    测试分析中: 'purple', 产品分析中: 'violet',
    已处理待验证: 'amber', 已验证待升级: 'cyan',
    待处理: 'slate', 未处理: 'slate', 待分配: 'slate',
    挂起: 'gray', 已取消: 'gray',
  },
  level: {
    'A级(紧急)': 'red', 'A级（紧急）': 'red', 紧急: 'red', 高: 'red',
    'B级(常)': 'amber', 'B级（常）': 'amber', 中: 'amber',
    一般: 'blue', 低: 'blue', 'C级(低)': 'blue', 'C级（低）': 'blue',
  },
  type: {
    需求: 'blue', Bug: 'red', bug: 'red', 缺陷: 'red',
    支援单: 'green', 支持单: 'cyan', 咨询: 'amber',
    优化: 'purple', 新功能: 'teal', 其他: 'gray',
  },
};
function badgeCls(kind, val) {
  if (!val) return '';
  const c = DICT_COLORS[kind]?.[val];
  if (c) return 'dc-' + c;
  const m = kind === 'status' ? (cfg.value?.statusColors || {}) : kind === 'level' ? (cfg.value?.levelColors || {}) : (cfg.value?.typeColors || {});
  return m[val] || '';
}

async function loadHospitals() {
  hospLoading.value = true;
  try {
    const d = await api.aiHospitals(hospKw.value.trim());
    if (!d.success) { showToast(d.message || '医院列表获取失败', 'danger'); if (d.authFailed) showToast('WXP 登录已过期，请到「工时配置」重新测试连接', 'warn'); return; }
    hospitals.value = d.hospitals || [];
  } catch (e) { showToast(e.message || '医院列表获取失败', 'danger'); }
  finally { hospLoading.value = false; }
}

function resetFilters() {
  fStatus.value = []; fLevel.value = []; fType.value = [];
  fKeyword.value = ''; fDateFrom.value = ''; fDateTo.value = '';
  fMine.value = false; fMineOpen.value = false;
}

async function openHospital(h) {
  curHosp.value = h;
  stage.value = 'draft';
  await loadDrafts();
}

async function loadDrafts() {
  if (!curHosp.value) return;
  loading.value = true; errors.value = []; rows.value = []; resetFilters();
  try {
    const payload = curHosp.value === 'ALL'
      ? { forceAll: true }
      : { hospitalId: curHosp.value.hospitalCode };
    const d = await api.aiDraftList(payload);
    if (!d.success) { showToast(d.message || '底稿获取失败', 'danger'); return; }
    rows.value = d.rows || [];
    // 单医院模式：上游行不带医院名，回填以便「医院」列与 CSV 导出有值
    if (curHosp.value !== 'ALL') rows.value = rows.value.map((r) => ({ ...r, __hospitalName: curHosp.value.hospitalName }));
    errors.value = d.errors || [];
    showToast(`共 ${d.total} 条底稿${errors.value.length ? `（${errors.value.length} 家医院查询失败）` : ''}`, 'success');
  } catch (e) { showToast(e.message || '底稿获取失败', 'danger'); }
  finally { loading.value = false; }
}

async function openDetail(r) {
  detailLoading.value = true;
  detail.value = { __loading: true, __row: r };
  try {
    const d = await api.aiDraftDetail(String(r.id ?? r.sheetId ?? r.index ?? ''));
    if (!d.success) { showToast(d.message || '底稿详情获取失败', 'danger'); detail.value = null; return; }
    detail.value = { ...d.data, __row: r };
  } catch (e) { showToast(e.message || '底稿详情获取失败', 'danger'); detail.value = null; }
  finally { detailLoading.value = false; }
}

function backToHospitals() { stage.value = 'hospital'; rows.value = []; curHosp.value = null; }

// —— 导出（v1.18.61：CSV / Excel / HTML 三种格式，均为前端拼装，导出「筛选后」的数据） ——
function htmlEsc(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function exportMatrix() {
  const srcMap = cfg.value?.sourceMap || {};
  const cols = DRAFT_COLS;
  const head = cols.map((c) => c.label);
  const data = filtered.value.map((r) => cols.map((c) => {
    let v = r[c.key] ?? '';
    if (c.key === 'sourceName' && !v) v = srcMap[String(r.sourceCode ?? r.source)] ?? '';
    return String(v);
  }));
  return { head, data };
}
function exportRows(kind) {
  const name = (curHosp.value === 'ALL' ? '全部医院' : curHosp.value.hospitalName) || '底稿';
  const fn = `${name}_底稿导出_${today()}`;
  const { head, data } = exportMatrix();
  if (kind === 'csv') {
    const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = data.map((row) => row.map(q).join(','));
    downloadBlob(['\ufeff', head.map(q).join(','), ...lines].join('\r\n'), `${fn}.csv`, 'text/csv');
  } else if (kind === 'excel') {
    // Excel 兼容：HTML table + mso 命名空间，Excel/WPS 双击即开
    const tbl = `<table border="1"><tr>${head.map((h) => `<th style="background:#eef1f5">${htmlEsc(h)}</th>`).join('')}</tr>${data.map((row) => `<tr>${row.map((v) => `<td>${htmlEsc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
    const doc = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>底稿</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--><style>td,th{mso-number-format:"\\@";font-size:12px;}</style></head><body>${tbl}</body></html>`;
    downloadBlob(doc, `${fn}.xls`, 'application/vnd.ms-excel');
  } else {
    const doc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${htmlEsc(fn)}</title><style>body{font-family:"Microsoft YaHei",sans-serif;margin:24px;color:#1f2937}h2{font-size:18px}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border:1px solid #d5dbe3;padding:6px 9px;text-align:left}th{background:#f4f6f9;position:sticky;top:0}tr:nth-child(even) td{background:#fafbfd}</style></head><body><h2>${htmlEsc(fn)}（${data.length} 条）</h2><table><tr>${head.map((h) => `<th>${htmlEsc(h)}</th>`).join('')}</tr>${data.map((row) => `<tr>${row.map((v) => `<td>${htmlEsc(v)}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
    downloadBlob(doc, `${fn}.html`, 'text/html');
  }
  showToast(`✅ 已导出 ${data.length} 条（${kind.toUpperCase()}）`, 'success');
}
function downloadBlob(content, filename, mime) {
  const parts = Array.isArray(content) ? content : [content]; // 兼容整段字符串（HTML/Excel 导出）
  const url = URL.createObjectURL(new Blob(parts, { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function today() { return new Date().toISOString().slice(0, 10); }

function openTfs(r) {
  const url = r.tfsPath || (r.tfsDemandNo ? `https://tfs2018-web.winning.com.cn:8080/tfs/_workitems?id=${r.tfsDemandNo}` : '');
  if (url) window.open(url, '_blank');
}

// 跳变更申请单（携带底稿数据）
function toChangeRequest(r) {
  localStorage.setItem('cr_incoming', JSON.stringify({ source: 'wxp', data: r, hospitalName: curHosp.value === 'ALL' ? (r.__hospitalName || '') : curHosp.value?.hospitalName || '', ts: Date.now() }));
  window.dispatchEvent(new CustomEvent('ai-goto', { detail: 'changerequest' }));
}

// 详情字段中文映射（v1.18.66）：每个返回字段配中文名 + 所属分组，按角色排版；
// 未知字段自动归入「其他」，不丢数据。布局：上面中文标签(下方灰色英文字段名)，右边值。
const FIELD_LABELS = {
  id: '底稿ID', index: '序号', title: '标题',
  type: '类型编号', businessTypeId: '业务类型ID', businessTypeName: '业务类型',
  level: '级别', status: '状态码', source: '来源编号', sourceName: '来源',
  batch: '批次', productId: '产品ID', groupId: '分组ID', deleted: '已删除',
  assignTo: '指派人', leaderName: '组长', implementManager: '实施负责人', implementManagerName: '实施负责人姓名',
  developManager: '研发负责人', productManager: '产品负责人', testManager: '测试经理',
  createdBy: '创建人', updatedBy: '更新人', taskDispenseBy: '分派人', confirmBy: '确认人', auditBy: '审核人',
  hospitalId: '医院ID', department: '提出科室', departmentMember: '院方联系人', departmentMemberPhone: '联系电话', demandProposeRole: '需求角色',
  description: '问题描述',
  expectedTime: '期望完成时间', planFinishDate: '计划完成日期', developPromiseDate: '研发承诺日期',
  createdTime: '创建时间', updatedTime: '更新时间', taskDispenseTime: '分派时间', confirmTime: '确认时间', auditTime: '审核时间',
  aiReviewed: 'AI已审核', aiReviewResult: 'AI审核结果', aiReviewTime: 'AI审核时间', aiReviewReason: 'AI审核意见',
};
const DETAIL_GROUPS = [
  { icon: '📋', name: '基本信息', keys: ['index', 'id', 'title', 'type', 'businessTypeId', 'businessTypeName', 'level', 'status', 'source', 'sourceName', 'batch', 'productId', 'groupId', 'deleted'] },
  { icon: '🧑‍💼', name: '责任分工', keys: ['assignTo', 'leaderName', 'implementManager', 'implementManagerName', 'developManager', 'productManager', 'testManager', 'createdBy', 'updatedBy', 'taskDispenseBy', 'confirmBy', 'auditBy'] },
  { icon: '🏥', name: '院方信息', keys: ['hospitalId', 'department', 'departmentMember', 'departmentMemberPhone', 'demandProposeRole'] },
  { icon: '📝', name: '问题描述', keys: ['description'], full: true },
  { icon: '📅', name: '计划与时间', keys: ['expectedTime', 'planFinishDate', 'developPromiseDate', 'createdTime', 'updatedTime', 'taskDispenseTime', 'confirmTime', 'auditTime'] },
  { icon: '🤖', name: 'AI 审核', keys: ['aiReviewed', 'aiReviewResult', 'aiReviewTime', 'aiReviewReason'], full: true },
  { icon: '📦', name: '其他', keys: [] },
];
const detailGroups = computed(() => {
  if (!detail.value || detail.value.__loading) return [];
  const skip = new Set(['__row', '__loading']);
  const fmt = (v) => (typeof v === 'boolean' ? (v ? '是' : '否') : String(v));
  const groups = DETAIL_GROUPS.map((g) => ({ ...g, items: [] }));
  for (const [k, raw] of Object.entries(detail.value)) {
    if (skip.has(k) || raw == null || String(raw).trim() === '') continue;
    const g = groups.find((x) => x.keys.includes(k)) || groups[groups.length - 1];
    const v = fmt(raw);
    g.items.push({ k, label: FIELD_LABELS[k] || k, v, full: String(v).length > 46 });
  }
  return groups.filter((g) => g.items.length);
});

// ================= 周报（v1.18.58，自 HIS.OPS generateProjectReport / generatePersonalReport 移植） =================

// 判断底稿是否与当前用户相关（v1.18.61）：
// 统一只看「实施负责人」——其括号内工号与工时配置绑定的 WXP 工号（cfg.userCode）全等才算「我的」；
// 不用登录系统工号（admin 之类），也不再看登记/解决/关闭等其它角色，避免口径混乱。
function roleCode(v) {
  const m = String(v || '').match(/[（(](\d{2,})[)）]/);
  return m ? m[1] : '';
}
function isMyDraft(x, me) {
  if (!me) return false;
  return roleCode(x.implementManager) === me || roleCode(x.implementManagerName) === me;
}
const myCount = computed(() => {
  const me = cfg.value?.userCode || '';
  return me ? rows.value.filter((r) => isMyDraft(r, me)).length : 0;
});

// 周报状态口径（对齐原版）
const RST = {
  CLOSED: '已关闭',
  VERIFIED_PENDING: '已处理待验证',
  IN_PROGRESS: ['实施处理中', '开发处理中', '产品分析中', '测试分析中', '已挂起'],
  TO_UPGRADE: '已验证待升级',
  CANCELLED: ['已取消', '已驳回'],
};
const SCOPE_NAME = { created: '登记日期', closed: '关闭日期', updated: '更新时间', tfsClosed: 'TFS 关闭日期' };

const rptMenu = ref(false);
const rptDlg = ref(false);
const rptType = ref('personal'); // personal | project
const rptQuick = ref('7'); // 7 | 30 | month | custom
const rptFrom = ref(''); const rptTo = ref('');
const rptScope = ref(['updated']); // 统计口径，默认「更新时间在周期内」（推荐）
const rptCharts = ref(false);

function fmtLocal(d) { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function ymd(s) { return s ? String(s).slice(0, 10) : ''; }
function fmtCN(s) { if (!s) return ''; const p = ymd(s).split('-'); return `${p[0]}年${parseInt(p[1])}月${parseInt(p[2])}日`; }
function hospitalTitle() { return curHosp.value === 'ALL' ? '全部医院' : (curHosp.value?.hospitalName || '未选择'); }

function openReport(type) {
  if (!rows.value.length) { showToast('暂无底稿数据，请先查询底稿', 'warn'); return; }
  if (!cfg.value?.userCode) { showToast('未获取到当前用户工号，无法生成周报', 'warn'); return; }
  rptType.value = type;
  rptMenu.value = false;
  applyQuick('7');
  rptDlg.value = true;
}
function applyQuick(q) {
  rptQuick.value = q;
  const t = new Date(); const to = fmtLocal(t);
  if (q === '7') { const d = new Date(); d.setDate(d.getDate() - 6); rptFrom.value = fmtLocal(d); rptTo.value = to; }
  else if (q === '30') { const d = new Date(); d.setDate(d.getDate() - 29); rptFrom.value = fmtLocal(d); rptTo.value = to; }
  else if (q === 'month') { rptFrom.value = fmtLocal(new Date(t.getFullYear(), t.getMonth(), 1)); rptTo.value = to; }
}

// 数据池：勾选口径的任一日期落在周期内即纳入
function buildPool(allData, scope, from, to) {
  const inR = (t) => t >= from && t <= to;
  return allData.filter((x) => {
    if (scope.includes('created') && inR(ymd(x.createdTime))) return true;
    if (scope.includes('closed') && inR(ymd(x.closeTime))) return true;
    if (scope.includes('updated') && inR(ymd(x.updatedTime ?? x.updateTime))) return true;
    if (scope.includes('tfsClosed') && inR(ymd(x.tfsClosedTime ?? x.tfsCloseTime))) return true;
    return false;
  });
}
function isRisk(x, todayStr) {
  if (RST.CANCELLED.includes(x.statusName || '')) return false;
  if (x.delay && Number(x.delay) > 0) return true;
  if (x.planFinishDate) {
    const d = new Date(ymd(x.planFinishDate) + 'T00:00:00');
    if (d < new Date(todayStr + 'T00:00:00') && x.statusName !== RST.CLOSED) return true;
  }
  return false;
}

// Chart.js → base64 PNG（周报嵌入图片用；关动画立即渲染）
function renderChartToBase64(config, width, height) {
  const wrapper = document.createElement('div');
  wrapper.style.cssText = `position:fixed;left:-9999px;top:0;width:${width}px;height:${height}px;`;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  wrapper.appendChild(canvas);
  document.body.appendChild(wrapper);
  config.options = config.options || {};
  config.options.animation = false;
  config.options.responsive = false;
  config.options.maintainAspectRatio = false;
  const chart = new Chart(canvas, config);
  const b64 = chart.toBase64Image('image/png', 1.0);
  chart.destroy();
  document.body.removeChild(wrapper);
  return b64;
}

function generateReport() {
  if (!rptFrom.value || !rptTo.value) { showToast('请选择报告周期', 'warn'); return; }
  if (!rptScope.value.length) { showToast('请至少勾选一个统计口径', 'warn'); return; }
  const md = rptType.value === 'personal' ? buildPersonalMd() : buildProjectMd();
  const name = hospitalTitle();
  const fn = rptType.value === 'personal'
    ? `${name}_个人周报_${cfg.value.userCode}_${rptFrom.value}_至_${rptTo.value}.md`
    : `${name}_项目周报_${rptFrom.value}_至_${rptTo.value}.md`;
  downloadBlob([md], fn.replace(/[\\/:*?"<>|]/g, '_'), 'text/markdown');
  rptDlg.value = false;
  showToast(`✅ 周报已生成并下载：${fn}`, 'success');
}

function scopeLabel(scope) {
  return scope.map((s) => '**' + (SCOPE_NAME[s] || s) + '**').join('、') + ' 任一在周期内';
}

// ---- 项目周报（面向院方，全院底稿） ----
function buildProjectMd() {
  const allData = rows.value;
  const periodFrom = rptFrom.value; const periodTo = rptTo.value;
  const scope = [...rptScope.value];
  const todayStr = fmtLocal(new Date());
  const periodDays = Math.round((new Date(periodTo + 'T00:00:00') - new Date(periodFrom + 'T00:00:00')) / 86400000) + 1;
  const pool = buildPool(allData, scope, periodFrom, periodTo);

  const periodNew = pool.filter((x) => { const t = ymd(x.createdTime); return t >= periodFrom && t <= periodTo; });
  const periodClosed = pool.filter((x) => x.statusName === RST.CLOSED && ymd(x.closeTime) >= periodFrom && ymd(x.closeTime) <= periodTo)
    .sort((a, b) => ymd(a.closeTime).localeCompare(ymd(b.closeTime)));
  const pendingVerify = pool.filter((x) => x.statusName === RST.VERIFIED_PENDING);
  const inProgress = pool.filter((x) => RST.IN_PROGRESS.includes(x.statusName));
  const toUpgrade = pool.filter((x) => x.statusName === RST.TO_UPGRADE);
  const pendingHospital = pool.filter((x) => isRisk(x, todayStr));

  let md = '';
  md += `# ${hospitalTitle()} — 项目经理周报\n\n`;
  md += '**日期**：' + fmtCN(todayStr) + '  \n';
  md += `**报告周期**：${fmtCN(periodFrom)} — ${fmtCN(periodTo)}（共 ${periodDays} 天）  \n`;
  md += '**制表**：卫宁项目组\n\n';
  md += `> 📌 **统计口径**：仅统计 ${scopeLabel(scope)} 的底稿，数据源为接口全量（${allData.length} 条）\n\n`;
  md += '---\n\n';
  md += '## 📋 整体概况摘要\n\n';
  md += '| 指标 | 数量 | 说明 |\n|---|---:|---|\n';
  md += `| **本期新增** | ${periodNew.length} 项 | 登记日期在报告周期内 |\n`;
  md += `| **本期已完成** | ${periodClosed.length} 项 | 关闭日期在报告周期内 |\n`;
  md += `| 待医院验证 | ${pendingVerify.length} 项 | 我方完成，等待院方验证 |\n`;
  md += `| 进行中 | ${inProgress.length} 项 | 实施/开发/调试中，含挂起 |\n`;
  md += `| 待升级 | ${toUpgrade.length} 项 | 测试完成，待确认升级 |\n\n`;
  md += '---\n\n';

  if (rptCharts.value && pool.length > 0) {
    try {
      md += '## 📊 可视化图表\n\n';
      const chart1 = renderChartToBase64({
        type: 'bar',
        data: { labels: ['本期新增', '本期已完成', '待医院验证', '进行中', '待升级'], datasets: [{ data: [periodNew.length, periodClosed.length, pendingVerify.length, inProgress.length, toUpgrade.length], backgroundColor: ['#4a90d9', '#5ab96a', '#f5a623', '#f5c542', '#9b7cc7'], borderRadius: 4 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: '📊 整体概况', font: { size: 14 } } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } } },
      }, 640, 240);
      md += '### 整体概况\n\n![整体概况条形图](' + chart1 + ')\n\n';
      const stCounts = {};
      pool.forEach((x) => { const k = x.statusName || '未知'; stCounts[k] = (stCounts[k] || 0) + 1; });
      const stLabels = Object.keys(stCounts);
      const chart2 = renderChartToBase64({
        type: 'doughnut',
        data: { labels: stLabels, datasets: [{ data: stLabels.map((k) => stCounts[k]), backgroundColor: ['#4a90d9', '#5ab96a', '#f5a623', '#f5c542', '#9b7cc7', '#e74c3c', '#3498db'].slice(0, stLabels.length), borderWidth: 2 }] },
        options: { plugins: { title: { display: true, text: '🥧 状态分布', font: { size: 14 } }, legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } } },
      }, 640, 280);
      md += '### 状态分布\n\n![状态分布饼图](' + chart2 + ')\n\n';
      const bcCounts = {};
      pool.forEach((x) => { const k = x.businessTypeName || '未分类'; bcCounts[k] = (bcCounts[k] || 0) + 1; });
      const bcSorted = Object.keys(bcCounts).map((k) => ({ name: k, cnt: bcCounts[k] })).sort((a, b) => b.cnt - a.cnt).slice(0, 10);
      const chart3 = renderChartToBase64({
        type: 'bar',
        data: { labels: bcSorted.map((x) => x.name), datasets: [{ data: bcSorted.map((x) => x.cnt), backgroundColor: '#4a90d9', borderRadius: 4 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: '🏷️ 业务分类 TOP10', font: { size: 14 } } }, scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } }, y: { grid: { display: false } } } },
      }, 640, Math.max(240, bcSorted.length * 28 + 60));
      md += '### 业务分类 TOP10\n\n![业务分类TOP](' + chart3 + ')\n\n';
      const lvCounts = { 'A级(紧急)': 0, 'B级(急)': 0, 'C级(一般)': 0, '待定': 0 };
      pool.forEach((x) => { const k = x.levelName || '待定'; if (lvCounts[k] !== undefined) lvCounts[k]++; else lvCounts[k] = 1; });
      const lvLabels = Object.keys(lvCounts).filter((k) => lvCounts[k] > 0);
      const lvColors = { 'A级(紧急)': '#e74c3c', 'B级(急)': '#f5a623', 'C级(一般)': '#5ab96a', '待定': '#95a5a6' };
      const chart4 = renderChartToBase64({
        type: 'pie',
        data: { labels: lvLabels, datasets: [{ data: lvLabels.map((k) => lvCounts[k]), backgroundColor: lvLabels.map((k) => lvColors[k] || '#999'), borderWidth: 2 }] },
        options: { plugins: { title: { display: true, text: '⚡ 优先级分布', font: { size: 14 } }, legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } } } },
      }, 640, 280);
      md += '### 优先级分布\n\n![优先级分布饼图](' + chart4 + ')\n\n';
      const days = []; const d0 = new Date(periodFrom + 'T00:00:00'); const d1 = new Date(periodTo + 'T00:00:00');
      for (let d = new Date(d0); d <= d1; d.setDate(d.getDate() + 1)) days.push(fmtLocal(d));
      const crDaily = {}; const clDaily = {};
      days.forEach((d) => { crDaily[d] = 0; clDaily[d] = 0; });
      pool.forEach((x) => { const ct = ymd(x.createdTime); const clt = ymd(x.closeTime); if (crDaily[ct] !== undefined) crDaily[ct]++; if (clDaily[clt] !== undefined) clDaily[clt]++; });
      const chart5 = renderChartToBase64({
        type: 'line',
        data: { labels: days.map((d) => d.slice(5)), datasets: [
          { label: '登记', data: days.map((d) => crDaily[d]), borderColor: '#4a90d9', backgroundColor: 'rgba(74,144,217,0.15)', fill: true, tension: 0.3, pointRadius: 3 },
          { label: '关闭', data: days.map((d) => clDaily[d]), borderColor: '#5ab96a', backgroundColor: 'rgba(90,185,106,0.15)', fill: true, tension: 0.3, pointRadius: 3 },
        ] },
        options: { plugins: { title: { display: true, text: '📈 登记 / 关闭 趋势', font: { size: 14 } }, legend: { position: 'top', labels: { font: { size: 11 }, boxWidth: 12 } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { stepSize: 1 } } } },
      }, 640, 280);
      md += '### 登记 / 关闭 趋势\n\n![登记关闭趋势](' + chart5 + ')\n\n';
      md += '---\n\n';
    } catch (err) {
      md += `_图表生成失败：${err.message}_\n\n---\n\n`;
    }
  }

  md += '## 一、本期完成\n\n';
  if (!periodClosed.length) md += '_本期无关闭的底稿_\n\n';
  else {
    periodClosed.forEach((x, i) => {
      const title = (x.description || '').replace(/\n/g, ' ').slice(0, 120);
      const dt = ymd(x.closeTime);
      const tag = x.businessTypeName ? ' `' + x.businessTypeName + '`' : '';
      md += `${i + 1}. ${title}${dt ? `（${dt}）` : ''}${tag}\n`;
    });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 二、待医院验证\n\n';
  if (!pendingVerify.length) md += '_暂无需院方验证的底稿_\n\n';
  else {
    pendingVerify.forEach((x) => {
      const title = (x.description || '').replace(/\n/g, ' ').slice(0, 120);
      const dt = ymd(x.closeTime);
      const tag = x.businessTypeName ? ' `' + x.businessTypeName + '`' : '';
      md += `- ${title}${dt ? `（${dt}）` : ''}${tag}\n`;
    });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 三、进行中\n\n';
  if (!inProgress.length) md += '_暂无进行中的底稿_\n\n';
  else {
    const groups = {};
    inProgress.forEach((x) => { const k = x.statusName || '(未分类)'; (groups[k] = groups[k] || []).push(x); });
    Object.keys(groups).sort().forEach((k) => {
      md += `### ${k}（${groups[k].length}）\n\n`;
      groups[k].forEach((x) => { md += '- ' + (x.description || '').replace(/\n/g, ' ').slice(0, 120) + '\n'; });
      md += '\n';
    });
  }
  md += '---\n\n';
  md += '## 四、待升级\n\n';
  if (!toUpgrade.length) md += '_暂无需升级的底稿_\n\n';
  else {
    toUpgrade.forEach((x) => { md += '- ' + (x.description || '').replace(/\n/g, ' ').slice(0, 120) + '\n'; });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 五、需院方协调\n\n';
  if (!pendingHospital.length) md += '_暂无需要院方协调的事项_\n\n';
  else {
    pendingHospital.forEach((x) => {
      const title = (x.description || '').replace(/\n/g, ' ').slice(0, 120);
      const reasons = [];
      if (x.delay && Number(x.delay) > 0) reasons.push(`延期 ${x.delay} 天`);
      if (x.planFinishDate) reasons.push(`计划完成 ${ymd(x.planFinishDate)}`);
      md += `- **底稿 #${x.index || ''}** ${title}${reasons.length ? ' — ' + reasons.join('，') : ''}${x.departmentName ? `（${x.departmentName}）` : ''}\n`;
    });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 📝 总结\n\n';
  md += `- 报告周期（${fmtCN(periodFrom)} ~ ${fmtCN(periodTo)}）内 **新增** ${periodNew.length} 项，**完成** ${periodClosed.length} 项。\n`;
  md += `- 当前存量：进行中 **${inProgress.length}** 项，待院方验证 **${pendingVerify.length}** 项，待升级 **${toUpgrade.length}** 项。\n`;
  if (pendingHospital.length) md += `- 有 **${pendingHospital.length}** 项需院方协调或已超期，请院方协助推进。\n`;
  md += '\n---\n\n';
  md += `_报表由 WXP 底稿查询系统自动生成，生成时间：${new Date().toLocaleString()}_\n`;
  return md;
}

// ---- 个人周报（仅统计与"我"相关的底稿） ----
function buildPersonalMd() {
  const allData = rows.value;
  const me = cfg.value?.userCode || '';
  const periodFrom = rptFrom.value; const periodTo = rptTo.value;
  const scope = [...rptScope.value];
  const todayStr = fmtLocal(new Date());
  const periodDays = Math.round((new Date(periodTo + 'T00:00:00') - new Date(periodFrom + 'T00:00:00')) / 86400000) + 1;

  const myAll = allData.filter((x) => isMyDraft(x, me));
  if (!myAll.length) return `# 个人工作周报\n\n_全量底稿中没有与「${me}」相关的记录_\n`;
  const pool = buildPool(myAll, scope, periodFrom, periodTo);

  const myClosed = pool.filter((x) => x.statusName === RST.CLOSED && ymd(x.closeTime) >= periodFrom && ymd(x.closeTime) <= periodTo)
    .sort((a, b) => ymd(a.closeTime).localeCompare(ymd(b.closeTime)));
  const myNew = pool.filter((x) => ymd(x.createdTime) >= periodFrom && ymd(x.createdTime) <= periodTo && roleCode(x.createdBy) === me);
  const myInProgress = pool.filter((x) => RST.IN_PROGRESS.includes(x.statusName));
  const myPendingVerify = pool.filter((x) => x.statusName === RST.VERIFIED_PENDING);
  const myToUpgrade = pool.filter((x) => x.statusName === RST.TO_UPGRADE);
  const myRisk = pool.filter((x) => isRisk(x, todayStr));

  function myRole(x) {
    const roles = [];
    const has = (v) => roleCode(v) === me;
    if (has(x.createdBy)) roles.push('登记');
    if (has(x.assignTo) || has(x.leaderName)) roles.push('指派');
    if (has(x.implementManager)) roles.push('实施负责');
    if (has(x.solverBy) || has(x.solverActualBy)) roles.push('解决');
    if (has(x.closeBy)) roles.push('关闭');
    return roles.length ? roles.join('/') : '参与';
  }
  function itemLine(x, withDate) {
    const title = (x.title || x.description || '').replace(/\n/g, ' ').slice(0, 120);
    const tag = x.businessTypeName ? ' `' + x.businessTypeName + '`' : '';
    const dt = withDate && ymd(x.closeTime) ? `（${ymd(x.closeTime)}）` : '';
    return `- ${title}${dt}${tag} _[${myRole(x)}]_\n`;
  }

  let md = '';
  md += '# 个人工作周报\n\n';
  md += `**汇报人**：${me}  \n`;
  md += `**项目医院**：${hospitalTitle()}  \n`;
  md += `**报告周期**：${fmtCN(periodFrom)} — ${fmtCN(periodTo)}（共 ${periodDays} 天）  \n`;
  md += `**填表日期**：${fmtCN(todayStr)}\n\n`;
  md += `> 📌 **统计口径**：实施负责人括号内工号 = ${me} 且 ${scopeLabel(scope)} 的底稿，共 **${pool.length}** 项（我相关全量 ${myAll.length} 项 / 全院 ${allData.length} 项）\n\n`;
  md += '---\n\n';
  md += '## 📊 本周工作概况\n\n';
  md += '| 指标 | 数量 |\n|---|---:|\n';
  md += `| 本周我处理（口径内） | ${pool.length} 项 |\n`;
  md += `| 本周我完成/关闭 | ${myClosed.length} 项 |\n`;
  md += `| 本周我新登记 | ${myNew.length} 项 |\n`;
  md += `| 进行中 | ${myInProgress.length} 项 |\n`;
  md += `| 待院方验证 | ${myPendingVerify.length} 项 |\n`;
  md += `| 待升级 | ${myToUpgrade.length} 项 |\n\n`;
  md += '---\n\n';
  md += '## 一、本周完成工作\n\n';
  if (!myClosed.length) md += '_本周暂无由我关闭的底稿_\n\n';
  else {
    myClosed.forEach((x, i) => {
      const title = (x.title || x.description || '').replace(/\n/g, ' ').slice(0, 120);
      const tag = x.businessTypeName ? ' `' + x.businessTypeName + '`' : '';
      md += `${i + 1}. ${title}（${ymd(x.closeTime)}）${tag}\n`;
    });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 二、进行中工作\n\n';
  if (!myInProgress.length) md += '_暂无进行中的底稿_\n\n';
  else {
    const groups = {};
    myInProgress.forEach((x) => { const k = x.statusName || '(未分类)'; (groups[k] = groups[k] || []).push(x); });
    Object.keys(groups).sort().forEach((k) => {
      md += `### ${k}（${groups[k].length}）\n\n`;
      groups[k].forEach((x) => { md += itemLine(x, false); });
      md += '\n';
    });
  }
  md += '---\n\n';
  md += '## 三、本周新登记底稿\n\n';
  if (!myNew.length) md += '_本周我没有新登记底稿_\n\n';
  else {
    myNew.forEach((x) => {
      const title = (x.title || x.description || '').replace(/\n/g, ' ').slice(0, 120);
      const tag = x.businessTypeName ? ' `' + x.businessTypeName + '`' : '';
      md += `- ${title}（${ymd(x.createdTime)}）${tag}\n`;
    });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 四、待验证与待升级\n\n';
  if (!myPendingVerify.length && !myToUpgrade.length) md += '_暂无待验证或待升级的底稿_\n\n';
  else {
    if (myPendingVerify.length) { md += `**待院方验证（${myPendingVerify.length}）**\n\n`; myPendingVerify.forEach((x) => { md += itemLine(x, false); }); md += '\n'; }
    if (myToUpgrade.length) { md += `**待升级（${myToUpgrade.length}）**\n\n`; myToUpgrade.forEach((x) => { md += itemLine(x, false); }); md += '\n'; }
  }
  md += '---\n\n';
  md += '## 五、风险与需协调\n\n';
  if (!myRisk.length) md += '_本周无延期或超期事项_\n\n';
  else {
    myRisk.forEach((x) => {
      const title = (x.title || x.description || '').replace(/\n/g, ' ').slice(0, 120);
      const reasons = [];
      if (x.delay && Number(x.delay) > 0) reasons.push(`延期 ${x.delay} 天`);
      if (x.planFinishDate) reasons.push(`计划完成 ${ymd(x.planFinishDate)}`);
      md += `- **底稿 #${x.index || ''}** ${title}${reasons.length ? ' — ' + reasons.join('，') : ''}${x.departmentName ? `（${x.departmentName}）` : ''}\n`;
    });
    md += '\n';
  }
  md += '---\n\n';
  md += '## 六、下周工作计划\n\n';
  const planItems = myInProgress.map((x) => (x.title || x.description || '').replace(/\n/g, ' ').slice(0, 100));
  myRisk.forEach((x) => {
    const t = (x.title || x.description || '').replace(/\n/g, ' ').slice(0, 100);
    if (!planItems.includes(t)) planItems.push('【跟进超期】' + t);
  });
  if (!planItems.length) md += `- 持续做好 ${hospitalTitle()} 日常运维支持，及时响应院方问题。\n`;
  else {
    planItems.slice(0, 10).forEach((t, i) => { md += `${i + 1}. 推进：${t}\n`; });
    if (planItems.length > 10) md += `_（另有 ${planItems.length - 10} 项进行中）_\n`;
  }
  md += '\n---\n\n';
  md += '## 📝 小结\n\n';
  md += `- 本周期内我共处理相关底稿 **${pool.length}** 项，其中完成关闭 **${myClosed.length}** 项，新登记 **${myNew.length}** 项。\n`;
  md += `- 当前在手：进行中 **${myInProgress.length}** 项，待院方验证 **${myPendingVerify.length}** 项，待升级 **${myToUpgrade.length}** 项。\n`;
  if (myRisk.length) md += `- 需重点关注 **${myRisk.length}** 项延期/超期底稿，下周优先推进。\n`;
  md += '\n---\n\n';
  md += `_报表由 WXP 底稿查询系统自动生成，生成时间：${new Date().toLocaleString()}_\n`;
  return md;
}

const { twEl, tblEl, hsEl, hsWidth, hsNeed, onTwScroll, onHsScroll } = useHScroll(filtered);

// ================= 统计图表（v1.18.61）：实施负责人工作量 / 未关闭状态 / 优先级 / 业务分类 =================
const chartDlg = ref(false);
const expMenu = ref(false);
const personCv = ref(null); const openCv = ref(null); const levelCv = ref(null); const bizCv = ref(null);
let chartObjs = [];
const CHART_PALETTE = ['#2f6fed', '#0ea5a0', '#f59e0b', '#8b5cf6', '#ef4444', '#10b981', '#6366f1', '#ec4899', '#14b8a6', '#f97316', '#64748b', '#84cc16'];

// 概览数字（全量，不受页面筛选影响，口径与周报一致）
const chartStat = computed(() => {
  const all = rows.value;
  const open = all.filter((r) => r.statusName !== RST.CLOSED);
  return {
    total: all.length,
    closed: all.length - open.length,
    open: open.length,
    delay: all.filter((r) => Number(r.delay) > 0).length,
  };
});

// 实施负责人 × 状态汇总表（v1.18.62，全量口径不受筛选影响；v1.18.64 加关闭率/权重占比）：
// 一行一人：总数 / 权重占比 / 已关闭 / 关闭率 / 未关闭（其中 产品分析中 / 开发中 / 测试中 / 其他），末行汇总。
// 关闭率 = 该人已关闭 / 该人总数；权重占比 = 该人总数 / 全部底稿数。
const personTable = computed(() => {
  const mk = () => ({ total: 0, closed: 0, open: 0, product: 0, dev: 0, test: 0, other: 0 });
  const pm = new Map();
  rows.value.forEach((r) => {
    const o = pm.get(personLabel(r)) || mk();
    o.total += 1;
    const s = r.statusName || '';
    if (s === RST.CLOSED) {
      o.closed += 1;
    } else {
      o.open += 1;
      if (s.includes('产品分析')) o.product += 1;
      else if (s.includes('开发')) o.dev += 1;
      else if (s.includes('测试')) o.test += 1;
      else o.other += 1;
    }
    pm.set(personLabel(r), o);
  });
  const grand = rows.value.length;
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '-');
  const list = [...pm.entries()]
    .map(([name, o]) => ({ name, ...o, closeRate: pct(o.closed, o.total), share: pct(o.total, grand) }))
    .sort((a, b) => b.total - a.total);
  const s0 = list.reduce((a, r) => ({
    total: a.total + r.total, closed: a.closed + r.closed, open: a.open + r.open,
    product: a.product + r.product, dev: a.dev + r.dev, test: a.test + r.test, other: a.other + r.other,
  }), mk());
  const sum = { ...s0, closeRate: pct(s0.closed, s0.total), share: '100%' };
  return { list, sum };
});

// 导出实施负责人明细汇总表（v1.18.65）：Excel 兼容 HTML 表（含汇总行），明细多时不用在弹窗里翻
function exportPersonTable() {
  const { list, sum } = personTable.value;
  const head = ['实施负责人', '底稿总数', '权重占比', '已关闭', '关闭率', '未关闭', '产品分析中', '开发中', '测试中', '其他未关闭'];
  const rowOf = (p) => [p.name, p.total, p.share, p.closed, p.closeRate, p.open, p.product, p.dev, p.test, p.other];
  const name = (curHosp.value === 'ALL' ? '全部医院' : curHosp.value.hospitalName) || '底稿';
  const fn = `${name}_实施负责人汇总_${today()}`;
  const tbl = `<table border="1"><tr>${head.map((h) => `<th style="background:#eef1f5">${htmlEsc(h)}</th>`).join('')}</tr>`
    + list.map((p) => `<tr>${rowOf(p).map((v) => `<td>${htmlEsc(String(v))}</td>`).join('')}</tr>`).join('')
    + `<tr>${rowOf({ name: '汇总', ...sum }).map((v) => `<td style="background:#eef4ff;font-weight:bold">${htmlEsc(String(v))}</td>`).join('')}</tr></table>`;
  const doc = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>负责人汇总</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--><style>td,th{mso-number-format:"\\@";font-size:12px;}</style></head><body>${tbl}</body></html>`;
  downloadBlob(doc, `${fn}.xls`, 'application/vnd.ms-excel');
  showToast(`✅ 已导出负责人汇总（${list.length} 人）`, 'success');
}

function personLabel(r) {
  const v = String(r.implementManager || r.implementManagerName || '').trim();
  return v || '未指派';
}
function buildCharts() {
  chartObjs.forEach((c) => c.destroy()); chartObjs = [];
  const all = rows.value;
  if (!all.length) return;

  // 1) 实施负责人工作量（按总数取前 12）
  const pm = new Map();
  all.forEach((r) => {
    const k = personLabel(r);
    const o = pm.get(k) || { total: 0, closed: 0, open: 0 };
    o.total += 1;
    if (r.statusName === RST.CLOSED) o.closed += 1; else o.open += 1;
    pm.set(k, o);
  });
  const pTop = [...pm.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12);
  chartObjs.push(new Chart(personCv.value, {
    type: 'bar',
    data: {
      labels: pTop.map(([k]) => k),
      datasets: [
        { label: '总数', data: pTop.map(([, o]) => o.total), backgroundColor: '#b9d0fa' },
        { label: '已关闭', data: pTop.map(([, o]) => o.closed), backgroundColor: '#10b981' },
        { label: '未关闭', data: pTop.map(([, o]) => o.open), backgroundColor: '#f59e0b' },
      ],
    },
    options: { responsive: true, maintainAspectRatio: false, scales: { x: { ticks: { maxRotation: 40, minRotation: 0, font: { size: 10.5 } } }, y: { beginAtZero: true } } },
  }));

  // 2) 未关闭状态分布（环形）
  const om = new Map();
  all.filter((r) => r.statusName !== RST.CLOSED).forEach((r) => om.set(r.statusName || '(未分类)', (om.get(r.statusName || '(未分类)') || 0) + 1));
  const oEntries = [...om.entries()].sort((a, b) => b[1] - a[1]);
  chartObjs.push(new Chart(openCv.value, {
    type: 'doughnut',
    data: { labels: oEntries.map(([k]) => k), datasets: [{ data: oEntries.map(([, v]) => v), backgroundColor: oEntries.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length]) }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } },
  }));

  // 3) 优先级分布（环形，按已知色板）
  const LM = { 'A级(紧急)': '#ef4444', 'A级（紧急）': '#ef4444', 紧急: '#ef4444', 高: '#ef4444', 'B级(常)': '#f59e0b', 'B级（常）': '#f59e0b', 中: '#f59e0b', 低: '#2f6fed', 'C级(低)': '#2f6fed', 'C级（低）': '#2f6fed' };
  const lm = new Map();
  all.forEach((r) => { const k = r.levelName || '(未填)'; lm.set(k, (lm.get(k) || 0) + 1); });
  const lEntries = [...lm.entries()].sort((a, b) => b[1] - a[1]);
  chartObjs.push(new Chart(levelCv.value, {
    type: 'doughnut',
    data: { labels: lEntries.map(([k]) => k), datasets: [{ data: lEntries.map(([, v]) => v), backgroundColor: lEntries.map(([k], i) => LM[k] || CHART_PALETTE[i % CHART_PALETTE.length]) }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } },
  }));

  // 4) 业务分类 TOP10（横向条形）
  const bm = new Map();
  all.forEach((r) => { const k = r.businessTypeName || '(未填)'; bm.set(k, (bm.get(k) || 0) + 1); });
  const bTop = [...bm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  chartObjs.push(new Chart(bizCv.value, {
    type: 'bar',
    data: { labels: bTop.map(([k]) => k), datasets: [{ label: '底稿数', data: bTop.map(([, v]) => v), backgroundColor: '#6366f1' }] },
    options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true } } },
  }));
}
function openCharts() {
  if (!rows.value.length) { showToast('请先查询底稿数据', 'warn'); return; }
  chartDlg.value = true;
  nextTick(buildCharts);
}
function closeCharts() {
  chartDlg.value = false;
  chartObjs.forEach((c) => c.destroy()); chartObjs = [];
}

onMounted(async () => {
  try { cfg.value = await api.aiDraftConfig(); } catch { cfg.value = { sourceMap: {} }; }
  loadHospitals();
});
</script>

<template>
  <div class="ts">
    <div v-if="toast.show" class="toast" :class="toast.kind">{{ toast.text }}</div>

    <!-- 医院选择 -->
    <div v-if="stage === 'hospital'" class="card">
      <div class="card-title">选择医院
        <input v-model="hospKw" class="ipt" style="width:220px;margin-left:auto" placeholder="医院名称 / 编码关键词" @keyup.enter="loadHospitals">
        <button class="btn ghost" :disabled="hospLoading" @click="loadHospitals">🔍 搜索</button>
        <button class="btn primary" :disabled="hospLoading || !hospitals.length" @click="openHospital('ALL')">📋 全部医院底稿</button>
      </div>
      <div class="empty" v-if="!hospitals.length && !hospLoading">没有可查询的授权医院（需 WXP 账号已配置且有客户授权）</div>
      <div class="hosp-grid">
        <button v-for="h in hospitals" :key="h.hospitalCode" class="hosp-card" @click="openHospital(h)">
          <div class="hosp-top">
            <div class="hosp-head">
              <b class="hosp-name">{{ h.hospitalName }}</b>
              <span v-if="h.pinned" class="hbadge hb-amber">置顶</span>
              <span v-if="h.favorite" class="hbadge hb-red">收藏</span>
              <span v-else class="hbadge hb-blue">客户</span>
            </div>
            <span class="hosp-icon">🏥</span>
          </div>
          <div class="hosp-meta">
            <div>📍 {{ (h.province || '') }}{{ h.city || '' }}</div>
            <div>🔢 编码: {{ h.hospitalCode || '-' }}</div>
            <div v-if="h.projectManagerName || h.salesmanName">👤 {{ h.projectManagerName || h.salesmanName }}</div>
          </div>
        </button>
      </div>
    </div>

    <!-- 底稿列表 -->
    <template v-else>
      <div class="card">
        <div class="card-title">
          <button class="btn ghost" @click="backToHospitals">← 返回</button>
          <b>{{ curHosp === 'ALL' ? '全部医院' : curHosp.hospitalName }} · 底稿</b>
          <span class="muted small">{{ filtered.length }} / {{ rows.length }} 条</span>
          <button class="btn ghost" style="margin-left:auto" :disabled="loading" @click="loadDrafts">⟳ 重新查询</button>
          <div style="position:relative">
            <button class="btn ghost" :disabled="loading || !rows.length" @click="expMenu = !expMenu">📥 导出 ▾</button>
            <div v-if="expMenu" class="rpt-menu" style="min-width:170px">
              <button class="rpt-item" @click="expMenu = false; exportRows('csv')">📄 CSV（通用）</button>
              <button class="rpt-item" @click="expMenu = false; exportRows('excel')">📊 Excel（.xls）</button>
              <button class="rpt-item" @click="expMenu = false; exportRows('html')">🌐 HTML（网页）</button>
            </div>
          </div>
          <button class="btn ghost" :disabled="loading || !rows.length" @click="openCharts">📈 图表</button>
          <div style="position:relative">
            <button class="btn ghost" :disabled="loading || !rows.length" @click="rptMenu = !rptMenu">📊 周报 ▾</button>
            <div v-if="rptMenu" class="rpt-menu">
              <button class="rpt-item" @click="openReport('project')">🏢 项目周报 <span class="muted small">（全院底稿，面向院方）</span></button>
              <button class="rpt-item" @click="openReport('personal')">👤 个人周报 <span class="muted small">（仅与我相关）</span></button>
            </div>
          </div>
        </div>
        <div class="filters">
          <div class="fld">状态
            <MultiSelect v-model="fStatus" :options="statusOptions" />
          </div>
          <div class="fld">优先级
            <MultiSelect v-model="fLevel" :options="levelOptions" />
          </div>
          <div class="fld">类型
            <MultiSelect v-model="fType" :options="typeOptions" />
          </div>
          <div class="fld">登记日期
            <span class="row2"><input v-model="fDateFrom" type="date" class="ipt"><input v-model="fDateTo" type="date" class="ipt"></span>
          </div>
          <div class="fld">关键词
            <input v-model="fKeyword" class="ipt kw" placeholder="底稿号/描述/登记人/科室…">
          </div>
          <label class="chk"><input v-model="fMine" type="checkbox">只看我的</label>
          <label class="chk"><input v-model="fMineOpen" type="checkbox">只看我的且未关闭</label>
          <button class="btn small" @click="resetFilters">重置</button>
        </div>
        <div v-if="errors.length" class="warn-tip">⚠️ 部分医院查询失败：{{ errors.slice(0, 3).join('；') }}{{ errors.length > 3 ? ' 等' : '' }}</div>
      </div>

      <div class="card grow">
        <div ref="twEl" class="table-wrap" @scroll="onTwScroll">
          <table ref="tblEl" class="dgrid">
            <thead>
              <tr>
                <th class="op">操作</th>
                <th v-for="c in DRAFT_COLS" :key="c.key" :style="{ minWidth: c.w + 'px' }" :class="{ sortable: true }" @click="sortBy(c.key)">
                  {{ c.label }}<span v-if="sortKey === c.key" class="muted small">{{ sortDir === 1 ? '▲' : '▼' }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!filtered.length"><td :colspan="DRAFT_COLS.length + 1" class="empty">{{ loading ? '加载中...' : '无数据（调整筛选或重新查询）' }}</td></tr>
              <tr v-for="(r, i) in filtered" :key="(r.id ?? r.sheetId ?? i) + ''" class="row">
                <td class="op">
                  <button class="linkbtn" @click="openDetail(r)">详情</button>
                  <button class="linkbtn" @click="toChangeRequest(r)">变更申请单</button>
                  <button v-if="r.tfsPath || r.tfsDemandNo" class="linkbtn" @click="openTfs(r)">TFS</button>
                </td>
                <td v-for="c in DRAFT_COLS" :key="c.key" :class="{ nowrap: ['index', 'createdTime', 'closeTime', 'planFinishDate'].includes(c.key) }">
                  <span v-if="c.key === 'statusName'" class="badge" :class="badgeCls('status', r.statusName)">{{ r.statusName }}</span>
                  <span v-else-if="c.key === 'levelName'" class="badge" :class="badgeCls('level', r.levelName)">{{ r.levelName }}</span>
                  <span v-else-if="c.key === 'typeName'" class="badge" :class="badgeCls('type', r.typeName)">{{ r.typeName }}</span>
                  <span v-else-if="c.key === 'delay'" :class="{ danger: Number(r.delay) > 0 }">{{ r.delay }}</span>
                  <!-- 问题描述：单行截断，悬停看全文（详情弹窗可看完整字段） -->
                  <span v-else-if="c.key === 'description'" class="cell-clip" :title="r.description">{{ r.description }}</span>
                  <span v-else>{{ r[c.key] ?? '' }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 底部常驻横向滚动条：与表格双向联动，无需滚到表格底部找滚动条（v1.18.58） -->
      <div v-if="hsNeed" ref="hsEl" class="hscroll" @scroll="onHsScroll">
        <div class="hscroll-inner" :style="{ width: hsWidth + 'px' }"></div>
      </div>
    </template>

    <!-- 详情弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal" style="width:860px">
        <div class="modal-head">
          <b>底稿详情 {{ detail.index || detail.__row?.index || '' }}</b>
          <button class="btn ghost" @click="detail = null">✕ 关闭</button>
        </div>
        <div class="modal-body">
          <div v-if="detail.__loading" class="empty">加载中...</div>
          <template v-else>
            <div v-if="detail.title" class="ddetail-title">{{ detail.title }}</div>
            <div v-for="g in detailGroups" :key="g.name" class="dsec">
              <div class="dsec-head">{{ g.icon }} {{ g.name }}</div>
              <div class="dgrid" :class="{ cols1: g.full }">
                <div v-for="it in g.items" :key="it.k" class="ditem" :class="{ full: it.full }">
                  <span class="dl">{{ it.label }}<i>{{ it.k }}</i></span>
                  <span class="dv">{{ it.v }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 周报配置弹窗（项目周报 / 个人周报共用，v1.18.58） -->
    <div v-if="rptDlg" class="modal-mask" @click.self="rptDlg = false">
      <div class="modal" style="width:480px">
        <div class="modal-head">
          <b>{{ rptType === 'personal' ? '👤 个人周报配置' : '🏢 项目周报配置' }}</b>
          <button class="btn ghost" @click="rptDlg = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="fld">📅 报告周期
            <div class="rpt-quick">
              <button type="button" :class="{ on: rptQuick === '7' }" @click="applyQuick('7')">最近 7 天</button>
              <button type="button" :class="{ on: rptQuick === '30' }" @click="applyQuick('30')">最近 30 天</button>
              <button type="button" :class="{ on: rptQuick === 'month' }" @click="applyQuick('month')">本月</button>
              <button type="button" :class="{ on: rptQuick === 'custom' }" @click="rptQuick = 'custom'">自定义</button>
            </div>
            <div class="row2" style="width:100%">
              <span class="qfld">起始日期<input v-model="rptFrom" type="date" class="ipt"></span>
              <span class="qfld">结束日期<input v-model="rptTo" type="date" class="ipt"></span>
            </div>
          </div>
          <div class="fld" style="margin-top:12px">🔍 统计口径
            <label class="chk"><input v-model="rptScope" type="checkbox" value="created">登记日期在周期内 <span class="muted">（createdTime）</span></label>
            <label class="chk"><input v-model="rptScope" type="checkbox" value="closed">关闭日期在周期内 <span class="muted">（closeTime）</span></label>
            <label class="chk"><input v-model="rptScope" type="checkbox" value="updated">更新时间在周期内（推荐） <span class="muted">（updatedTime）</span></label>
            <label class="chk"><input v-model="rptScope" type="checkbox" value="tfsClosed">TFS 关闭日期在周期内 <span class="muted">（tfsClosedTime）</span></label>
            <span class="muted small">可多选，只要勾选的任一日期在周期内即纳入统计。</span>
          </div>
          <label v-if="rptType === 'project'" class="chk" style="margin-top:12px">
            <input v-model="rptCharts" type="checkbox">🖼️ 周报嵌入图表图片
          </label>
          <div class="src-tip">📊 数据源：{{ rptType === 'personal'
            ? `按实施负责人括号内工号 = ${cfg?.userCode || '-'}（工时配置绑定）匹配底稿（${myCount} 条 / 全量 ${rows.length} 条）`
            : `接口返回的全量底稿（${rows.length} 条），不受页面筛选影响` }}</div>
        </div>
        <div class="modal-foot">
          <button class="btn ghost" @click="rptDlg = false">取消</button>
          <button class="btn primary" @click="generateReport">生成周报</button>
        </div>
      </div>
    </div>

    <!-- 统计图表弹窗（v1.18.61）：实施负责人工作量 / 未关闭状态 / 优先级 / 业务分类 -->
    <div v-if="chartDlg" class="modal-mask" @click.self="closeCharts">
      <div class="modal" style="width:980px">
        <div class="modal-head">
          <b>📈 底稿统计 · {{ curHosp === 'ALL' ? '全部医院' : curHosp?.hospitalName }}（全量 {{ rows.length }} 条，不受筛选影响）</b>
          <button class="btn ghost" @click="closeCharts">✕ 关闭</button>
        </div>
        <div class="modal-body">
          <div class="stat-cards">
            <div class="scard"><b>{{ chartStat.total }}</b><span>底稿总数</span></div>
            <div class="scard s-green"><b>{{ chartStat.closed }}</b><span>已关闭</span></div>
            <div class="scard s-amber"><b>{{ chartStat.open }}</b><span>未关闭</span></div>
            <div class="scard s-red"><b>{{ chartStat.delay }}</b><span>延期中</span></div>
          </div>
          <div class="chart-grid">
            <div class="chart-box"><h4>实施负责人工作量（前 12）</h4><div class="chart-cv"><canvas ref="personCv"></canvas></div></div>
            <div class="chart-box"><h4>未关闭状态分布</h4><div class="chart-cv"><canvas ref="openCv"></canvas></div></div>
            <div class="chart-box"><h4>优先级分布</h4><div class="chart-cv"><canvas ref="levelCv"></canvas></div></div>
            <div class="chart-box"><h4>业务分类 TOP10</h4><div class="chart-cv"><canvas ref="bizCv"></canvas></div></div>
          </div>
          <h4 class="ptable-title">📋 实施负责人明细汇总
            <button class="btn ghost small" style="margin-left:auto" :disabled="!personTable.list.length" @click="exportPersonTable">📥 导出</button>
          </h4>
          <div class="ptable-wrap">
            <table class="ptable">
              <thead>
                <tr>
                  <th class="pname">实施负责人</th>
                  <th>底稿总数</th><th>权重占比</th><th>已关闭</th><th>关闭率</th><th>未关闭</th>
                  <th class="sub">├ 产品分析中</th><th class="sub">├ 开发中</th><th class="sub">├ 测试中</th><th class="sub">└ 其他未关闭</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in personTable.list" :key="p.name">
                  <td class="pname" :title="p.name">{{ p.name }}</td>
                  <td><b>{{ p.total }}</b></td>
                  <td class="c-blue">{{ p.share }}</td>
                  <td class="c-green">{{ p.closed }}</td>
                  <td class="c-green">{{ p.closeRate }}</td>
                  <td class="c-amber"><b>{{ p.open }}</b></td>
                  <td>{{ p.product }}</td><td>{{ p.dev }}</td><td>{{ p.test }}</td><td class="c-gray">{{ p.other }}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr>
                  <td class="pname">汇总</td>
                  <td><b>{{ personTable.sum.total }}</b></td>
                  <td class="c-blue"><b>100%</b></td>
                  <td class="c-green"><b>{{ personTable.sum.closed }}</b></td>
                  <td class="c-green"><b>{{ personTable.sum.closeRate }}</b></td>
                  <td class="c-amber"><b>{{ personTable.sum.open }}</b></td>
                  <td><b>{{ personTable.sum.product }}</b></td><td><b>{{ personTable.sum.dev }}</b></td><td><b>{{ personTable.sum.test }}</b></td><td class="c-gray"><b>{{ personTable.sum.other }}</b></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* v1.18.58：.ts 占满 .content 剩余高度并自身不滚——表格内部滚动，
   横向滚动条常驻视口底部，无需上下滚动找进度条 */
.ts { display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 0; overflow: hidden; }
/* 本地 .card 定义：避免依赖全局（全局 .card label 会把筛选区 label 拆成纵向） */
.card { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06); flex-shrink: 0; }
.card.grow { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; margin-bottom: 0; }
.card.grow .table-wrap { flex: 1; max-height: none; }
/* 统计图表弹窗（v1.18.61） */
.stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.scard { background: #f7f9fc; border: 1px solid #e3e8f0; border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
.scard b { font-size: 22px; color: #1f2937; }
.scard span { font-size: 12px; color: #6b7684; }
.scard.s-green b { color: #15803d; } .scard.s-amber b { color: #b45309; } .scard.s-red b { color: #d64541; }
.chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.chart-box { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 12px 14px; }
.chart-box h4 { margin: 0 0 8px; font-size: 13px; color: #334155; }
.chart-cv { position: relative; height: 300px; }
/* 实施负责人明细汇总表（v1.18.62） */
.ptable-title { margin: 16px 0 8px; font-size: 13px; color: #334155; display: flex; align-items: center; gap: 10px; }
/* flex:none：弹窗 body 是 flex 列布局，overflow:auto 的子项自动最小尺寸为 0，
   会被上面的固定高度图表挤压成 2px——必须禁止收缩 */
.ptable-wrap { flex: none; max-height: 40vh; overflow: auto; border: 1px solid #e3e8f0; border-radius: 10px; }
.ptable { border-collapse: collapse; width: 100%; font-size: 12.5px; }
.ptable th, .ptable td { padding: 6px 10px; border-bottom: 1px solid #eef1f5; text-align: center; white-space: nowrap; }
.ptable thead th { position: sticky; top: 0; background: #f4f6f9; z-index: 1; font-weight: 650; color: #334155; }
.ptable .pname { text-align: left; font-weight: 550; max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.ptable tfoot td { position: sticky; bottom: 0; background: #eef4ff; font-weight: 650; border-top: 2px solid #c7d8f8; border-bottom: none; color: #1e40af; }
.ptable .c-green { color: #15803d; } .ptable .c-amber { color: #b45309; } .ptable .c-gray { color: #8a94a2; }
.ptable .c-blue { color: #2f6fed; }
.ptable .sub { color: #6b7684; font-weight: 500; }
.ptable tbody tr:hover td { background: #f8faff; }
/* 周报下拉菜单 */
.rpt-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 30; background: #fff; border: 1px solid #d5dbe3; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14); padding: 6px; min-width: 260px; }
.rpt-item { display: block; width: 100%; text-align: left; background: none; border: none; border-radius: 8px; padding: 8px 10px; font-size: 13px; cursor: pointer; }
.rpt-item:hover { background: #f4f6f9; }
/* 周报配置弹窗 */
.rpt-quick { display: flex; gap: 6px; }
.rpt-quick button { flex: 1; border: 1px solid #d5dbe3; background: #fff; border-radius: 8px; padding: 6px 0; font-size: 12.5px; cursor: pointer; }
.rpt-quick button.on { background: #2f6fed; border-color: #2f6fed; color: #fff; }
.qfld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6572; flex: 1; }
.src-tip { margin-top: 12px; padding-top: 10px; border-top: 1px solid #eef1f5; color: #6b7684; font-size: 12px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 10px 16px; border-top: 1px solid #eef1f5; }
.card-title { display: flex; align-items: center; gap: 8px; font-weight: 650; margin-bottom: 10px; flex-wrap: wrap; }
.hosp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
/* 医院卡片（v1.18.59，对齐 WXP 原版：图标 + 徽章 + 信息行） */
.hosp-card { text-align: left; border: 2px solid #e2e8f0; border-radius: 12px; padding: 14px 16px; background: #fff; cursor: pointer; display: block; transition: border-color .15s, box-shadow .15s; }
.hosp-card:hover { border-color: #6366f1; box-shadow: 0 4px 14px rgba(99, 102, 241, 0.15); transform: translateY(-1px); }
.hosp-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.hosp-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.hosp-name { font-size: 14.5px; color: #1f2937; }
.hosp-icon { font-size: 24px; line-height: 1; filter: hue-rotate(-10deg); }
.hosp-meta { margin-top: 8px; display: flex; flex-direction: column; gap: 3px; font-size: 12.5px; color: #6b7684; }
.hbadge { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; font-weight: 600; line-height: 1.5; white-space: nowrap; }
.hb-blue { background: #e8f0fe; color: #2f6fed; }
.hb-amber { background: #fdf3e0; color: #b97a12; }
.hb-red { background: #fdecec; color: #d64541; }
/* 字典 badge 配色（v1.18.59）：柔和底 + 深字，类型/状态/优先级一眼区分 */
.badge.dc-green { background: #e6f7ec; color: #15803d; border: 1px solid #bfe8cd; }
.badge.dc-teal { background: #e0f5f2; color: #0f766e; border: 1px solid #b8e5df; }
.badge.dc-blue { background: #e8f0fe; color: #2f6fed; border: 1px solid #c5d9fb; }
.badge.dc-purple { background: #f1e9fe; color: #7c3aed; border: 1px solid #ddccfb; }
.badge.dc-violet { background: #fbe9f6; color: #c026d3; border: 1px solid #f4c8ea; }
.badge.dc-amber { background: #fdf3e0; color: #b45309; border: 1px solid #f5dfb8; }
.badge.dc-cyan { background: #e0f5fa; color: #0e7490; border: 1px solid #b8e5ee; }
.badge.dc-red { background: #fdecec; color: #d64541; border: 1px solid #f6c8c6; }
.badge.dc-slate { background: #eef1f5; color: #475569; border: 1px solid #d5dbe3; }
.badge.dc-gray { background: #f3f4f6; color: #9ca3af; border: 1px solid #e0e2e6; }
/* 输入控件（.ipt 全局无定义，这里补齐） */
.ipt { padding: 6px 10px; border: 1px solid #d5dbe3; border-radius: 8px; font-size: 12.5px; background: #fff; color: #1f2937; height: 32px; box-sizing: border-box; }
.ipt:focus { outline: none; border-color: #2f6fed; box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.12); }
.ipt.kw { width: 200px; }
.btn.small { padding: 5px 12px; font-size: 12px; height: 32px; }
/* 紧凑单行筛选条（对齐 WXP 原版：字典类为下拉） */
.filters { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: flex-end; padding: 4px 0 2px; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6572; white-space: nowrap; }
.row2 { display: flex; gap: 6px; }
.chk { display: inline-flex; flex-direction: row; align-items: center; gap: 5px; font-size: 12.5px; color: #334155; padding-bottom: 7px; cursor: pointer; }
.chk input[type="checkbox"] { width: auto; min-height: 0; padding: 0; margin: 0; accent-color: #2f6fed; cursor: pointer; }
.table-wrap { overflow: auto; max-height: calc(100vh - 300px); }
/* 横向滚动由底部固定同步条承担：隐藏容器原生横条，避免出现两条（纵向滚动条保留） */
.table-wrap::-webkit-scrollbar:horizontal { height: 0; display: none; }
table.dgrid { border-collapse: collapse; width: max-content; font-size: 12.5px; }
table.dgrid th, table.dgrid td { border-bottom: 1px solid #eef1f5; padding: 7px 9px; text-align: left; vertical-align: top; }
table.dgrid thead th { position: sticky; top: 0; background: #f4f6f9; z-index: 2; cursor: pointer; white-space: nowrap; }
td.op, th.op { position: sticky; left: 0; background: #fff; z-index: 1; white-space: nowrap; }
thead th.op { z-index: 3; background: #f4f6f9; }
.linkbtn { background: none; border: none; color: #2f6fed; cursor: pointer; padding: 0 4px; font-size: 12px; }
.linkbtn:hover { text-decoration: underline; }
.nowrap { white-space: nowrap; }
/* 问题描述列单行截断（v1.18.60）：完整内容悬停 title / 点「详情」查看 */
.cell-clip { display: block; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: default; }
.danger { color: #d64541; font-weight: 650; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11.5px; white-space: nowrap; }
.badge-green { background: #e6f7ec; color: #1f8a4c; }
.badge-blue { background: #e8f0fe; color: #2f6fed; }
.badge-amber { background: #fdf3e0; color: #b97a12; }
.badge-red { background: #fdecec; color: #d64541; }
.badge-gray { background: #eef1f5; color: #6b7684; }
.warn-tip { background: #fdf3e0; color: #8a5a0b; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; margin-top: 6px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: #fff; border-radius: 12px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #eef1f5; }
.modal-body { padding: 14px 16px; overflow: auto; }
/* 详情弹窗：分组卡片 + 中文标签(上)/英文字段名(下) + 值（v1.18.66） */
.ddetail-title { font-size: 14px; font-weight: 700; color: #1f2d3d; line-height: 1.45; margin-bottom: 12px; }
.dsec { flex: none; border: 1px solid #e3e8f0; border-radius: 10px; margin-bottom: 12px; overflow: hidden; }
.dsec-head { background: #f5f7fa; padding: 7px 12px; font-size: 12.5px; font-weight: 700; color: #334155; border-bottom: 1px solid #e9edf3; }
.dgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; padding: 10px 12px; }
.dgrid.cols1 { grid-template-columns: 1fr; }
.ditem { display: flex; align-items: flex-start; gap: 10px; padding: 5px 0; border-bottom: 1px dashed #f0f3f7; font-size: 12.5px; }
.ditem:last-child { border-bottom: none; }
.ditem.full { grid-column: 1 / -1; }
.ditem .dl { flex: none; width: 108px; color: #6b7684; line-height: 1.3; }
.ditem .dl i { display: block; font-style: normal; font-size: 10.5px; color: #a3adbb; word-break: break-all; margin-top: 1px; }
.ditem .dv { flex: 1; min-width: 0; color: #1f2d3d; word-break: break-word; line-height: 1.5; white-space: pre-wrap; }
.toast { position: fixed; top: 18px; right: 18px; z-index: 99; padding: 10px 16px; border-radius: 10px; color: #fff; font-size: 13px; }
.toast.info { background: #334155; } .toast.success { background: #1f8a4c; } .toast.danger { background: #d64541; } .toast.warn { background: #b97a12; }
.empty { color: #8a94a2; padding: 18px; text-align: center; }
.small { font-size: 12px; } .muted { color: #8a94a2; }
</style>
