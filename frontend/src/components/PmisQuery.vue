<script setup>
// 实施协同 · PMIS交易查询（v1.18.51，自 HIS.OPS AISkill/PmisQuery 移植为 Vue）。
// 交易定义（筛选参数/输出字段）来自后端 Configs/pmis-transactions.json 白名单；
// 数据走 PMIS-MCP callPmisApi（api_id + 参数双重白名单，防越权）。列设置存 localStorage（key=pq.cols.<api_id>）。
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../api.js';
import { useHScroll } from '../composables/useHScroll.js';

const toast = ref({ show: false, text: '', kind: 'info' });
let toastTimer = null;
function showToast(text, kind = 'info') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3600);
}

const transactions = ref([]);
const curId = ref('');
const curTx = computed(() => transactions.value.find((t) => t.api_id === curId.value) || null);
const loading = ref(false);
const rows = ref([]);
const detail = ref(null);

// 动态筛选值：{ [paramName]: string }
const pv = ref({});
const colDlg = ref(false);
const checkedCols = ref([]);

const visibleCols = computed(() => {
  const all = curTx.value?.fields || [];
  const checked = new Set(checkedCols.value);
  return all.filter((f) => checked.has(f.name));
});

const chips = computed(() => {
  const total = rows.value.length;
  const stKey = (curTx.value?.fields || []).find((f) => f.name === '事件状态')?.name;
  const counts = {};
  if (stKey) for (const r of rows.value) { const s = r[stKey]; if (s) counts[s] = (counts[s] || 0) + 1; }
  return { total, counts };
});

function todayStr() { return new Date().toISOString().slice(0, 10); }
function monthStart() { return todayStr().slice(0, 8) + '01'; }

function initParams(tx) {
  const v = {};
  for (const p of tx.params || []) {
    if (p.default === 'today') v[p.name] = todayStr();
    else if (p.default === 'month_start') v[p.name] = monthStart();
    else if (p.default != null && p.default !== '') v[p.name] = String(p.default);
    else v[p.name] = '';
  }
  pv.value = v;
}

function loadCols(tx) {
  const saved = localStorage.getItem('pq.cols.' + tx.api_id);
  checkedCols.value = saved ? JSON.parse(saved) : (tx.defaultFields?.length ? tx.defaultFields.slice() : (tx.fields || []).slice(0, 12).map((f) => f.name));
}
function saveCols() {
  localStorage.setItem('pq.cols.' + curId.value, JSON.stringify(checkedCols.value));
  colDlg.value = false;
  showToast('列设置已保存', 'success');
}

watch(curId, (id) => {
  rows.value = [];
  const tx = transactions.value.find((t) => t.api_id === id);
  if (tx) { initParams(tx); loadCols(tx); }
});

async function loadTx() {
  try {
    const d = await api.aiPmisTransactions();
    transactions.value = d.transactions || [];
    if (transactions.value.length) curId.value = transactions.value[0].api_id;
  } catch (e) { showToast(e.message || '交易定义加载失败', 'danger'); }
}

async function query() {
  const tx = curTx.value; if (!tx) return;
  loading.value = true;
  try {
    const d = await api.aiPmisTransactionQuery(tx.api_id, pv.value);
    if (!d.success) { showToast(d.message || '查询失败', 'danger'); return; }
    rows.value = d.rows || [];
    showToast(`查到 ${d.total} 条记录`, 'success');
  } catch (e) { showToast(e.message || '查询失败', 'danger'); }
  finally { loading.value = false; }
}

function resetQ() { if (curTx.value) initParams(curTx.value); }

/** 多选参数：以 ; 拼接（对齐原版 multiselect 约定） */
function toggleMulti(name, value, checked) {
  const cur = String(pv.value[name] || '').split(';').filter(Boolean);
  const idx = cur.indexOf(value);
  if (checked && idx === -1) cur.push(value);
  if (!checked && idx > -1) cur.splice(idx, 1);
  pv.value[name] = cur.join(';');
}

function badgeCls(key, val) {
  if (!val) return '';
  if (key.includes('状态')) return { 已关闭: 'bg-green', 已解决: 'bg-green', 处理中: 'bg-blue', 待处理: 'bg-amber', 挂起: 'bg-gray' }[val] || 'bg-blue';
  if (key.includes('优先级') || key.includes('紧急度')) return { 高: 'bg-red', 紧急: 'bg-red', 特急: 'bg-red', 中: 'bg-amber', 一般: 'bg-blue' }[val] || 'bg-gray';
  if (key.includes('超期')) return Number(val) > 0 ? 'bg-red' : '';
  if (key.includes('影响度')) return { 高: 'bg-red', 中: 'bg-amber', 低: 'bg-blue' }[val] || '';
  return '';
}

