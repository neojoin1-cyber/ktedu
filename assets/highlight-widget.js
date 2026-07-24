/**
 * 형광펜·메모 위젯 (프레임워크 무관 순수 JS)
 * — "설탕과소금" 앱의 AnnotatedHtml.jsx 로직을 그대로 이식.
 * PC(마우스 드래그)·모바일/태블릿(터치 드래그) 둘 다 지원, 형광펜 4색(중요/암기/헷갈림/질문)+메모+별표.
 *
 * 사용법(하단 README.md 참고):
 *   import { mountHighlightWidget } from './highlight-widget.js';
 *   mountHighlightWidget(document.getElementById('content-root'), {
 *     contentId: '이 콘텐츠를 구분하는 고유 id (예: 단원 id)',
 *     getUserId: () => 그 사이트의 로그인 회원 id 또는 null,
 *     api: {
 *       list: async (contentId) => [...],                 // 저장된 형광펜 목록 조회
 *       create: async (payload) => ({...savedRow}),        // payload={gwid,quote,occ,color}
 *       update: async (id, patch) => ({...savedRow}),       // patch={color?,star?,memo?}
 *       remove: async (id) => {},
 *     },
 *   });
 */

const COLORS = ['y', 'g', 'p', 'b'];
const COLOR_HEX = { y: '#fff59d', g: '#a5d6a7', p: '#f48fb1', b: '#90caf9' };
const COLOR_LABEL = { y: '중요', g: '암기', p: '헷갈림', b: '질문' };
const BLOCKSEL = 'h1,h2,h3,h4,p,li,td,th,blockquote';

function cssesc(s) {
  return String(s).replace(/"/g, '\\"');
}

function occOf(block, range, quote) {
  const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
  let pos = 0, node, startOff = -1;
  while ((node = tw.nextNode())) {
    if (node === range.startContainer) {
      startOff = pos + range.startOffset;
      break;
    }
    pos += node.nodeValue.length;
  }
  if (startOff < 0) return 0;
  const full = block.textContent;
  let occ = 0, from = 0, idx;
  while ((idx = full.indexOf(quote, from)) >= 0 && idx < startOff) {
    occ++;
    from = idx + quote.length;
  }
  return occ;
}

function wrapRange(block, quote, occ) {
  if (!quote) return null;
  const full = block.textContent;
  let idx = -1, from = 0;
  for (let k = 0; k <= occ; k++) {
    idx = full.indexOf(quote, from);
    if (idx < 0) return null;
    from = idx + quote.length;
  }
  const range = document.createRange();
  const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null, false);
  let pos = 0, node, startSet = false;
  const end = idx + quote.length;
  while ((node = tw.nextNode())) {
    const len = node.nodeValue.length;
    if (!startSet && idx < pos + len) {
      range.setStart(node, idx - pos);
      startSet = true;
    }
    if (startSet && end <= pos + len) {
      range.setEnd(node, end - pos);
      break;
    }
    pos += len;
  }
  if (!startSet) return null;
  const mark = document.createElement('mark');
  try {
    range.surroundContents(mark);
  } catch {
    try {
      mark.appendChild(range.extractContents());
      range.insertNode(mark);
    } catch {
      return null;
    }
  }
  return mark;
}

function unwrap(m) {
  const p = m.parentNode;
  if (!p) return;
  m.querySelectorAll('.gw-tip').forEach((tip) => tip.remove()); // 메모 툴팁도 함께 제거(본문에 안 남게)
  while (m.firstChild) p.insertBefore(m.firstChild, m);
  p.removeChild(m);
  p.normalize && p.normalize();
}

/**
 * @param {HTMLElement} container - 형광펜을 칠할 콘텐츠가 이미 렌더링되어 있는 요소(그 안의 innerHTML은 건드리지 않음)
 * @param {object} opts
 * @param {string} opts.contentId - 콘텐츠 식별자(단원 id 등)
 * @param {() => (string|null)} opts.getUserId - 로그인 회원 id 반환(비로그인 시 null → 위젯이 자동으로 숨겨짐, 로그인 요구 안내는 호출측 책임)
 * @param {{list:Function, create:Function, update:Function, remove:Function}} opts.api - DB 연동 어댑터(README 참고)
 * @returns {{ destroy: () => void, reload: () => Promise<void> }}
 */
