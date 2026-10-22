<script setup>
// 文件管理（v1.18.70）：上传 / 三档可见范围列表 / 在线预览 / 下载 / 删除。
// 可见范围由后端按 org_id + user_type 服务端强制判定，前端 tab 只是快捷筛选（与后端同参数）。
// 预览白名单与后端 previewTypeOf 保持一致：白名单外（HTML/SVG/Office 等）不提供预览，直接下载。
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api.js';

const props = defineProps({
  canUpload: { type: Boolean, default: false },
  canDelete: { type: Boolean, default: false },
  canPlatformAdmin: { type: Boolean, default: false },
});

// 分类 tab（需求 3：按文件权限分类）—— key 即后端 scope 参数
const SCOPES = [
  { key: '', label: '全部' },
  { key: 'all_orgs', label: '全机构共享' },
  { key: 'org', label: '本机构' },
  { key: 'org_company', label: '公司用户' },
];
const VIS_LABEL = { all_orgs: '全机构共享', org: '本机构', org_company: '公司用户' };
// 上传可选档位：all_orgs 仅平台管理员（与后端 canUploadWith 一致）
const UPLOAD_TIERS = [
  { key: 'org', label: '本机构', desc: '本机构全部用户可查看、下载' },
  { key: 'org_company', label: '公司用户', desc: '仅本机构公司用户可查看' },
  { key: 'all_orgs', label: '全机构共享', desc: '所有机构用户均可查看、下载（仅平台管理员）' },
];
const PREVIEW_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.txt', '.md', '.csv', '.json', '.log']);
const MAX_SIZE = 20 * 1024 * 1024; // 与后端 multer 限制一致

const rows = ref([]);
const total = ref(0);
const counts = ref({ all: 0, all_orgs: 0, org: 0, org_company: 0 });
const page = ref(1);
const pageSize = ref(10);
const keyword = ref('');
const scope = ref('');
const loading = ref(false);
const error = ref('');

// 上传弹窗
const showUpload = ref(false);
const upFile = ref(null);
const upVisibility = ref('org');
const upRemark = ref('');
const upSubmitting = ref(false);

// 预览弹窗
const preview = ref(null); // { name, kind: 'image'|'pdf'|'text', url, text }

// 删除确认
const deleteTarget = ref(null);

// 轻量 toast（与 Audited.vue 同款组件级实现）
const toast = ref({ show: false, text: '', kind: 'success' });
let toastTimer = null;
function showToast(text, kind = 'success') {
  toast.value = { show: true, text, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value.show = false; }, 2600);
}

let debounceTimer = null;
function onKeywordInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { page.value = 1; load(); }, 300);
}
function onScopeChange() { page.value = 1; load(); }

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.listFiles({
      q: keyword.value || undefined,
      scope: scope.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = r.rows || [];
    total.value = r.total || 0;
    counts.value = r.counts || { all: 0, all_orgs: 0, org: 0, org_company: 0 };
  } catch (e) {
    error.value = e.message || '加载失败，请稍后重试';
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function changePage(p) {
  if (p < 1) return;
  const maxPage = Math.max(1, Math.ceil(total.value / pageSize.value));
  if (p > maxPage) return;
  page.value = p;
  load();
}
const totalPages = () => Math.max(1, Math.ceil(total.value / pageSize.value));

function fmtTime(v) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '—';
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
function extOf(name) {
  const m = String(name || '').toLowerCase().match(/(\.[a-z0-9]+)$/);
  return m ? m[1] : '';
}
function canPreview(name) { return PREVIEW_EXT.has(extOf(name)); }
function isImageExt(ext) { return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext); }

// ── 上传 ──
function openUpload() {
  upFile.value = null;
  upVisibility.value = 'org';
  upRemark.value = '';
  showUpload.value = true;
}
function onFilePick(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) { upFile.value = null; return; }
  if (f.size > MAX_SIZE) {
    showToast('文件超过 20MB 上限，请压缩或分割后重试', 'error');
    e.target.value = '';
    upFile.value = null;
    return;
  }
  upFile.value = f;
}
async function doUpload() {
  if (!upFile.value) { showToast('请先选择文件', 'error'); return; }
  upSubmitting.value = true;
  try {
    await api.uploadFile(upFile.value, upVisibility.value, upRemark.value.trim());
    showUpload.value = false;
    showToast('上传成功');
    page.value = 1;
    load();
  } catch (e) {
    showToast(e.message || '上传失败', 'error');
  } finally {
    upSubmitting.value = false;
  }
}

