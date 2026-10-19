<script setup>
// 实施协同 · 应用上线确认单（v1.18.51，自 HIS.OPS AISkill/GoLiveConfirm 移植为 Vue）。
// 默认值/医院→在建项目映射来自 Configs/go-live.json；项目详情实时调 PMIS 交易 65（经后端 MCP）。
// 表单纯前端：确认结论 + 模块勾选 + 签名区留白横线（院方手签），导出打印均为 A4 独立 HTML。
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../api.js';

const toast = ref({ show: false, text: '', kind: 'info' });
let toastTimer = null;
function showToast(text, kind = 'info') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3600);
}

const cfg = ref(null);
const hospitalId = ref('');
const loading = ref(false);
const form = ref({
  projectName: '', developer: '', engineer: '', goLiveDate: new Date().toISOString().slice(0, 10),
  approve: '同意上线', conclusion: '', modules: [],
});

const curHosp = computed(() => (cfg.value?.hospitals || []).find((h) => h.hospitalId === hospitalId.value) || null);
const title = computed(() => `${curHosp.value?.hospitalName || '＿＿＿＿＿＿'}信息系统建设项目`);

async function loadCfg() {
  try {
    cfg.value = await api.aiGoliveConfig();
    form.value.developer = cfg.value.defaultDeveloper || '';
    form.value.conclusion = cfg.value.defaultConclusion || '';
    form.value.engineer = cfg.value.defaultEngineer || '';
    if (cfg.value.hospitals.length) hospitalId.value = cfg.value.hospitals[0].hospitalId;
  } catch (e) { showToast(e.message || '上线确认配置加载失败', 'danger'); }
}

// 切医院：先用 go-live.json 里记录的名称兜底，用户可再点「加载PMIS项目」取实时详情
watch(hospitalId, () => {
  form.value.projectName = curHosp.value?.inProjectName || '';
});

async function loadProject() {
  const pid = curHosp.value?.inProjectId;
  if (!pid) { showToast('该院未配置在建项目 ID（Configs/go-live.json）', 'warn'); return; }
  loading.value = true;
  try {
    const d = await api.aiGoliveProject(pid);
    if (!d.success) { showToast(d.message || 'PMIS 项目加载失败', 'danger'); return; }
    form.value.projectName = d.projectName || curHosp.value.inProjectName;
    if (d.managerName) form.value.engineer = d.managerName;
    showToast(`已加载 PMIS 项目：${d.projectName}（${d.executeStatus || '状态未知'}）`, 'success');
  } catch (e) { showToast(e.message || 'PMIS 项目加载失败', 'danger'); }
  finally { loading.value = false; }
}

function toggleModule(m, checked) {
  const s = new Set(form.value.modules);
  if (checked) s.add(m); else s.delete(m);
  form.value.modules = [...s];
}
function checkAllModules() { form.value.modules = [...(cfg.value?.modules || [])]; }
function clearModules() { form.value.modules = []; }

