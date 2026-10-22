<script setup>
// 问题批量导入（v1.18.80）：前端 SheetJS 解析 Excel（与导出列同名的中文表头）→
// 映射为字段对象 → POST /api/problems/import 逐行校验入库；行级失败不中断，结果逐条反馈。
// xlsx 动态懒加载（独立 chunk，离线可用）；生产构建下 .default 可能为 undefined，需 interop 兜底。
import { ref } from 'vue';
import { api } from '../api.js';

const emit = defineEmits(['close', 'imported']);

// 中文表头 → 字段（与 services/export.js 的 EXPORT_COLUMNS 表头一致）
const HEADER_MAP = {
  '问题标题': 'title',
  '所属科室': 'department',
  '提出人': 'reporter',
  '联系方式': 'contact',
  '问题类型': 'type',
  '严重程度': 'severity',
  '状态': 'status',
  '问题描述': 'description',
  '处理人': 'handler',
  '登记人': 'registrar',
  '软件系统': 'softwareSystem',
  '处理说明': 'resolution',
};
const REQUIRED_LABELS = '必填列：问题标题、所属科室、提出人、问题类型、严重程度、问题描述';

const file = ref(null);
const parsing = ref(false);
const submitting = ref(false);
const parsedRows = ref([]);
const parseError = ref('');
const result = ref(null); // { total, created, failed, results }

function onPick(e) {
  parseError.value = '';
  result.value = null;
  parsedRows.value = [];
  const f = e.target.files && e.target.files[0];
  file.value = f || null;
}

async function ensureXLSX() {
  const ns = await import('xlsx');
  return (ns.default && ns.default.read) ? ns.default : ns;
}

// 解析所选 Excel：首行表头，按 HEADER_MAP 映射；空行丢弃
async function parse() {
  if (!file.value) return;
  parsing.value = true;
  parseError.value = '';
  try {
    const XLSX = await ensureXLSX();
    const buf = await file.value.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (!grid.length) throw new Error('表格为空');
    const headers = grid[0].map((h) => String(h || '').trim());
    const unknown = headers.filter((h) => h && !HEADER_MAP[h] && h !== 'ID');
    const rows = [];
    for (let i = 1; i < grid.length; i++) {
      const cells = grid[i];
      if (!cells || !cells.some((c) => String(c ?? '').trim() !== '')) continue;
      const obj = {};
      headers.forEach((h, idx) => {
        const key = HEADER_MAP[h];
        if (key) obj[key] = String(cells[idx] ?? '').trim();
      });
      rows.push(obj);
    }
    if (!rows.length) throw new Error('没有解析到数据行');
    if (unknown.length) {
      parseError.value = `以下列不会被导入（不在模板内）：${unknown.join('、')}。${REQUIRED_LABELS}`;
    }
    parsedRows.value = rows;
  } catch (e) {
    parseError.value = e.message || '解析失败，请检查文件格式（.xlsx）';
    parsedRows.value = [];
  } finally {
    parsing.value = false;
  }
}

async function submit() {
  if (!parsedRows.value.length) return;
  submitting.value = true;
  result.value = null;
  try {
    result.value = await api.importProblems(parsedRows.value);
    if (result.value.created > 0) emit('imported');
  } catch (e) {
    parseError.value = e.message || '导入失败';
  } finally {
    submitting.value = false;
  }
}

// 下载导入模板：表头与导出列一致 + 一行示例
async function downloadTemplate() {
  const XLSX = await ensureXLSX();
  const header = ['问题标题', '所属科室', '提出人', '联系方式', '问题类型', '严重程度', '状态', '问题描述', '处理人', '登记人', '软件系统', '处理说明'];
  const sample = [' nurses 站无法登录', '内科', '张三', '13800000000', '故障', '高', '', '工号登录提示密码错误', '李四', '', 'HIS', '已重置密码'];
  const ws = XLSX.utils.aoa_to_sheet([header, sample]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '问题导入');
  XLSX.writeFile(wb, '问题导入模板.xlsx');
}
</script>