// ── 预览 / 下载 ──
async function openPreview(row) {
  if (!canPreview(row.original_name)) {
    // 白名单外（HTML/SVG/Office 等）：不站内渲染，直接下载（与后端 302 防线一致）
    download(row);
    return;
  }
  try {
    const blob = await api.fetchFileBlob(row.id);
    const ext = extOf(row.original_name);
    preview.value = {
      name: row.original_name,
      kind: ext === '.pdf' ? 'pdf' : (isImageExt(ext) ? 'image' : 'text'),
      url: URL.createObjectURL(blob),
      text: '',
    };
    if (preview.value.kind === 'text') preview.value.text = await blob.text();
  } catch (e) {
    showToast(e.message || '预览失败', 'error');
  }
}
function closePreview() {
  if (preview.value && preview.value.url) URL.revokeObjectURL(preview.value.url);
  preview.value = null;
}
async function download(row) {
  try {
    await api.downloadFile(row.id, row.original_name);
  } catch (e) {
    showToast(e.message || '下载失败', 'error');
  }
}

// ── 删除 ──
function askDelete(row) { deleteTarget.value = row; }
async function doDelete() {
  const row = deleteTarget.value;
  if (!row) return;
  try {
    await api.removeFile(row.id);
    showToast('已删除');
    deleteTarget.value = null;
    load();
  } catch (e) {
    showToast(e.message || '删除失败', 'error');
  }
}
function canDeleteRow(row) {
  return props.canDelete || row.mine === true;
}

onMounted(load);
onBeforeUnmount(() => {
  clearTimeout(toastTimer);
  clearTimeout(debounceTimer);
  if (preview.value && preview.value.url) URL.revokeObjectURL(preview.value.url);
});
</script>

