<script setup>
// 实施协同 · TFS 工作项查询（v1.18.51，自 HIS.OPS AISkill/TfsQuery 移植为 Vue）。
// 筛选：日期类型/区间 + 关键词 + 集合/状态多选；列设置存 localStorage（key=tfs_cols）。
// 修复原版两处缺陷：①查询参数用 camelCase（原 snake_case 导致日期条件不生效）；②去掉无效的类型多选。
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { useHScroll } from '../composables/useHScroll.js';

const toast = ref({ show: false, text: '', kind: 'info' });
let toastTimer = null;
function showToast(text, kind = 'info') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3600);
}

const cfg = ref(null); // { configured, collections, columns, defaultFields, user_id, ... }
const loading = ref(false);
const rows = ref([]);
const errors = ref([]);
const detail = ref(null);

const dateType = ref('ChangedDate');
const startDate = ref('');
const endDate = ref('');
const keyword = ref('');
const fCollections = ref([]);
const fStates = ref([]);
const STATE_OPTIONS = ['新建', '活动', '已解决', '已关闭', '已完成', '已取消', 'Removed'];

// 列设置（localStorage 持久化）
const colDlg = ref(false);
const checkedCols = ref([]);
const visibleCols = computed(() => {
  const all = cfg.value?.columns || [];
  const checked = new Set(checkedCols.value);
  return all.filter((c) => checked.has(c.name));
});

const chips = computed(() => {
  const total = rows.value.length;
  const done = rows.value.filter((r) => ['已关闭', '已完成', 'Resolved', 'Closed'].includes(r.state)).length;
  const est = rows.value.reduce((s, r) => s + (Number(r.originalEstimate) || 0), 0);
  return { total, done, doing: total - done, est: Math.round(est * 10) / 10 };
});

async function loadCfg() {
  try {
    cfg.value = await api.aiTfsConfig();
    const saved = localStorage.getItem('tfs_cols');
    checkedCols.value = saved ? JSON.parse(saved) : (cfg.value.defaultFields?.length ? cfg.value.defaultFields : (cfg.value.columns || []).map((c) => c.name));
    fCollections.value = cfg.value.collections?.slice(0, 1) || [];
  } catch (e) { showToast(e.message || 'TFS 配置加载失败', 'danger'); }
}

function saveCols() {
  localStorage.setItem('tfs_cols', JSON.stringify(checkedCols.value));
  colDlg.value = false;
  showToast('列设置已保存', 'success');
}

async function query() {
  loading.value = true; errors.value = [];
  try {
    const d = await api.aiTfsQuery({
      userId: '', // 空 = 用服务端配置的默认账号
      startDate: startDate.value, endDate: endDate.value,
      dateType: dateType.value,
      collections: fCollections.value,
      states: fStates.value,
      keyword: keyword.value.trim(),
    });
    if (!d.success) { showToast((d.errors || [d.message || '查询失败']).join('；'), 'danger'); rows.value = d.rows || []; return; }
    rows.value = d.rows || [];
    errors.value = d.errors || [];
    showToast(`查到 ${d.total} 个工作项`, 'success');
  } catch (e) { showToast(e.message || '查询失败', 'danger'); }
  finally { loading.value = false; }
}

function resetFilter() {
  startDate.value = ''; endDate.value = ''; keyword.value = '';
  fStates.value = []; fCollections.value = cfg.value?.collections?.slice(0, 1) || [];
}

function openTfs(r) { if (r.url) window.open(r.url, '_blank'); }

async function openDetail(r) {
  try {
    const d = await api.aiTfsItem({ id: r.id, collection: r.collection });
    if (!d.success) { showToast(d.message || '详情获取失败', 'danger'); return; }
    detail.value = d.row;
  } catch (e) { showToast(e.message || '详情获取失败', 'danger'); }
}

function toChangeRequest(r) {
  localStorage.setItem('cr_incoming', JSON.stringify({ source: 'tfs', data: r, ts: Date.now() }));
  window.dispatchEvent(new CustomEvent('ai-goto', { detail: 'changerequest' }));
}

