// 底部常驻横向滚动条（v1.18.58）
// 宽表（width: max-content）超出视口时，原生横向滚动条贴在滚动容器底边；
// 容器很高时用户必须先纵向滚到底才能拖到。这里在视图最底部放一条同宽度的
// 同步滚动条，与表格双向联动，任何滚动位置都能直接拖动。
//
// 用法：
//   const { twEl, tblEl, hsEl, hsWidth, hsNeed, onTwScroll, onHsScroll } = useHScroll(rowsRef);
//   <div ref="twEl" class="table-wrap" @scroll="onTwScroll">
//     <table ref="tblEl" class="dgrid">…</table>
//   </div>
//   <div v-if="hsNeed" ref="hsEl" class="hscroll" @scroll="onHsScroll">
//     <div class="hscroll-inner" :style="{ width: hsWidth + 'px' }"></div>
//   </div>
import { ref, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';

export function useHScroll(rowsRef) {
  const twEl = ref(null);  // 表格滚动容器（提供 clientWidth / scrollLeft）
  const tblEl = ref(null); // table 本体（内容宽度来源，用于尺寸监听）
  const hsEl = ref(null);  // 底部同步条容器
  const hsWidth = ref(0);  // 同步条内层宽度 = 表格实际内容宽
  const hsNeed = ref(false); // 内容宽 > 容器宽时才显示
  let lock = false;

  function syncHsWidth() {
    const tw = twEl.value;
    if (!tw) { hsNeed.value = false; return; }
    hsWidth.value = tw.scrollWidth;
    hsNeed.value = tw.scrollWidth - tw.clientWidth > 2;
  }
  function onTwScroll() {
    if (lock || !hsEl.value || !twEl.value) return;
    lock = true; hsEl.value.scrollLeft = twEl.value.scrollLeft; lock = false;
  }
  function onHsScroll() {
    if (lock || !twEl.value || !hsEl.value) return;
    lock = true; twEl.value.scrollLeft = hsEl.value.scrollLeft; lock = false;
  }

  // 这里就实例化（而不是 onMounted）：ref 在首次 patch 时赋值，
  // 下面的 watch 会先于 onMounted 触发，晚建监听会漏掉首次挂载。
  const ro = new ResizeObserver(() => syncHsWidth());

  if (rowsRef) watch(rowsRef, () => { nextTick(syncHsWidth); }, { deep: false });

  watch([tblEl, twEl], () => {
    ro.disconnect();
    if (tblEl.value) ro.observe(tblEl.value);
    if (twEl.value) ro.observe(twEl.value);
    nextTick(syncHsWidth);
  });

  const onWinResize = () => syncHsWidth();
  onMounted(() => window.addEventListener('resize', onWinResize));
  onBeforeUnmount(() => {
    window.removeEventListener('resize', onWinResize);
    ro.disconnect();
  });

  return { twEl, tblEl, hsEl, hsWidth, hsNeed, onTwScroll, onHsScroll };
}
