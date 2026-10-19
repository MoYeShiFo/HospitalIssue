<script setup>
// 实施协同 · 变更申请单（v1.18.51，自 HIS.OPS AISkill/ChangeRequest 移植为 Vue）。
// 纯前端表单：不落库、不在 TFS 创建工作项（与原版一致）。
// 数据来源三种：WXP 底稿 / PMIS 事件单 / TFS 工作项 —— 查询页通过 localStorage 'cr_incoming' + 'ai-goto' 事件带入。
// 导出：打印 / Word(.doc) / PDF / HTML，全部基于「input/select/textarea → 静态文本」的独立 HTML 克隆（A4）。
import { ref, onMounted, onActivated, nextTick } from 'vue';
import { api } from '../api.js';

const toast = ref({ show: false, text: '', kind: 'info' });
let toastTimer = null;
function showToast(text, kind = 'info') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 3600);
}

const source = ref('manual'); // wxp | pmis | tfs | manual
const form = ref({
  customer: '', title: '', reason: '', urgency: '一般', planDate: '',
  applicant: '', testSituation: '未发现问题', hasCost: '否', hasThird: '否',
  summary: '', risk: '低风险', riskDetail: '', content: '',
  hospitalTester: '', hospitalLeader: '', implementer: '', implementSignName: '',
  testDate: '', implementDate: '', changeDate: new Date().toISOString().slice(0, 10),
});
const refTag = ref({ draft: '', pmis: '', tfs: '' });
const signOk = ref(false);
const signUrl = ref('');

// —— 来源数据填充（对齐原版 crFillFromTfs / crFillFromPmis / 底稿填充） ——
const CUSTOMER_RE = /.{2,12}(人民医院|中医院|妇幼保健院|康复护理院|卫生服务中心|卫生院)/;

function fillFromTfs(row) {
  const s = source.value = 'tfs';
  form.value.customer = (String(row.project || '') + String(row.title || '')).match(CUSTOMER_RE)?.[0] || '';
  form.value.title = '【' + (row.type || '工作项') + '变更】' + (row.title || '');
  form.value.reason = row.title || '';
  const iter = String(row.iterationPath || '');
  const proj = String(row.project || '');
  form.value.summary = iter.startsWith(proj) ? iter.slice(proj.length).replace(/^[\\/]+/, '') : (row.areaPath || '');
  form.value.applicant = String(row.assignedTo || '').replace(/^WINNING\\/, '').replace(/\s*<.*>$/, '');
  form.value.content = buildTemplate();
  refTag.value.tfs = row.id ? `TFS #${row.id}` : '';
}
function fillFromPmis(row) {
  source.value = 'pmis';
  form.value.customer = row['客户名称'] || row['客户'] || '';
  form.value.title = '【事件单变更】' + (row['标题'] || '');
  form.value.reason = row['标题'] || '';
  form.value.urgency = row['紧急度'] || (row['优先级'] === '高' ? '紧急' : '一般');
  form.value.applicant = row['处理工程师'] || '';
  form.value.summary = row['影响度'] ? `影响度：${row['影响度']}` : '';
  form.value.content = buildTemplate((row['描述'] || row['备注'] || ''));
  refTag.value.pmis = row['事件单编号'] ? `事件单 ${row['事件单编号']}` : '';
}
function fillFromWxp(row, hospitalName) {
  source.value = 'wxp';
  form.value.customer = hospitalName || '';
  form.value.title = '【底稿变更】' + (row.description || row.title || '');
  form.value.reason = row.description || row.title || '';
  form.value.applicant = row.createdBy || row.implementManager || '';
  form.value.summary = row.groupName ? `责任组：${row.groupName}` : '';
  form.value.content = buildTemplate();
  refTag.value.draft = row.index ? `底稿 ${row.index}` : '';
}
function buildTemplate(extra = '') {
  return ['【变更步骤】', '1. 变更前确认当前系统运行状态并通知院方相关科室；', '2. 按变更方案执行配置/程序变更；', '3. 变更后验证核心业务流程；', '4. 确认无误后恢复通告。',
    extra ? `\n【事件背景】\n${extra}` : '', '\n【回退方案】', '若变更失败，按变更前备份回退至原版本，并验证系统恢复可用。'].join('\n');
}

function applyIncoming() {
  try {
    const raw = localStorage.getItem('cr_incoming');
    if (!raw) return;
    const inc = JSON.parse(raw);
    if (Date.now() - (inc.ts || 0) > 5 * 60 * 1000) { localStorage.removeItem('cr_incoming'); return; }
    localStorage.removeItem('cr_incoming');
    if (inc.source === 'tfs') fillFromTfs(inc.data);
    else if (inc.source === 'pmis') fillFromPmis(inc.data);
    else if (inc.source === 'wxp') fillFromWxp(inc.data, inc.hospitalName);
    showToast('已从查询页带入数据，请核对补充', 'success');
  } catch { /* 忽略坏数据 */ }
}