function exportCsv() {
  const cols = visibleCols.value;
  const head = cols.map((c) => c.label).join(',');
  const lines = rows.value.map((r) => cols.map((c) => {
    const v = String(r[c.name] ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return /[",]/.test(v) ? `"${v}"` : v;
  }).join(','));
  const url = URL.createObjectURL(new Blob(['\ufeff', head, ...lines].join('\r\n'), { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `TFS工作项_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// 底部常驻横向滚动条（v1.18.58）
const { twEl, tblEl, hsEl, hsWidth, hsNeed, onTwScroll, onHsScroll } = useHScroll(rows);

onMounted(loadCfg);
</script>

<template>
  <div class="ts">
    <div v-if="toast.show" class="toast" :class="toast.kind">{{ toast.text }}</div>

    <div class="card">
      <div class="card-title">TFS 工作项查询
        <span v-if="cfg && !cfg.configured" class="badge amber">未配置（复制 Configs/tfs.example.json 为 tfs.json 并填入 PAT）</span>
        <span v-else-if="cfg" class="muted small">{{ cfg.user_name }}（{{ cfg.user_id }}）</span>
        <button class="btn ghost" style="margin-left:auto" @click="colDlg = true">⚙ 列设置</button>
        <button class="btn ghost" @click="exportCsv" :disabled="!rows.length">📥 导出 CSV</button>
      </div>
      <div class="filters">
        <label>日期类型
          <select v-model="dateType" class="ipt">
            <option value="ResolvedDate">解决日期</option>
            <option value="ChangedDate">修改日期</option>
            <option value="CreatedDate">创建日期</option>
          </select>
        </label>
        <label>开始 <input v-model="startDate" type="date" class="ipt"></label>
        <label>结束 <input v-model="endDate" type="date" class="ipt"></label>
        <label>关键词 <input v-model="keyword" class="ipt" style="width:200px" placeholder="标题包含…" @keyup.enter="query"></label>        <div class="fld">集合
          <span class="chkset"><label v-for="c in cfg?.collections || []" :key="c" class="chk"><input v-model="fCollections" type="checkbox" :value="c">{{ c }}</label></span>
        </div>
        <div class="fld">状态
          <span class="chkset"><label v-for="s in STATE_OPTIONS" :key="s" class="chk"><input v-model="fStates" type="checkbox" :value="s">{{ s }}</label></span>
        </div>
        <button class="btn primary" :disabled="loading || (cfg && !cfg.configured)" @click="query">{{ loading ? '查询中...' : '🔍 查询' }}</button>
        <button class="btn ghost" @click="resetFilter">重置</button>
      </div>
      <div class="chips">
        <span class="chip">总项 <b>{{ chips.total }}</b></span>
        <span class="chip green">已完成 <b>{{ chips.done }}</b></span>
        <span class="chip blue">进行中 <b>{{ chips.doing }}</b></span>
        <span class="chip amber">预估合计 <b>{{ chips.est }}</b> h</span>
      </div>
      <div v-if="errors.length" class="warn-tip">⚠️ {{ errors.join('；') }}</div>
    </div>

    <div class="card grow">
      <div ref="twEl" class="table-wrap" @scroll="onTwScroll">
        <table ref="tblEl" class="dgrid">
          <thead>
            <tr>
              <th class="op">操作</th>
              <th v-for="c in visibleCols" :key="c.name" :style="{ minWidth: (c.width || 120) + 'px', textAlign: c.align || 'left' }">{{ c.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length"><td :colspan="(visibleCols.length || 1) + 1" class="empty">{{ loading ? '查询中...' : '输入条件后点「查询」' }}</td></tr>
            <tr v-for="r in rows" :key="r.collection + '-' + r.id">
              <td class="op">
                <button class="linkbtn" @click="openDetail(r)">详情</button>
                <button class="linkbtn" @click="toChangeRequest(r)">变更申请单</button>
                <button class="linkbtn" @click="openTfs(r)">打开TFS</button>
              </td>
              <td v-for="c in visibleCols" :key="c.name" :style="{ textAlign: c.align || 'left' }" :class="{ nowrap: c.name === 'id' }">
                <a v-if="c.name === 'id'" class="linkbtn" @click="openTfs(r)">{{ r[c.name] }}</a>
                <span v-else>{{ r[c.name] ?? '' }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 底部常驻横向滚动条（v1.18.58） -->
    <div v-if="hsNeed" ref="hsEl" class="hscroll" @scroll="onHsScroll">
      <div class="hscroll-inner" :style="{ width: hsWidth + 'px' }"></div>
    </div>

    <!-- 列设置 -->
    <div v-if="colDlg" class="modal-mask" @click.self="colDlg = false">
      <div class="modal" style="width:420px">
        <div class="modal-head"><b>列设置</b><button class="btn ghost" @click="colDlg = false">✕</button></div>
        <div class="modal-body">
          <div class="chkset" style="flex-direction:column;align-items:flex-start">
            <label v-for="c in cfg?.columns || []" :key="c.name" class="chk"><input v-model="checkedCols" type="checkbox" :value="c.name"> {{ c.label }}（{{ c.name }}）</label>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn primary" @click="saveCols">保存</button>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal" style="width:760px">
        <div class="modal-head"><b>TFS #{{ detail.id }} {{ detail.title }}</b><button class="btn ghost" @click="detail = null">✕</button></div>
        <div class="modal-body">
          <div class="kv">
            <div class="kv-item"><span class="k">状态</span><span class="v">{{ detail.state }}</span></div>
            <div class="kv-item"><span class="k">类型</span><span class="v">{{ detail.type }}</span></div>
            <div class="kv-item"><span class="k">集合/项目</span><span class="v">{{ detail.collection }} / {{ detail.project }}</span></div>
            <div class="kv-item"><span class="k">负责人</span><span class="v">{{ detail.assignedTo }}</span></div>
            <div class="kv-item"><span class="k">迭代路径</span><span class="v">{{ detail.iterationPath }}</span></div>
            <div class="kv-item"><span class="k">区域路径</span><span class="v">{{ detail.areaPath }}</span></div>
            <div class="kv-item"><span class="k">创建日期</span><span class="v">{{ detail.createdDate }}</span></div>
            <div class="kv-item"><span class="k">修改日期</span><span class="v">{{ detail.changedDate }}</span></div>
            <div class="kv-item"><span class="k">解决日期</span><span class="v">{{ detail.resolvedDate }}</span></div>
            <div class="kv-item"><span class="k">预估/剩余/完成</span><span class="v">{{ detail.originalEstimate }} / {{ detail.remainingWork }} / {{ detail.completedWork }}</span></div>
            <div class="kv-item full"><span class="k">TFS 链接</span><span class="v"><a :href="detail.url" target="_blank">{{ detail.url }}</a></span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ts { display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.card { background: #fff; border: 1px solid #e3e8f0; border-radius: 12px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06); }
.card.grow { flex: 1; display: flex; flex-direction: column; min-height: 0; margin-bottom: 0; }
.card.grow .table-wrap { flex: 1; max-height: none; }
.card-title { display: flex; align-items: center; gap: 8px; font-weight: 650; margin-bottom: 10px; flex-wrap: wrap; }
.ipt { padding: 6px 10px; border: 1px solid #d5dbe3; border-radius: 8px; font-size: 12.5px; background: #fff; color: #1f2937; height: 32px; box-sizing: border-box; }
.ipt:focus { outline: none; border-color: #2f6fed; box-shadow: 0 0 0 3px rgba(47, 111, 237, 0.12); }
.filters { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-end; padding: 6px 0; }
.filters > label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6572; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6572; white-space: nowrap; }
.chkset { display: flex; flex-wrap: wrap; gap: 4px 10px; max-width: 460px; }
.chk { display: inline-flex; flex-direction: row; align-items: center; gap: 4px; font-size: 12px; color: #334155; }
.chk input[type="checkbox"] { width: auto; min-height: 0; padding: 0; margin: 0; accent-color: #2f6fed; cursor: pointer; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.chip { background: #eef1f5; border-radius: 14px; padding: 3px 12px; font-size: 12.5px; color: #334155; }
.chip.green { background: #e6f7ec; color: #1f8a4c; } .chip.blue { background: #e8f0fe; color: #2f6fed; } .chip.amber { background: #fdf3e0; color: #b97a12; }
.table-wrap { overflow: auto; max-height: calc(100vh - 320px); }
.table-wrap::-webkit-scrollbar:horizontal { height: 0; display: none; }
table.dgrid { border-collapse: collapse; width: max-content; font-size: 12.5px; }
table.dgrid th, table.dgrid td { border-bottom: 1px solid #eef1f5; padding: 7px 9px; vertical-align: top; }
table.dgrid thead th { position: sticky; top: 0; background: #f4f6f9; z-index: 2; white-space: nowrap; }
td.op, th.op { position: sticky; left: 0; background: #fff; z-index: 1; white-space: nowrap; }
thead th.op { z-index: 3; background: #f4f6f9; }
.linkbtn { background: none; border: none; color: #2f6fed; cursor: pointer; padding: 0 4px; font-size: 12px; }
.linkbtn:hover { text-decoration: underline; }
.nowrap { white-space: nowrap; }
.warn-tip { background: #fdf3e0; color: #8a5a0b; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; margin-top: 6px; }
.badge.amber { background: #fdf3e0; color: #b97a12; border-radius: 9px; padding: 1px 8px; font-size: 11.5px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: #fff; border-radius: 12px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #eef1f5; }
.modal-body { padding: 14px 16px; overflow: auto; }
.modal-foot { padding: 10px 16px; border-top: 1px solid #eef1f5; display: flex; justify-content: flex-end; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; }
.kv-item { display: flex; gap: 8px; font-size: 12.5px; }
.kv-item.full { grid-column: 1 / -1; }
.kv-item .k { color: #6b7684; min-width: 100px; flex-shrink: 0; }
.toast { position: fixed; top: 18px; right: 18px; z-index: 99; padding: 10px 16px; border-radius: 10px; color: #fff; font-size: 13px; }
.toast.info { background: #334155; } .toast.success { background: #1f8a4c; } .toast.danger { background: #d64541; } .toast.warn { background: #b97a12; }
.empty { color: #8a94a2; padding: 18px; text-align: center; }
.small { font-size: 12px; } .muted { color: #8a94a2; }
</style>
