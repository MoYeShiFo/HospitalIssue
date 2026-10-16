<script setup>
// 通用多选下拉（v1.18.58，对齐 WXP 原版字典筛选：面板内复选 + 全选/清空 + 确定）。
// props: options(字符串数组), modelValue(选中数组)；点击外部自动收起。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  options: { type: Array, default: () => [] },
  modelValue: { type: Array, default: () => [] },
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const root = ref(null);
const draft = ref([]); // 面板内暂存，确定后才提交

function togglePanel() {
  if (!open.value) draft.value = [...props.modelValue];
  open.value = !open.value;
}
function isChecked(v) { return draft.value.includes(v); }
function toggleOpt(v, checked) {
  draft.value = checked ? [...draft.value, v] : draft.value.filter((x) => x !== v);
}
function selectAll() { draft.value = [...props.options]; }
function clearAll() { draft.value = []; }
function confirm() { emit('update:modelValue', draft.value); open.value = false; }

const label = computed(() => {
  const n = props.modelValue.length;
  if (!n) return '全部';
  if (n <= 2) return props.modelValue.join('、');
  return `${props.modelValue[0]} 等 ${n} 项`;
});

function onDocClick(e) {
  if (root.value && !root.value.contains(e.target)) {
    if (open.value) { draft.value = [...props.modelValue]; open.value = false; }
  }
}
onMounted(() => document.addEventListener('click', onDocClick));
onBeforeUnmount(() => document.removeEventListener('click', onDocClick));
</script>

<template>
  <div ref="root" class="ms">
    <button type="button" class="ms-btn" :class="{ active: modelValue.length }" @click="togglePanel">
      <span class="ms-label" :title="modelValue.join('、')">{{ label }}</span>
      <span class="ms-caret">▾</span>
    </button>
    <div v-if="open" class="ms-panel">
      <div class="ms-ops">
        <button type="button" class="ms-op" @click="selectAll">全选</button>
        <button type="button" class="ms-op" @click="clearAll">清空</button>
      </div>
      <div class="ms-list">
        <label v-for="o in options" :key="o" class="ms-item">
          <input type="checkbox" :checked="isChecked(o)" @change="toggleOpt(o, $event.target.checked)">{{ o }}
        </label>
        <div v-if="!options.length" class="ms-empty">暂无选项</div>
      </div>
      <div class="ms-foot">
        <button type="button" class="ms-ok" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ms { position: relative; display: inline-block; }
.ms-btn { display: inline-flex; align-items: center; justify-content: space-between; gap: 6px; width: 130px; height: 32px; padding: 0 10px; border: 1px solid #d5dbe3; border-radius: 8px; background: #fff; font-size: 12.5px; color: #1f2937; cursor: pointer; }
.ms-btn.active { border-color: #2f6fed; }
.ms-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-caret { color: #8a94a2; font-size: 10px; }
.ms-panel { position: absolute; top: calc(100% + 4px); left: 0; z-index: 30; min-width: 190px; max-width: 280px; background: #fff; border: 1px solid #d5dbe3; border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14); padding: 8px; }
.ms-ops { display: flex; gap: 10px; padding: 0 4px 6px; border-bottom: 1px solid #eef1f5; }
.ms-op { background: none; border: none; color: #2f6fed; cursor: pointer; font-size: 12px; padding: 0; }
.ms-op:hover { text-decoration: underline; }
.ms-list { max-height: 240px; overflow: auto; padding: 6px 2px; }
/* 提高特异性压过全局 .card label（纵向排列+大输入框），选项必须单行：复选框 | 文字 */
.ms .ms-list .ms-item { display: flex; flex-direction: row; align-items: center; gap: 7px; font-size: 12.5px; color: #334155; padding: 5px 6px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.ms .ms-list .ms-item:hover { background: #f4f6f9; }
.ms .ms-list .ms-item input { width: 15px; height: 15px; min-height: 0; padding: 0; margin: 0; flex-shrink: 0; accent-color: #2f6fed; cursor: pointer; }
.ms-empty { color: #8a94a2; font-size: 12px; padding: 8px 4px; }
.ms-foot { display: flex; justify-content: flex-end; padding-top: 6px; border-top: 1px solid #eef1f5; }
.ms-ok { background: #2f6fed; border: 1px solid #2f6fed; color: #fff; border-radius: 7px; padding: 4px 14px; font-size: 12px; cursor: pointer; }
.ms-ok:hover { background: #245bd0; }
</style>