function toChangeRequest(r) {
  localStorage.setItem('cr_incoming', JSON.stringify({ source: 'pmis', data: r, ts: Date.now() }));
  window.dispatchEvent(new CustomEvent('ai-goto', { detail: 'changerequest' }));
}
function openTfs(r) {
  const tfs = String(r['TFS编号'] ?? r['TFS号'] ?? '').trim();
  const m = tfs.match(/\d+/);
  if (m) window.open(`https://tfs2018-web.winning.com.cn:8080/tfs/_workitems?id=${m[0]}`, '_blank');
}

function exportCsv() {
  const cols = visibleCols.value;
  if (!cols.length) return;
  const head = cols.map((c) => c.name).join(',');
  const lines = rows.value.map((r) => cols.map((c) => {
    const v = String(r[c.name] ?? '').replace(/\r?\n/g, ' ').replace(/"/g, '""');
    return /[",]/.test(v) ? `"${v}"` : v;
  }).join(','));
  const url = URL.createObjectURL(new Blob(['\ufeff', head, ...lines].join('\r\n'), { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `${curTx.value.name}_${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// 底部常驻横向滚动条（v1.18.58）
const { twEl, tblEl, hsEl, hsWidth, hsNeed, onTwScroll, onHsScroll } = useHScroll(rows);

onMounted(loadTx);
</script>

<template>
  <div class="ts">
    <div v-if="toast.show" class="toast" :class="toast.kind">{{ toast.text }}</div>

    <div class="card">
      <div class="card-title">PMIS交易查询
        <span v-if="curTx" class="muted small">{{ curTx.description }}</span>
        <button v-if="curTx" class="btn ghost" style="margin-left:auto" @click="colDlg = true">⚙ 列设置</button>
        <button class="btn ghost" :disabled="!rows.length" @click="exportCsv">📥 导出 CSV</button>
      </div>
      <div class="tabs">
        <button v-for="t in transactions" :key="t.api_id" class="tab" :class="{ active: t.api_id === curId }" @click="curId = t.api_id">
          {{ t.icon }} {{ t.name }}
        </button>
      </div>
      <div v-if="curTx" class="filters">
        <template v-for="p in curTx.params" :key="p.name">
          <div class="fld">
            {{ p.label || p.name }}
            <select v-if="p.type === 'select'" v-model="pv[p.name]" class="ipt">
              <option value="">（全部）</option>
              <option v-for="o in p.options || []" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <span v-else-if="p.type === 'multiselect'" class="chkset">
              <label v-for="o in p.options || []" :key="o.value" class="chk">
                <input type="checkbox" :checked="(pv[p.name] || '').split(';').includes(o.value)"
                  @change="toggleMulti(p.name, o.value, $event.target.checked)">{{ o.label }}
              </label>
            </span>
            <input v-else-if="p.dataType === 'date'" v-model="pv[p.name]" type="date" class="ipt">
            <input v-else-if="p.dataType === 'int'" v-model="pv[p.name]" type="number" class="ipt" style="width:110px">
            <input v-else v-model="pv[p.name]" type="text" class="ipt" @keyup.enter="query">
          </div>
        </template>
        <button class="btn primary" :disabled="loading" @click="query">{{ loading ? '查询中...' : '🔍 查询' }}</button>
        <button class="btn ghost" @click="resetQ">重置</button>
      </div>
      <div class="chips">
        <span class="chip">合计 <b>{{ chips.total }}</b></span>
        <span v-for="(n, s) in chips.counts" :key="s" class="chip">{{ s }} <b>{{ n }}</b></span>
      </div>
    </div>

    <div class="card grow">
      <div ref="twEl" class="table-wrap" @scroll="onTwScroll">
        <table ref="tblEl" class="dgrid">
          <thead>
            <tr>
              <th class="op">操作</th>
              <th v-for="f in visibleCols" :key="f.name" :style="{ minWidth: (f.width || 130) + 'px' }">{{ f.name }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length"><td :colspan="(visibleCols.length || 1) + 1" class="empty">{{ loading ? '查询中...' : '设置筛选条件后点「查询」' }}</td></tr>
            <tr v-for="(r, i) in rows" :key="i">
              <td class="op">
                <button class="linkbtn" @click="detail = r">详情</button>
                <button class="linkbtn" @click="toChangeRequest(r)">变更申请单</button>
                <button v-if="String(r['TFS编号'] ?? r['TFS号'] ?? '').match(/\d+/)" class="linkbtn" @click="openTfs(r)">TFS</button>
              </td>
              <td v-for="f in visibleCols" :key="f.name">
                <span :class="badgeCls(f.name, r[f.name])">{{ r[f.name] ?? '' }}</span>
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
      <div class="modal" style="width:460px">
        <div class="modal-head"><b>列设置 — {{ curTx?.name }}</b><button class="btn ghost" @click="colDlg = false">✕</button></div>
        <div class="modal-body">
          <div class="chkset" style="flex-direction:column;align-items:flex-start;max-height:50vh;overflow:auto">
            <label v-for="f in curTx?.fields || []" :key="f.name" class="chk"><input v-model="checkedCols" type="checkbox" :value="f.name"> {{ f.name }}</label>
          </div>
        </div>
        <div class="modal-foot"><button class="btn primary" @click="saveCols">保存</button></div>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal" style="width:880px">
        <div class="modal-head"><b>事件单详情</b><button class="btn ghost" @click="detail = null">✕ 关闭</button></div>
        <div class="modal-body">
          <div class="kv">
            <template v-for="f in curTx?.fields || []" :key="f.name">
              <div v-if="detail[f.name] != null && String(detail[f.name]).trim()" class="kv-item" :class="{ full: (curTx.longTextFields || []).includes(f.name) }">
                <span class="k">{{ f.name }}</span><span class="v">{{ detail[f.name] }}</span>
              </div>
            </template>
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
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.tab { border: 1px solid #d5dbe3; background: #fff; border-radius: 8px; padding: 5px 14px; cursor: pointer; font-size: 13px; }
.tab.active { background: #2f6fed; color: #fff; border-color: #2f6fed; }
.filters { display: flex; flex-wrap: wrap; gap: 10px 14px; align-items: flex-end; padding: 6px 0; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #5a6572; white-space: nowrap; }
.chkset { display: flex; flex-wrap: wrap; gap: 4px 10px; max-width: 460px; }
.chk { display: inline-flex; flex-direction: row; align-items: center; gap: 4px; font-size: 12px; color: #334155; }
.chk input[type="checkbox"] { width: auto; min-height: 0; padding: 0; margin: 0; accent-color: #2f6fed; cursor: pointer; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.chip { background: #eef1f5; border-radius: 14px; padding: 3px 12px; font-size: 12.5px; color: #334155; }
.table-wrap { overflow: auto; max-height: calc(100vh - 340px); }
.table-wrap::-webkit-scrollbar:horizontal { height: 0; display: none; }
table.dgrid { border-collapse: collapse; width: max-content; font-size: 12.5px; }
table.dgrid th, table.dgrid td { border-bottom: 1px solid #eef1f5; padding: 7px 9px; vertical-align: top; }
table.dgrid thead th { position: sticky; top: 0; background: #f4f6f9; z-index: 2; white-space: nowrap; }
td.op, th.op { position: sticky; left: 0; background: #fff; z-index: 1; white-space: nowrap; }
thead th.op { z-index: 3; background: #f4f6f9; }
.linkbtn { background: none; border: none; color: #2f6fed; cursor: pointer; padding: 0 4px; font-size: 12px; }
.linkbtn:hover { text-decoration: underline; }
.bg-green { background: #e6f7ec; color: #1f8a4c; border-radius: 9px; padding: 1px 8px; }
.bg-blue { background: #e8f0fe; color: #2f6fed; border-radius: 9px; padding: 1px 8px; }
.bg-amber { background: #fdf3e0; color: #b97a12; border-radius: 9px; padding: 1px 8px; }
.bg-red { background: #fdecec; color: #d64541; border-radius: 9px; padding: 1px 8px; }
.bg-gray { background: #eef1f5; color: #6b7684; border-radius: 9px; padding: 1px 8px; }
.warn-tip { background: #fdf3e0; color: #8a5a0b; border-radius: 8px; padding: 6px 10px; font-size: 12.5px; margin-top: 6px; }
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.modal { background: #fff; border-radius: 12px; max-height: 85vh; display: flex; flex-direction: column; }
.modal-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #eef1f5; }
.modal-body { padding: 14px 16px; overflow: auto; }
.modal-foot { padding: 10px 16px; border-top: 1px solid #eef1f5; display: flex; justify-content: flex-end; }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 18px; }
.kv-item { display: flex; gap: 8px; font-size: 12.5px; }
.kv-item.full { grid-column: 1 / -1; flex-direction: column; }
.kv-item .k { color: #6b7684; min-width: 100px; flex-shrink: 0; }
.toast { position: fixed; top: 18px; right: 18px; z-index: 99; padding: 10px 16px; border-radius: 10px; color: #fff; font-size: 13px; }
.toast.info { background: #334155; } .toast.success { background: #1f8a4c; } .toast.danger { background: #d64541; } .toast.warn { background: #b97a12; }
.empty { color: #8a94a2; padding: 18px; text-align: center; }
.small { font-size: 12px; } .muted { color: #8a94a2; }
</style>