<template>
  <section class="fm-page">
    <header class="page-head">
      <div>
        <h1>文件管理</h1>
        <p class="sub">共 <b>{{ total }}</b> 个文件 · 按可见范围分类共享，上传时可选择权限档位</p>
      </div>
      <button v-if="canUpload" class="btn primary" @click="openUpload">上传文件</button>
    </header>

    <div class="fm-tools">
      <input
        v-model="keyword"
        class="fm-search"
        type="search"
        placeholder="搜索文件名 / 备注 / 上传人"
        @input="onKeywordInput"
      />
      <nav class="fm-tabs" aria-label="按可见范围分类">
        <button
          v-for="s in SCOPES"
          :key="s.key"
          class="fm-tab"
          :class="{ active: scope === s.key }"
          :aria-current="scope === s.key ? 'true' : undefined"
          @click="scope = s.key; onScopeChange()"
        >
          {{ s.label }}<span class="fm-tab-count">{{ s.key ? (counts[s.key] || 0) : counts.all }}</span>
        </button>
      </nav>
    </div>

    <p v-if="error" class="fm-error">{{ error }}</p>

    <div v-if="rows.length" class="table-wrap card">
      <table class="mini">
        <thead>
          <tr>
            <th style="min-width:220px">文件名</th>
            <th>可见范围</th>
            <th>大小</th>
            <th>上传者</th>
            <th>上传时间</th>
            <th>备注</th>
            <th class="col-ops">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="fm-name" :title="r.original_name">{{ r.original_name }}</td>
            <td><span class="fm-badge" :class="'fm-badge-' + r.visibility">{{ VIS_LABEL[r.visibility] || r.visibility }}</span></td>
            <td class="fm-muted">{{ fmtSize(r.size) }}</td>
            <td class="fm-muted">{{ r.uploader_name || r.uploaded_by }}</td>
            <td class="fm-muted">{{ fmtTime(r.created_at) }}</td>
            <td class="fm-muted fm-remark" :title="r.remark">{{ r.remark || '—' }}</td>
            <td class="col-ops">
              <button
                class="small"
                :disabled="!canPreview(r.original_name)"
                :title="canPreview(r.original_name) ? '在线预览' : '该类型需下载后查看'"
                @click="openPreview(r)"
              >预览</button>
              <button class="small" @click="download(r)">下载</button>
              <button v-if="canDeleteRow(r)" class="small danger" @click="askDelete(r)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="!loading && !error" class="fm-empty">
      <template v-if="keyword || scope">没有匹配的文件，换个关键词或分类试试。</template>
      <template v-else-if="canUpload">还没有文件。点击右上角「上传文件」开始共享资料。</template>
      <template v-else>暂无可见文件。上传需要管理员授权「上传文件」权限。</template>
    </div>

    <div v-if="rows.length" class="fm-pager">
      <span class="fm-pager-info">共 {{ total }} 个 · 第 {{ page }}/{{ totalPages() }} 页</span>
      <div class="fm-pager-btns">
        <button class="small" :disabled="page <= 1" @click.stop="changePage(page - 1)">上一页</button>
        <button class="small" :disabled="page >= totalPages()" @click.stop="changePage(page + 1)">下一页</button>
      </div>
    </div>

    <!-- 上传弹窗 -->
    <div v-if="showUpload" class="modal-mask" @click.self="showUpload = false">
      <div class="modal fm-modal" role="dialog" aria-modal="true" aria-label="上传文件">
        <div class="fm-modal-head">
          <h3>上传文件</h3>
          <button class="icon-btn" aria-label="关闭" @click="showUpload = false">✕</button>
        </div>
        <label class="fm-field">
          <span class="fm-label">文件（单个不超过 20MB）</span>
          <input type="file" @change="onFilePick" />
        </label>
        <fieldset class="fm-field fm-tiers">
          <legend class="fm-label">可见范围（谁能查看、下载）</legend>
          <label v-for="t in UPLOAD_TIERS" :key="t.key" class="fm-tier" :class="{ disabled: t.key === 'all_orgs' && !canPlatformAdmin }">
            <input
              type="radio"
              name="fm-visibility"
              :value="t.key"
              :disabled="t.key === 'all_orgs' && !canPlatformAdmin"
              v-model="upVisibility"
            />
            <span class="fm-tier-text">
              <b>{{ t.label }}</b>
              <em>{{ t.desc }}</em>
            </span>
          </label>
        </fieldset>
        <label class="fm-field">
          <span class="fm-label">备注（选填，便于他人检索）</span>
          <input v-model="upRemark" type="text" maxlength="500" placeholder="例如：2026 年第三季度运维通报" />
        </label>
        <div class="fm-modal-foot">
          <button class="small" @click="showUpload = false">取消</button>
          <button class="small primary" :disabled="upSubmitting || !upFile" @click="doUpload">
            {{ upSubmitting ? '上传中…' : '开始上传' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 预览弹窗 -->
    <div v-if="preview" class="modal-mask" @click.self="closePreview">
      <div class="modal fm-modal fm-preview-modal" role="dialog" aria-modal="true" :aria-label="'预览：' + preview.name">
        <div class="fm-modal-head">
          <h3 class="fm-preview-title" :title="preview.name">{{ preview.name }}</h3>
          <button class="icon-btn" aria-label="关闭预览" @click="closePreview">✕</button>
        </div>
        <div class="fm-preview-body">
          <img v-if="preview.kind === 'image'" :src="preview.url" :alt="preview.name" />
          <iframe v-else-if="preview.kind === 'pdf'" :src="preview.url" :title="preview.name"></iframe>
          <pre v-else>{{ preview.text }}</pre>
        </div>
        <div class="fm-modal-foot">
          <button class="small" @click="closePreview">关闭</button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="deleteTarget" class="modal-mask" @click.self="deleteTarget = null">
      <div class="modal fm-modal fm-del-modal" role="dialog" aria-modal="true" aria-label="删除文件确认">
        <div class="fm-modal-head">
          <h3>删除文件</h3>
        </div>
        <p class="fm-del-text">确定删除「{{ deleteTarget.original_name }}」？删除后不可恢复，磁盘文件将一并清除。</p>
        <div class="fm-modal-foot">
          <button class="small" @click="deleteTarget = null">取消</button>
          <button class="small danger" @click="doDelete">确认删除</button>
        </div>
      </div>
    </div>

    <transition name="fm-toast-fade">
      <div v-if="toast.show" class="fm-toast" :class="'fm-toast-' + toast.kind" role="status">{{ toast.text }}</div>
    </transition>
  </section>
</template>

<style scoped>
.fm-page { display: flex; flex-direction: column; gap: 14px; }
.fm-page .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.fm-page .page-head h1 { margin: 0; font-size: 18px; font-weight: 650; }
.fm-page .page-head .sub { margin: 4px 0 0; font-size: 12.5px; color: var(--muted); }

.fm-tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.fm-search {
  flex: 1 1 240px; max-width: 380px;
  padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--panel); color: var(--text); font-size: 13.5px;
}
.fm-search:focus { outline: 2px solid var(--primary); outline-offset: -1px; border-color: var(--primary); }

/* 分类 tab（v1.18.47 即时筛选体验：点击即生效，无「应用」按钮） */
.fm-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
.fm-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 12px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--panel); color: var(--muted); font-size: 13px; cursor: pointer;
  transition: border-color .12s, color .12s, background .12s;
}
.fm-tab:hover { border-color: var(--primary); color: var(--text); }
.fm-tab.active {
  border-color: var(--primary); color: var(--primary); font-weight: 600;
  background: color-mix(in srgb, var(--primary) 10%, var(--panel));
}
.fm-tab-count {
  font-size: 11.5px; font-variant-numeric: tabular-nums;
  padding: 1px 7px; border-radius: 999px; background: var(--panel-2); color: var(--muted);
}
.fm-tab.active .fm-tab-count { background: color-mix(in srgb, var(--primary) 18%, var(--panel)); color: var(--primary); }