<template>
  <teleport to="body">
    <div class="modal-mask" @click.self="emit('close')">
      <div class="modal pi-modal" role="dialog" aria-modal="true" aria-label="批量导入问题">
        <div class="pi-head">
          <h3>批量导入问题</h3>
          <button class="icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
        </div>

        <ol class="pi-steps">
          <li>先<a href="javascript:void(0)" @click="downloadTemplate">下载导入模板</a>（表头与导出列一致）</li>
          <li>按模板填写问题（单次上限 500 行）</li>
          <li>选择文件 → 解析预览 → 确认导入</li>
        </ol>
        <p class="pi-req">{{ REQUIRED_LABELS }}；问题类型限：故障、需求、咨询、其他；严重程度限：低、中、高、紧急；状态限：待处理、处理中、已解决、已关闭。登记人留空时默认为导入人。</p>

        <label class="pi-field">
          <span>选择 Excel 文件（.xlsx）</span>
          <input type="file" accept=".xlsx" @change="onPick" />
        </label>

        <div v-if="parsedRows.length" class="pi-preview">
          已解析 <b>{{ parsedRows.length }}</b> 行数据，确认后开始导入。
        </div>

        <p v-if="parseError" class="pi-error">{{ parseError }}</p>

        <div v-if="result" class="pi-result" :class="{ ok: result.failed === 0 }">
          <p class="pi-result-sum">导入完成：成功 <b>{{ result.created }}</b> 条，失败 <b>{{ result.failed }}</b> 条（共 {{ result.total }} 行）。</p>
          <ul v-if="result.failed" class="pi-fails">
            <li v-for="f in result.results.filter(r => !r.ok)" :key="f.row">
              第 {{ f.row }} 行{{ f.title ? `（${f.title}）` : '' }}：{{ f.error }}
            </li>
          </ul>
        </div>

        <div class="pi-foot">
          <button class="small" @click="emit('close')">关闭</button>
          <button class="small" :disabled="!file || parsing" @click="parse">{{ parsing ? '解析中…' : '解析文件' }}</button>
          <button class="small primary" :disabled="!parsedRows.length || submitting" @click="submit">
            {{ submitting ? '导入中…' : `确认导入（${parsedRows.length} 行）` }}
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>

<style scoped>
.modal-mask { position: fixed; inset: 0; background: rgba(15, 23, 42, .45); display: flex; align-items: flex-start; justify-content: center; padding: 6vh 16px; z-index: 90; overflow-y: auto; }
.modal { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 12px; width: 560px; max-width: 100%; padding: 16px 18px; }
.pi-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.pi-head h3 { margin: 0; font-size: 16px; }
.icon-btn { border: 0; background: transparent; cursor: pointer; color: var(--muted); font-size: 14px; }
.pi-steps { margin: 0 0 8px; padding-left: 18px; font-size: 13px; line-height: 1.7; }
.pi-steps a { color: var(--primary); }
.pi-req { margin: 0 0 10px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.pi-field { display: block; margin-bottom: 10px; font-size: 13px; }
.pi-field span { display: block; margin-bottom: 4px; color: var(--muted); }
.pi-field input { width: 100%; }
.pi-preview { font-size: 13px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--primary) 10%, transparent); margin-bottom: 8px; }
.pi-error { font-size: 12.5px; color: #d9534f; margin: 0 0 8px; }
.pi-result { font-size: 13px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.pi-result.ok { border-color: color-mix(in srgb, #2e9e5b 55%, transparent); }
.pi-result-sum { margin: 0 0 4px; }
.pi-fails { margin: 0; padding-left: 18px; font-size: 12.5px; color: #d9534f; max-height: 160px; overflow-y: auto; }
.pi-foot { display: flex; justify-content: flex-end; gap: 8px; }
</style>