// —— A4 独立 HTML（打印 / Word / PDF / HTML 四合一） ——
function buildStandaloneHtml() {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const f = form.value;
  const mods = (cfg.value?.modules || []).map((m) => `${f.modules.includes(m) ? '☑' : '☐'}${esc(m)}`).join('　');
  const line = '<span style="display:inline-block;width:150px;border-bottom:1px solid #333">&nbsp;</span>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>应用上线确认单</title>
<style>@page{size:A4;margin:15mm}body{font-family:'Microsoft YaHei',SimSun,sans-serif;font-size:13.5px;color:#1f2d3d}
h1{text-align:center;font-size:20px;margin:8px 0 4px}h2{text-align:center;font-size:15px;margin:0 0 14px;color:#475569}
table{width:100%;border-collapse:collapse;margin-bottom:14px}th,td{border:1px solid #9aa7b5;padding:8px 10px;text-align:left;vertical-align:top}
th{background:#f0f3f7;width:130px;white-space:nowrap}
.apps{display:flex;gap:24px;margin:10px 0}.sign-row{display:flex;gap:30px;margin:26px 0 8px}
.sign-row>div{flex:1;text-align:center}.date-row{display:flex;gap:30px}.date-row>div{flex:1;text-align:center}
.meta{text-align:right;font-size:11px;color:#6b7684;margin-top:12px}</style></head><body>
<h1>应用上线确认单</h1><h2>${esc(title.value)}</h2>
<table>
<tr><th>项目名称</th><td>${esc(f.projectName)}</td></tr>
<tr><th>开发商</th><td>${esc(f.developer)}</td></tr>
<tr><th>实施负责人</th><td>${esc(f.engineer)}</td></tr>
<tr><th>上线时间</th><td>${esc(f.goLiveDate)}</td></tr>
<tr><th>项目模块</th><td>${mods || '（未勾选）'}</td></tr>
<tr><th>院方应用反馈</th><td>${f.approve === '同意上线' ? '☑同意上线　☐不同意上线' : '☐同意上线　☑不同意上线'}</td></tr>
<tr><th>上线结论</th><td style="min-height:60px">${esc(f.conclusion)}</td></tr>
</table>
<div class="sign-row"><div>使用科室（签字）</div><div>实施负责人（签字）</div><div>科室成员（签字）</div></div>
<div class="date-row"><div>${line}</div><div>${line}</div><div>${line}</div></div>
<div class="meta">生成时间：${new Date().toLocaleString('zh-CN')}</div>
</body></html>`;
}
function printForm() {
  const w = window.open('', '_blank');
  w.document.write(buildStandaloneHtml());
  w.document.close(); w.focus(); w.print();
}
function exportDoc() { download(buildStandaloneHtml(), `${curHosp.value?.hospitalName || '医院'}_应用上线确认单_${todayStr()}.doc`, 'application/msword'); }
function exportPdf() { printForm(); }
function exportHtml() { download(buildStandaloneHtml(), `${curHosp.value?.hospitalName || '医院'}_应用上线确认单_${todayStr()}.html`, 'text/html'); }
function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

onMounted(loadCfg);
</script>

<template>
  <div class="ts">
    <div v-if="toast.show" class="toast" :class="toast.kind">{{ toast.text }}</div>

    <div class="card">
      <div class="card-title">应用上线确认单
        <select v-model="hospitalId" class="ipt" style="width:220px">
          <option v-for="h in cfg?.hospitals || []" :key="h.hospitalId" :value="h.hospitalId">
            {{ h.hospitalName }}（项目 {{ h.inProjectId }}）
          </option>
        </select>
        <button class="btn primary" :disabled="loading || !hospitalId" @click="loadProject">{{ loading ? '加载中...' : '🔄 加载PMIS项目' }}</button>
        <button class="btn ghost" style="margin-left:auto" @click="printForm">🖨 打印</button>
        <button class="btn primary" @click="exportDoc">📄 导出 Word</button>
        <button class="btn ghost" @click="exportPdf">导出 PDF</button>
        <button class="btn ghost" @click="exportHtml">导出 HTML</button>
      </div>

      <div class="grid2">
        <label class="fld full"><span class="lbl">项目名称</span><input v-model="form.projectName" class="ipt" placeholder="选医院后点「加载PMIS项目」，或手工填写"></label>
        <label class="fld"><span class="lbl">开发商</span><input v-model="form.developer" class="ipt"></label>
        <label class="fld"><span class="lbl">实施负责人</span><input v-model="form.engineer" class="ipt"></label>
        <label class="fld"><span class="lbl">上线时间</span><input v-model="form.goLiveDate" type="date" class="ipt"></label>
        <label class="fld"><span class="lbl">院方应用反馈</span>
          <select v-model="form.approve" class="ipt"><option>同意上线</option><option>不同意上线</option></select>
        </label>
      </div>

      <div class="mods">
        <span class="lbl">项目模块
          <button class="linkbtn" @click="checkAllModules">全选</button>
          <button class="linkbtn" @click="clearModules">清空</button>
        </span>
        <div class="chkset">
          <label v-for="m in cfg?.modules || []" :key="m" class="chk">
            <input type="checkbox" :checked="form.modules.includes(m)" @change="toggleModule(m, $event.target.checked)">{{ m }}
          </label>
        </div>
      </div>

      <label class="fld" style="margin-top:8px"><span class="lbl">上线结论</span>
        <textarea v-model="form.conclusion" class="ipt" rows="4"></textarea>
      </label>
      <div class="muted small" style="margin-top:6px">
        签名区在导出/打印的文档里为空白横线（使用科室 / 实施负责人 / 科室成员），由院方现场手签。医院与项目映射维护在 <code>backend/Configs/go-live.json</code>。
      </div>
    </div>
  </div>
</template>

<style scoped>
.ts { display: flex; flex-direction: column; gap: 12px; }
.card-title { display: flex; align-items: center; gap: 8px; font-weight: 650; margin-bottom: 10px; flex-wrap: wrap; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.fld.full { grid-column: 1 / -1; }
.lbl { color: #5a6572; font-size: 12px; }
.mods { margin-top: 10px; }
.chkset { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-top: 6px; }
.chk { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; }
.linkbtn { background: none; border: none; color: #2f6fed; cursor: pointer; padding: 0 4px; font-size: 12px; }
.toast { position: fixed; top: 18px; right: 18px; z-index: 99; padding: 10px 16px; border-radius: 10px; color: #fff; font-size: 13px; }
.toast.info { background: #334155; } .toast.success { background: #1f8a4c; } .toast.danger { background: #d64541; } .toast.warn { background: #b97a12; }
.muted { color: #8a94a2; } .small { font-size: 12px; }
</style>