// —— 签名图 ——
async function loadSign() {
  signOk.value = false; signUrl.value = '';
  const name = form.value.implementSignName.trim();
  if (!name) return;
  const url = api.aiSignatureUrl(name + '.png');
  await nextTick();
  const img = new Image();
  img.onload = () => { signOk.value = true; signUrl.value = url; };
  img.onerror = () => { signOk.value = false; showToast(`未找到签名图：${name}.png（放到后端 Configs/signatures/）`, 'warn'); };
  img.src = url;
}

function clearForm() {
  Object.keys(form.value).forEach((k) => {
    form.value[k] = k === 'urgency' ? '一般' : k === 'testSituation' ? '未发现问题' : k === 'hasCost' || k === 'hasThird' ? '否'
      : k === 'risk' ? '低风险' : k === 'changeDate' ? new Date().toISOString().slice(0, 10) : '';
  });
  refTag.value = { draft: '', pmis: '', tfs: '' };
  signOk.value = false; signUrl.value = '';
  showToast('已清空', 'info');
}

// —— 独立 HTML 克隆（打印 / Word / PDF / HTML 四合一） ——
function buildStandaloneHtml() {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  const f = form.value;
  const row = (label, val) => `<tr><th>${esc(label)}</th><td>${esc(val)}</td></tr>`;
  const row2 = (l1, v1, l2, v2) => `<tr><th>${esc(l1)}</th><td>${esc(v1)}</td><th>${esc(l2)}</th><td>${esc(v2)}</td></tr>`;
  const signImg = signOk.value ? `<img src="${signUrl.value}" style="height:46px;vertical-align:middle">` : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>变更申请单</title>
<style>@page{size:A4;margin:15mm}body{font-family:'Microsoft YaHei',SimSun,sans-serif;font-size:13px;color:#1f2d3d}
h1{text-align:center;font-size:20px;margin:6px 0 2px}.sub{text-align:center;color:#6b7684;font-size:12px;margin-bottom:10px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #9aa7b5;padding:7px 9px;text-align:left;vertical-align:top}
th{background:#f0f3f7;width:110px;white-space:nowrap}textarea-like{white-space:pre-wrap}
.meta{display:flex;justify-content:space-between;font-size:11px;color:#6b7684;margin-top:10px}</style></head><body>
<h1>信息系统变更申请单</h1>
<div class="sub">客户：${esc(f.customer || '＿＿＿＿＿＿＿＿')}</div>
<table>
${row2('变更主题', f.title, '紧急度', f.urgency)}
${row2('客户名称', f.customer, '计划变更日期', f.planDate)}
${row2('申请人', f.applicant, '测试情况', f.testSituation)}
${row2('是否产生费用', f.hasCost, '是否涉及第三方', f.hasThird)}
${row('变更原因', f.reason)}
${row('变更摘要', f.summary)}
${row2('风险等级', f.risk, '风险说明', f.riskDetail)}
${row('变更内容', f.content)}
${row2('院方测试人', f.hospitalTester, '院方负责人', f.hospitalLeader)}
${row2('实施负责人', f.implementer + ' ' + signImg, '实施日期', f.implementDate)}
${row2('测试日期', f.testDate, '变更日期', f.changeDate)}
</table>
<div class="meta"><span>来源：${esc(refTag.value.draft || refTag.value.pmis || refTag.value.tfs || '手工填写')}</span><span>生成时间：${new Date().toLocaleString('zh-CN')}</span></div>
</body></html>`;
}
function printForm() {
  const w = window.open('', '_blank');
  w.document.write(buildStandaloneHtml());
  w.document.close();
  w.focus(); w.print();
}
function exportDoc() {
  const name = `${form.value.customer || '客户'}_变更申请单_${form.value.changeDate || todayStr()}${refTag.value.draft ? '_' + refTag.value.draft.replace(/\s/g, '') : ''}`;
  download(buildStandaloneHtml(), `${name}.doc`, 'application/msword');
}
function exportPdf() { printForm(); }
function exportHtml() {
  const name = `${form.value.customer || '客户'}_变更申请单_${form.value.changeDate || todayStr()}`;
  download(buildStandaloneHtml(), `${name}.html`, 'text/html');
}
function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob(['\ufeff', content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

onMounted(() => {
  applyIncoming();
  // v1.18.51：查询页「变更申请单」按钮触发 ai-goto 事件时，本页已常驻（v-show），监听并重新带入
  window.addEventListener('ai-goto', () => setTimeout(applyIncoming, 50));
});
onActivated(applyIncoming); // 兼容未来 KeepAlive 场景
</script>

<template>
  <div class="ts">
    <div v-if="toast.show" class="toast" :class="toast.kind">{{ toast.text }}</div>

    <div class="card">
      <div class="card-title">变更申请单
        <span class="muted small">数据来源：
          <select v-model="source" class="ipt" style="width:150px">
            <option value="manual">手工填写</option>
            <option value="wxp">WXP 底稿（回查询页带数据）</option>
            <option value="pmis">PMIS 事件单（回查询页带数据）</option>
            <option value="tfs">TFS 工作项（回查询页带数据）</option>
          </select>
        </span>
        <button class="btn ghost" style="margin-left:auto" @click="clearForm">🧹 清空</button>
        <button class="btn ghost" @click="printForm">🖨 打印</button>
        <button class="btn primary" @click="exportDoc">📄 导出 Word</button>
        <button class="btn ghost" @click="exportPdf">导出 PDF</button>
        <button class="btn ghost" @click="exportHtml">导出 HTML</button>
      </div>
      <div class="muted small" style="margin-bottom:8px">
        提示：在「WXP底稿查询 / PMIS交易查询 / TFS 工作项查询」列表点「变更申请单」会自动带出数据填到本表单。本表单仅生成文档，不在 TFS 创建工作项。
      </div>

      <div class="grid2">
        <label class="fld"><span class="lbl">客户名称 <i class="req">*</i></span><input v-model="form.customer" class="ipt" placeholder="如：海盐县人民医院"></label>
        <label class="fld"><span class="lbl">紧急度</span>
          <select v-model="form.urgency" class="ipt"><option>一般</option><option>紧急</option><option>特急</option></select>
        </label>
        <label class="fld full"><span class="lbl">变更主题 <i class="req">*</i></span><input v-model="form.title" class="ipt"></label>
        <label class="fld full"><span class="lbl">变更原因</span><textarea v-model="form.reason" class="ipt" rows="2"></textarea></label>
        <label class="fld"><span class="lbl">计划变更日期</span><input v-model="form.planDate" type="date" class="ipt"></label>
        <label class="fld"><span class="lbl">申请人</span><input v-model="form.applicant" class="ipt"></label>
        <label class="fld"><span class="lbl">测试情况</span><input v-model="form.testSituation" class="ipt"></label>
        <label class="fld"><span class="lbl">是否产生费用</span>
          <select v-model="form.hasCost" class="ipt"><option>否</option><option>是</option></select>
        </label>
        <label class="fld"><span class="lbl">是否涉及第三方</span>
          <select v-model="form.hasThird" class="ipt"><option>否</option><option>是</option></select>
        </label>
        <label class="fld full"><span class="lbl">变更摘要</span><input v-model="form.summary" class="ipt"></label>
        <label class="fld"><span class="lbl">风险等级</span>
          <select v-model="form.risk" class="ipt"><option>低风险</option><option>中风险</option><option>高风险</option></select>
        </label>
        <label class="fld"><span class="lbl">风险说明</span><input v-model="form.riskDetail" class="ipt"></label>
        <label class="fld full"><span class="lbl">变更内容</span><textarea v-model="form.content" class="ipt" rows="9"></textarea></label>
        <label class="fld"><span class="lbl">院方测试人</span><input v-model="form.hospitalTester" class="ipt"></label>
        <label class="fld"><span class="lbl">院方负责人</span><input v-model="form.hospitalLeader" class="ipt"></label>
        <label class="fld"><span class="lbl">实施负责人</span><input v-model="form.implementer" class="ipt"></label>
        <label class="fld"><span class="lbl">实施负责人签名图（人名，取 Configs/signatures/人名.png）</span>
          <span class="row2"><input v-model="form.implementSignName" class="ipt" placeholder="如：徐陈烨">
            <button class="btn ghost" @click="loadSign">加载签名</button></span>
        </label>
        <label class="fld"><span v-if="signOk" class="signwrap"><img :src="signUrl" alt="签名"></span></label>
        <label class="fld"><span class="lbl">测试日期</span><input v-model="form.testDate" type="date" class="ipt"></label>
        <label class="fld"><span class="lbl">实施日期</span><input v-model="form.implementDate" type="date" class="ipt"></label>
        <label class="fld"><span class="lbl">变更日期</span><input v-model="form.changeDate" type="date" class="ipt"></label>
      </div>
      <div v-if="refTag.draft || refTag.pmis || refTag.tfs" class="muted small" style="margin-top:6px">
        关联来源：{{ refTag.draft || refTag.pmis || refTag.tfs }}
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
.req { color: #d64541; font-style: normal; }
.row2 { display: flex; gap: 6px; align-items: center; }
.signwrap img { height: 46px; vertical-align: middle; }
.toast { position: fixed; top: 18px; right: 18px; z-index: 99; padding: 10px 16px; border-radius: 10px; color: #fff; font-size: 13px; }
.toast.info { background: #334155; } .toast.success { background: #1f8a4c; } .toast.danger { background: #d64541; } .toast.warn { background: #b97a12; }
.muted { color: #8a94a2; } .small { font-size: 12px; }
</style>