.fm-error { margin: 0; color: #b91c1c; font-size: 13px; }

.fm-name { word-break: break-all; max-width: 320px; }
.fm-muted { color: var(--muted); font-size: 12.5px; }
.fm-remark { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 三档徽标：全机构共享=主题色实底 / 本机构=描边 / 公司用户=虚线描边 */
.fm-badge {
  display: inline-block; padding: 2px 10px; border-radius: 999px;
  font-size: 12px; font-weight: 600; white-space: nowrap;
}
.fm-badge-all_orgs { background: color-mix(in srgb, var(--primary) 14%, var(--panel)); color: var(--primary); }
.fm-badge-org { border: 1px solid var(--border-strong); color: var(--muted); }
.fm-badge-org_company { border: 1px dashed var(--border-strong); color: var(--muted); }

/* 深色主题：--primary 未随主题重定义（styles.css 深色区只改面板/文本变量），
   主题蓝 #2563eb 在深色面板上直接做文字色对比度不足（lum≈0.36）——
   与浅蓝提亮，保证徽标/当前 tab 文字在深色下可读（CDP verify-files 断言 lum>0.4）。 */
html[data-theme="dark"] .fm-badge-all_orgs { color: color-mix(in srgb, var(--primary) 35%, #cfe0ff); }
html[data-theme="dark"] .fm-tab.active { color: color-mix(in srgb, var(--primary) 35%, #cfe0ff); }
html[data-theme="dark"] .fm-tab.active .fm-tab-count { color: color-mix(in srgb, var(--primary) 35%, #cfe0ff); }

.fm-empty {
  padding: 36px 20px; text-align: center; color: var(--muted); font-size: 13.5px;
  background: var(--panel); border: 1px dashed var(--border-strong); border-radius: 12px;
}
.fm-pager { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.fm-pager-info { font-size: 12.5px; color: var(--muted); }
.fm-pager-btns { display: flex; gap: 8px; }
.fm-pager-btns button:disabled { opacity: .45; cursor: not-allowed; }

/* 弹窗（复用全局 .modal-mask/.modal） */
.fm-modal-head { display: flex; align-items: flex-start; gap: 10px; }
.fm-modal-head h3 { flex: 1; margin: 0; font-size: 15px; font-weight: 650; }
.fm-preview-title { word-break: break-all; }
.fm-field { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
.fm-label { font-size: 12.5px; color: var(--muted); font-weight: 600; }
.fm-field input[type="text"] {
  padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--panel); color: var(--text); font-size: 13.5px;
}
.fm-tiers { border: none; padding: 0; margin: 14px 0 0; display: flex; flex-direction: column; gap: 8px; }
.fm-tier {
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px;
  border: 1px solid var(--border); border-radius: 10px; cursor: pointer;
}
.fm-tier:hover { border-color: var(--primary); }
.fm-tier.disabled { opacity: .55; cursor: not-allowed; }
.fm-tier-text { display: flex; flex-direction: column; gap: 2px; }
.fm-tier-text b { font-size: 13.5px; font-weight: 600; }
.fm-tier-text em { font-style: normal; font-size: 12px; color: var(--muted); }
.fm-modal-foot { margin-top: 18px; display: flex; justify-content: flex-end; gap: 8px; }

.fm-preview-modal { max-width: 860px; width: min(860px, 92vw); }
.fm-preview-body {
  margin-top: 12px; max-height: 66vh; overflow: auto; border: 1px solid var(--border);
  border-radius: 10px; background: var(--panel-2);
}
.fm-preview-body img { display: block; max-width: 100%; margin: 0 auto; }
.fm-preview-body iframe { width: 100%; height: 64vh; border: none; background: #fff; }
.fm-preview-body pre {
  margin: 0; padding: 14px; font-size: 12.5px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-all; color: var(--text);
  font-family: var(--font-mono, ui-monospace, monospace);
}
.fm-del-text { margin: 12px 0 0; font-size: 13.5px; color: var(--text); }

/* toast（与 Audited.vue 同款） */
.fm-toast {
  position: fixed; left: 50%; bottom: 42px; transform: translateX(-50%);
  padding: 9px 18px; border-radius: 999px; font-size: 13px; z-index: 60;
  background: var(--panel); color: var(--text); border: 1px solid var(--border-strong);
  box-shadow: var(--shadow);
}
.fm-toast-success { border-color: var(--primary); color: var(--primary); }
.fm-toast-error { border-color: #b91c1c; color: #b91c1c; }
.fm-toast-fade-enter-active, .fm-toast-fade-leave-active { transition: opacity .18s; }
.fm-toast-fade-enter-from, .fm-toast-fade-leave-to { opacity: 0; }
</style>