export function mountHighlightWidget(container, opts) {
  const { contentId, getUserId, api } = opts;
  let annos = [];
  let toolbarEl = null;
  let popupEl = null;
  let curSel = null;
  let pendingMemoId = null;

  // 1) 렌더 대상 블록마다 data-gwid 부여(콘텐츠가 바뀔 때마다 재부여 필요 — reload()에서 처리)
  function assignGwids() {
    let n = 0;
    container.querySelectorAll(BLOCKSEL).forEach((el) => {
      el.setAttribute('data-gwid', 'b' + n++);
    });
  }

  function drawMarks() {
    container.querySelectorAll('mark.gw-hl').forEach((m) => unwrap(m));
    annos.forEach((a) => {
      const block = container.querySelector(`[data-gwid="${cssesc(a.gwid)}"]`);
      if (!block) return;
      const mark = wrapRange(block, a.quote, a.occ || 0);
      if (!mark) return;
      mark.dataset.aid = a.id;
      mark.className = `gw-hl c-${a.color}${a.star ? ' star' : ''}${a.memo ? ' hasmemo' : ''}`;
      mark.dataset.label = (a.star ? '★ ' : '') + COLOR_LABEL[a.color] + (a.memo ? ' \u{1F4DD}' : '');
      if (a.memo) {
        const tip = document.createElement('span');
        tip.className = 'gw-tip';
        tip.textContent = a.memo;
        mark.appendChild(tip);
      }
    });
    if (pendingMemoId) {
      const id = pendingMemoId;
      pendingMemoId = null;
      const mark = container.querySelector(`mark.gw-hl[data-aid="${cssesc(id)}"]`);
      const a = annos.find((x) => x.id === id);
      if (mark && a) openPopup(a, mark.getBoundingClientRect());
    }
  }

  async function reload() {
    assignGwids();
    annos = (await api.list(contentId)) || [];
    drawMarks();
  }

  function closeToolbar() {
    if (toolbarEl) {
      toolbarEl.remove();
      toolbarEl = null;
    }
  }
  function closePopup() {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
  }

  function trySelection() {
    const userId = getUserId();
    if (!userId) return; // 비로그인 — 위젯 동작 안 함(호출측이 로그인 안내를 별도로 처리)
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) return;
    const anc = range.commonAncestorContainer;
    const el = anc.nodeType === 3 ? anc.parentElement : anc;
    const block = el && el.closest('[data-gwid]');
    if (!block || !container.contains(block)) return;
    const occ = occOf(block, range, text);
    curSel = { gwid: block.getAttribute('data-gwid'), quote: text, occ };
    const rect = range.getBoundingClientRect();
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    openToolbar({ x: rect.left + rect.width / 2, y: coarse ? rect.bottom + 10 : rect.top, below: coarse });
    closePopup();
  }

  function openToolbar({ x, y, below }) {
    closeToolbar();
    const bar = document.createElement('div');
    bar.className = 'gw-floatbar';
    bar.style.left = Math.min(Math.max(8, x - 130), window.innerWidth - 300) + 'px';
    bar.style.top = (below ? Math.min(y, window.innerHeight - 70) : Math.max(6, y - 58)) + 'px';

    COLORS.forEach((c) => {
      const btn = document.createElement('button');
      btn.className = 'gw-swatchbtn';
      btn.title = COLOR_LABEL[c];
      btn.innerHTML = `<span class="gw-swatch" style="background:${COLOR_HEX[c]}"></span><span class="gw-swatchlabel">${COLOR_LABEL[c]}</span>`;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => createHighlight(c));
      bar.appendChild(btn);
    });

    const sep = document.createElement('span');
    sep.className = 'gw-sep';
    bar.appendChild(sep);

    const memoBtn = document.createElement('button');
    memoBtn.className = 'gw-swatchbtn';
    memoBtn.title = '형광펜 + 메모';
    memoBtn.innerHTML = `<span class="gw-swatch gw-memoicon">✎</span><span class="gw-swatchlabel">메모</span>`;
    memoBtn.addEventListener('mousedown', (e) => e.preventDefault());
    memoBtn.addEventListener('click', () => createHighlight('y', true));
    bar.appendChild(memoBtn);

    const sep2 = document.createElement('span');
    sep2.className = 'gw-sep';
    bar.appendChild(sep2);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'gw-swatchbtn gw-closebtn';
    closeBtn.title = '닫기';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('mousedown', (e) => e.preventDefault());
    closeBtn.addEventListener('click', () => {
      closeToolbar();
      window.getSelection()?.removeAllRanges();
    });
    bar.appendChild(closeBtn);

    document.body.appendChild(bar);
    toolbarEl = bar;
  }

  function openPopup(anno, rect) {
    closePopup();
    const box = document.createElement('div');
    box.className = 'gw-popupbox';
    box.style.left = rect.left + 'px';
    box.style.top = rect.bottom + 6 + 'px';

    const colorRow = document.createElement('div');
    colorRow.className = 'gw-popup-colors';
    COLORS.forEach((c) => {
      const btn = document.createElement('button');
      btn.className = 'gw-swatchbtn';
      btn.title = COLOR_LABEL[c];
      const outline = anno.color === c ? '2px solid #333' : 'none';
      btn.innerHTML = `<span class="gw-swatch" style="background:${COLOR_HEX[c]};outline:${outline}"></span><span class="gw-swatchlabel">${COLOR_LABEL[c]}</span>`;
      btn.addEventListener('click', async () => {
        const row = await api.update(anno.id, { color: c });
        Object.assign(anno, row || { color: c });
        drawMarks();
        openPopup(anno, rect);
      });
      colorRow.appendChild(btn);
    });
    const starBtn = document.createElement('button');
    starBtn.className = 'gw-starbtn';
    starBtn.textContent = anno.star ? '★' : '☆';
    starBtn.addEventListener('click', async () => {
      const row = await api.update(anno.id, { star: !anno.star });
      Object.assign(anno, row || { star: !anno.star });
      drawMarks();
      openPopup(anno, rect);
    });
    colorRow.appendChild(starBtn);
    box.appendChild(colorRow);

    const textarea = document.createElement('textarea');
    textarea.className = 'gw-memo-textarea';
    textarea.placeholder = '메모(암기 포인트 등)';
    textarea.value = anno.memo || '';
    box.appendChild(textarea);

    const btnRow = document.createElement('div');
    btnRow.className = 'gw-popup-actions';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = '메모 저장';
    saveBtn.addEventListener('click', async () => {
      const row = await api.update(anno.id, { memo: textarea.value });
      Object.assign(anno, row || { memo: textarea.value });
      drawMarks();
    });
    const delBtn = document.createElement('button');
    delBtn.textContent = '지우기';
    delBtn.addEventListener('click', async () => {
      await api.remove(anno.id);
      annos = annos.filter((a) => a.id !== anno.id);
      drawMarks();
      closePopup();
    });
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '닫기';
    closeBtn.addEventListener('click', () => closePopup());
    btnRow.append(saveBtn, delBtn, closeBtn);
    box.appendChild(btnRow);

    document.body.appendChild(box);
    popupEl = box;
  }

  async function createHighlight(color, openMemo) {
    if (!curSel) return;
    const row = await api.create({ contentId, gwid: curSel.gwid, quote: curSel.quote, occ: curSel.occ, color });
    if (openMemo) pendingMemoId = row.id;
    annos.push(row);
    drawMarks();
    closeToolbar();
    window.getSelection()?.removeAllRanges();
  }

  function onContainerClick(e) {
    const mark = e.target.closest && e.target.closest('mark.gw-hl');
    if (!mark) return;
    const a = annos.find((x) => x.id === mark.dataset.aid);
    if (!a) return;
    openPopup(a, mark.getBoundingClientRect());
    closeToolbar();
  }

  function onOutside(e) {
    if (toolbarEl && !toolbarEl.contains(e.target)) {
      closeToolbar();
      window.getSelection()?.removeAllRanges();
    }
  }

  let selChangeTimer;
  function onSelChange() {
    clearTimeout(selChangeTimer);
    selChangeTimer = setTimeout(trySelection, 250);
  }

  container.addEventListener('mouseup', trySelection);
  container.addEventListener('touchend', trySelection);
  container.addEventListener('click', onContainerClick);
  document.addEventListener('mousedown', onOutside);
  document.addEventListener('touchstart', onOutside, { passive: true });
  document.addEventListener('selectionchange', onSelChange);

  reload();

  return {
    reload,
    destroy() {
      container.removeEventListener('mouseup', trySelection);
      container.removeEventListener('touchend', trySelection);
      container.removeEventListener('click', onContainerClick);
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
      document.removeEventListener('selectionchange', onSelChange);
      clearTimeout(selChangeTimer);
      closeToolbar();
      closePopup();
      container.querySelectorAll('mark.gw-hl').forEach((m) => unwrap(m));
    },
  };
}
