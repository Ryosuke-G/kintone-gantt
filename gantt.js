/*
 * kintone: vis-timeline ガントチャート（サブテーブル対応）
 * v2: 編集ポップアップ（サブテーブル）＋週フィルター追加
 */

// ====== 設定ここだけ書き換える ======
const CONFIG = {
  VIEW_ID: 13458864,
  RECORD_TITLE_FIELD: '製品名',
  SUBTABLE_CODE: '工程スケジュール',
  TASK_FIELD: '工程名',
  START_FIELD: '工程開始日',
  END_FIELD: '工程終了日',
  LABEL_FIELDS: [
    { code: '製造番号', style: '' },
    { code: '製品名',   style: 'flex:1;font-weight:bold;' },
    { code: '個数',     style: '' },
  ]
};

// ★ true なら終了日列を表示、false なら列ごと非表示
const SHOW_END_DATE = true;
// =====================================

(function () {
  'use strict';

  function getWeekMonday(base) {
    const d = new Date(base);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function getWeekSunday(monday) {
    const d = new Date(monday);
    d.setDate(d.getDate() + 6);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  function toYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function toDate(v) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return new Date(v);
  }

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function endOfDay(d)   { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
  function addDays(d, n) { const dt = new Date(d); dt.setDate(dt.getDate() + n); return dt; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    ));
  }

  async function fetchAll(app, fields) {
    const out = [];
    let offset = 0;
    const limit = 500;
    while (true) {
      const res = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
        app, fields, query: `limit ${limit} offset ${offset}`
      });
      out.push(...res.records);
      if (res.records.length < limit) break;
      offset += limit;
    }
    return out;
  }

  function injectStyle(id, css) {
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = css;
    document.head.appendChild(s);
  }

  const VIS_JS  = 'https://cdn.jsdelivr.net/npm/vis-timeline@8.3.1/standalone/umd/vis-timeline-graph2d.min.js';
  const VIS_CSS = 'https://cdn.jsdelivr.net/npm/vis-timeline@8.3.1/styles/vis-timeline-graph2d.min.css';

  function loadVis() {
    return new Promise((resolve, reject) => {
      if (window.vis && typeof window.vis.Timeline === 'function') return resolve(window.vis);
      if (!document.getElementById('vis-timeline-css')) {
        const link = document.createElement('link');
        link.id = 'vis-timeline-css';
        link.rel = 'stylesheet';
        link.href = VIS_CSS;
        document.head.appendChild(link);
      }
      if (!document.getElementById('vis-timeline-js')) {
        const script = document.createElement('script');
        script.id = 'vis-timeline-js';
        script.src = VIS_JS;
        script.onload = () => {
          if (window.vis && typeof window.vis.Timeline === 'function') resolve(window.vis);
          else reject(new Error('vis loaded but vis.Timeline not found'));
        };
        script.onerror = () => reject(new Error('vis-timeline の読み込みに失敗しました: ' + VIS_JS));
        document.head.appendChild(script);
      } else {
        const existing = document.getElementById('vis-timeline-js');
        existing.addEventListener('load', () => resolve(window.vis));
        existing.addEventListener('error', reject);
      }
    });
  }

  // ==================================================
  //  レコード編集サイドバー（iframe）
  // ==================================================
  function openRecordEditPopup(rid, appId, labelCodes, allRecords) {
    const existing = document.getElementById('gantt-record-popup');
    if (existing) existing.remove();

    const url = `${location.origin}/k/${kintone.app.getId()}/show#record=${rid}&mode=edit`;

    const popup = document.createElement('div');
    popup.id = 'gantt-record-popup';
    popup.style.cssText = `
      position:fixed; top:0; right:0; width:55vw; height:100vh;
      background:#fff; z-index:9990;
      box-shadow:-4px 0 24px rgba(0,0,0,.25);
      display:flex; flex-direction:column;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      display:flex; align-items:center; justify-content:space-between;
      padding:10px 16px; background:#f5f5f5;
      border-bottom:1px solid #ddd; flex-shrink:0;
    `;
    header.innerHTML = `<span style="font-weight:bold;font-size:14px;">✏️ レコード編集</span>`;

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background:none; border:none; font-size:20px;
      cursor:pointer; color:#555; line-height:1; padding:0;
    `;
    closeBtn.title = '閉じる';
    header.appendChild(closeBtn);

    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.cssText = 'flex:1; border:none; width:100%;';

    popup.appendChild(header);
    popup.appendChild(iframe);
    document.body.appendChild(popup);

    const closePopup = async () => {
      popup.remove();
      const fresh = await fetchAll(appId, [
        '$id', CONFIG.RECORD_TITLE_FIELD, CONFIG.SUBTABLE_CODE,
        ...labelCodes
      ]);
      allRecords.length = 0;
      allRecords.push(...fresh);
      if (typeof window.__ganttRebuild === 'function') window.__ganttRebuild();
    };

    closeBtn.addEventListener('click', () => closePopup());

    iframe.addEventListener('load', () => {
      try {
        const iframeUrl = iframe.contentWindow?.location?.href || '';
        if (!iframeUrl.includes('mode=edit')) closePopup();
      } catch (e) {}
    });
  }

  kintone.events.on('app.record.index.show', async (ev) => {
    try {
      if (CONFIG.VIEW_ID && ev.viewId !== CONFIG.VIEW_ID) return ev;

      let visLib;
      try {
        visLib = await loadVis();
      } catch (e) {
        console.error(e);
        const host = document.querySelector('.contents-gaia') || document.body;
        host.insertAdjacentHTML('afterbegin', `<p style="color:red">${e.message}</p>`);
        return ev;
      }

      injectStyle('gantt-cursor-style', '.vis-item{cursor:pointer;}');
      injectStyle('gantt-label-border-style', `
        .vis-label .vis-inner {
          display: flex !important; align-items: center !important;
          gap: 8px !important; padding: 4px 8px !important;
          width: 100% !important; box-sizing: border-box !important;
          border-bottom: 1px solid #bbb !important;
        }
        .vis-panel.vis-left .vis-content { border-right: 2px solid #999 !important; }
        .vis-time-axis .vis-grid.vis-minor { border-left-color: #e0e0e0 !important; }
        .vis-time-axis .vis-grid.vis-major { border-left-color: #bbb !important; }
        .vis-current-time { display: none !important; }
        .vis-time-axis .vis-grid.vis-saturday { background: #cce5ff !important; }
        .vis-time-axis .vis-grid.vis-sunday   { background: #ffd6e0 !important; }
        .vis-time-axis .vis-grid.vis-today    { background: #ffe0b3 !important; }
        .vis-label { border-bottom: none !important; }
        .vis-label .vis-inner {
          border-bottom: 1px solid #bbb !important; height:100%;
          padding: 0 !important; display:flex !important;
          align-items:center !important; gap:0 !important;
        }
        .vis-label .vis-inner > span > span:not(:last-child) {
          border-right: 1px solid #bbb; padding-right: 8px; margin-right: 2px;
        }
        .vis-label:nth-child(even) .vis-inner { background: #f7f7f7 !important; }
      `);
      injectStyle('gantt-axis-label-style', `
        .vis-time-axis .vis-text.vis-minor {
          white-space:pre-line; text-align:center;
          line-height:1.1; height:2.4em; overflow:visible; display:block;
        }
        .vis-time-axis .vis-text.vis-major { line-height:1.1; }
      `);
      injectStyle('gantt-edit-btn-style', `
        .gantt-edit-btn {
          display:inline-flex; align-items:center; justify-content:center;
          width:26px; height:22px; padding:0;
          background:#fff; border:1px solid #aaa; border-radius:4px;
          cursor:pointer; font-size:13px; line-height:1;
          color:#555; vertical-align:middle;
        }
        .gantt-edit-btn:hover { background:#f0f0f0; border-color:#888; }
        #gantt-modal-overlay {
          position:fixed; inset:0; background:rgba(0,0,0,.45); z-index:9998;
          display:flex; align-items:center; justify-content:center;
        }
        #gantt-modal {
          background:#fff; border-radius:10px; padding:24px 28px;
          width:min(700px, 92vw); max-height:80vh; overflow-y:auto;
          z-index:9999; box-shadow:0 8px 32px rgba(0,0,0,.25); font-size:13px;
        }
        #gantt-modal h3 { margin:0 0 14px; font-size:15px; }
        .gantt-modal-table { width:100%; border-collapse:collapse; }
        .gantt-modal-table th, .gantt-modal-table td {
          border:1px solid #ddd; padding:6px 8px; text-align:left;
        }
        .gantt-modal-table th { background:#f5f5f5; white-space:nowrap; }
        .gantt-modal-table input[type=text],
        .gantt-modal-table input[type=date] {
          width:100%; box-sizing:border-box; border:1px solid #ccc;
          border-radius:3px; padding:3px 5px; font-size:13px;
        }
        .gantt-modal-actions {
          margin-top:16px; display:flex; gap:10px; justify-content:flex-end;
        }
        .gantt-modal-actions button {
          padding:7px 20px; border-radius:5px; border:none; cursor:pointer; font-size:13px;
        }
        .btn-save   { background:#3498db; color:#fff; }
        .btn-save:hover { background:#2178b8; }
        .btn-add    { background:#27ae60; color:#fff; }
        .btn-add:hover { background:#1e8b4c; }
        .btn-del {
          background:none; border:1px solid #e74c3c !important;
          color:#e74c3c; padding:3px 8px; border-radius:3px; cursor:pointer; font-size:12px;
        }
        .btn-cancel { background:#aaa; color:#fff; }
        .btn-cancel:hover { background:#888; }
        #gantt-week-nav {
          display:flex; align-items:center; gap:10px;
          margin-bottom:10px; user-select:none;
        }
        #gantt-week-nav button {
          padding:5px 14px; border:1px solid #aaa; border-radius:5px;
          background:#fff; cursor:pointer; font-size:13px;
        }
        #gantt-week-nav button:hover { background:#f0f0f0; }
        #gantt-week-label {
          font-size:14px; font-weight:bold; min-width:180px; text-align:center;
        }
      `);

      const host = document.querySelector('.contents-gaia') || document.body;

      let weekNav = document.getElementById('gantt-week-nav');
      if (!weekNav) {
        weekNav = document.createElement('div');
        weekNav.id = 'gantt-week-nav';
        // ★変更: 「今週」ボタンを日付ピッカーに置き換え
        weekNav.innerHTML = `
          <button id="gantt-week-prev">◀ 前週</button>
          <input type="date" id="gantt-week-picker" title="日付を選択するとその週に移動します"
            style="padding:5px 10px;border:1px solid #aaa;border-radius:5px;font-size:13px;cursor:pointer;background:#fff;">
          <button id="gantt-week-next">次週 ▶</button>
          <select id="gantt-range-select" style="padding:5px 10px;border:1px solid #aaa;border-radius:5px;font-size:13px;background:#fff;cursor:pointer;">
            <option value="7">1週間</option>
            <option value="14">2週間</option>
            <option value="21">3週間</option>
            <option value="28">4週間</option>
            <option value="30">1ヵ月</option>
            <option value="60">2ヵ月</option>
            <option value="90">3ヵ月</option>
            <option value="120">4ヵ月</option>
            <option value="150">5ヵ月</option>
            <option value="180">6ヵ月</option>
          </select>
          <span style="font-size:12px;color:#888;">※ 期間内に工程が含まれるレコードのみ表示</span>
        `;
        host.insertBefore(weekNav, host.firstChild);
      }

      let container = document.getElementById('gantt');
      if (!container) {
        container = document.createElement('div');
        container.id = 'gantt';
        container.style.height = '70vh';
        host.appendChild(container);
      }

      let ganttColHeader = document.getElementById('gantt-col-header');
      if (!ganttColHeader) {
        ganttColHeader = document.createElement('div');
        ganttColHeader.id = 'gantt-col-header';
        ganttColHeader.style.cssText = 'overflow:visible; height:0; position:relative; z-index:10;';
        container.before(ganttColHeader);
      }

      function updateHeader(colWidths) {
        const leftPanel = container.querySelector('.vis-timeline .vis-panel.vis-left');
        const topPanel  = container.querySelector('.vis-timeline .vis-panel.vis-top');
        if (!leftPanel || !topPanel) return;
        const topH  = topPanel.offsetHeight;
        const leftW = leftPanel.offsetWidth;
        ganttColHeader.innerHTML = '';
        const inner = document.createElement('div');
        inner.style.cssText = `
          position:absolute; left:${leftPanel.offsetLeft}px; top:0px;
          width:${leftW}px; height:${topH}px; background:#f0f0f0;
          border-right:2px solid #999; border-bottom:2px solid #999;
          display:flex; align-items:center; padding:0;
          box-sizing:border-box; pointer-events:none; overflow:visible;
        `;
        let html = '<span style="width:58px;flex-shrink:0;box-sizing:border-box;"></span>';
        CONFIG.LABEL_FIELDS.forEach((f, i) => {
          const s = f.style || '';
          const ta = (s.match(/text-align:([^;]+)/) || [])[1] || 'left';
          const isFlex = s.includes('flex:1');
          const isLast = i === CONFIG.LABEL_FIELDS.length - 1;
          const cw = (colWidths && colWidths[i]) ? colWidths[i] : null;
          const widthStyle = isFlex ? 'flex:1;min-width:0;' : cw ? `width:${cw}px;flex-shrink:0;flex-grow:0;` : 'flex:1;min-width:0;';
          const borderR = !isLast ? 'border-right:1px solid #999;' : '';
          html += `<span style="${widthStyle}font-size:13px;font-weight:bold;text-align:${ta};white-space:nowrap;padding:0 4px;box-sizing:border-box;${borderR}">${f.code}</span>`;
        });
        inner.innerHTML = html;
        ganttColHeader.appendChild(inner);
      }

      let detail = document.getElementById('gantt-detail');
      if (!detail) {
        detail = document.createElement('div');
        detail.id = 'gantt-detail';
        Object.assign(detail.style, {
          marginTop: '12px', border: '1px solid #ddd',
          borderRadius: '8px', padding: '12px', background: '#fff'
        });
        container.after(detail);
      }

      const appId = kintone.app.getId();
      const labelCodes = CONFIG.LABEL_FIELDS.map(f => f.code);
      const allRecords = await fetchAll(appId, [
        '$id', CONFIG.RECORD_TITLE_FIELD, CONFIG.SUBTABLE_CODE,
        ...labelCodes
      ]);

      let currentMonday = getWeekMonday(new Date());

      function updateWeekLabel() {
        const picker = document.getElementById('gantt-week-picker');
        if (picker) picker.value = toYMD(currentMonday);
      }

      let displayDays = 7;
      let timeline = null;

      function buildGantt() {
        const weekStart = startOfDay(currentMonday);
        const weekEnd   = endOfDay(addDays(currentMonday, displayDays - 1));
        const groups    = [];
        const items     = [];
        const itemMeta  = new Map();
        const groupMeta = new Map();

        allRecords.forEach((rec) => {
          const recordId = rec.$id?.value;
          const rows = rec[CONFIG.SUBTABLE_CODE]?.value || [];

          const weekRows = rows.filter((row) => {
            const s = row.value[CONFIG.START_FIELD]?.value;
            const e = row.value[CONFIG.END_FIELD]?.value;
            if (!s) return false;
            const start = startOfDay(toDate(s));
            const end   = e ? endOfDay(toDate(e)) : endOfDay(start);
            return start <= weekEnd && end >= weekStart;
          });
          if (!weekRows.length) return;

          const labelText = CONFIG.LABEL_FIELDS
            .map(f => rec[f.code]?.value || '')
            .filter(Boolean)
            .join(' ');

          groups.push({ id: recordId, content: labelText, _rid: recordId });
          groupMeta.set(String(recordId), rec);

          rows.forEach((row, idx) => {
            const task     = row.value[CONFIG.TASK_FIELD]?.value  || `工程${idx + 1}`;
            const startRaw = row.value[CONFIG.START_FIELD]?.value;
            const endRaw   = row.value[CONFIG.END_FIELD]?.value;
            if (!startRaw) return;
            const start = startOfDay(toDate(startRaw));
            let end = endRaw ? endOfDay(toDate(endRaw)) : endOfDay(start);
            if (end <= start) end = endOfDay(start);
            const id = `${recordId}-${idx}`;
            items.push({ id, group: recordId, content: escapeHtml(task), start, end });
            itemMeta.set(id, { recordId, task, start, end });
          });
        });

        if (timeline) { timeline.destroy(); timeline = null; }

        if (!items.length) {
          container.innerHTML = '<div style="padding:10px;border:1px solid #ccc;">この期間に該当するデータがありません。</div>';
          detail.innerHTML = '';
          return;
        } else {
          container.innerHTML = '';
        }

        const groupsDS = new visLib.DataSet(groups);
        const itemsDS  = new visLib.DataSet(items);

        timeline = new visLib.Timeline(container, itemsDS, groupsDS, {
          stack: true, selectable: true, zoomable: true, moveable: false,
          editable: { updateTime: true, updateGroup: false, remove: false },
          snap: (date) => {
            const d = new Date(date);
            d.setHours(0, 0, 0, 0);
            return d;
          },
          orientation: 'top', groupEditable: false,
          margin: { item: { horizontal: 0, vertical: 8 }, axis: 8 },
          timeAxis: { scale: 'day', step: 1 },
          format: {
            minorLabels: (dateLike) => {
              const d = new Date(dateLike);
              const w = ['日','月','火','水','木','金','土'][d.getDay()];
              return `${d.getDate()}\n${w}`;
            },
            majorLabels: (dateLike) => {
              const d = new Date(dateLike);
              return `${d.getFullYear()}年 ${d.getMonth() + 1}月`;
            }
          },
          start: addDays(currentMonday, -1),
          end:   addDays(currentMonday, displayDays)
        });

        // Shiftスクロールで横移動
        container.addEventListener('wheel', (e) => {
          if (!e.shiftKey) return;
          e.preventDefault();
          const w = timeline.getWindow();
          const interval = w.end - w.start;
          const shift = interval * (e.deltaY > 0 ? 0.2 : -0.2);
          timeline.setWindow(new Date(w.start.valueOf() + shift), new Date(w.end.valueOf() + shift), { animation: false });
        }, { passive: false });

        // 右クリックで編集モーダルを開く（vis-timeline の contextmenu イベントを使用）
        container.addEventListener('contextmenu', (e) => e.preventDefault());
        timeline.on('contextmenu', (p) => {
          if (!p.item) return;
          const meta = itemMeta.get(String(p.item));
          if (!meta) return;
          openEditModal(String(meta.recordId), allRecords);
        });

        window.__ganttRebuild = buildGantt;

        // ★変更: 最小幅60pxを保証
        const colWidths = (() => {
          const ruler = document.createElement('span');
          ruler.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-size:13px;padding:0 8px;';
          document.body.appendChild(ruler);
          const widths = CONFIG.LABEL_FIELDS.map((f) => {
            if ((f.style || '').includes('flex:1')) return null;
            ruler.style.fontWeight = 'bold';
            ruler.textContent = f.code;
            let maxW = ruler.offsetWidth;
            ruler.style.fontWeight = (f.style||'').includes('font-weight:bold') ? 'bold' : 'normal';
            allRecords.forEach(rec => {
              const val = String(rec[f.code]?.value || '');
              ruler.textContent = val;
              if (ruler.offsetWidth > maxW) maxW = ruler.offsetWidth;
            });
            return Math.max(maxW + 8, 60);
          });
          document.body.removeChild(ruler);
          return widths;
        })();

        function injectEditButtons() {
          container.querySelectorAll('.vis-label').forEach((label) => {
            const inner = label.querySelector('.vis-inner');
            if (!inner || inner.querySelector('.gantt-detail-btn')) return;

            const groupId = label.getAttribute('data-id') ||
              label.closest('[data-id]')?.getAttribute('data-id');
            let rid = groupId;
            if (!rid || !groupMeta.has(String(rid))) {
              for (const [id] of groupMeta) {
                const g = groups.find(g => String(g.id) === id);
                if (g && inner.textContent.includes(g.content.split(' ')[0])) { rid = id; break; }
              }
            }
            if (!rid || !groupMeta.has(String(rid))) return;
            const rec = groupMeta.get(String(rid));

            const detailBtn = document.createElement('button');
            detailBtn.className = 'gantt-edit-btn gantt-detail-btn';
            detailBtn.title = 'レコード詳細を開く';
            detailBtn.textContent = '🔍';
            detailBtn.dataset.detailRid = rid;

            const editBtn = document.createElement('button');
            editBtn.className = 'gantt-edit-btn gantt-edit-record-btn';
            editBtn.title = 'レコードを編集する';
            editBtn.textContent = '✏️';
            editBtn.dataset.editRid = rid;

            inner.innerHTML = '';
            inner.style.alignItems = 'flex-start';
            inner.style.paddingTop = '8px';

            // ★変更: ボタンエリアに右ボーダーを追加
            const btnWrap = document.createElement('span');
            btnWrap.style.cssText = 'display:inline-flex;gap:2px;flex-shrink:0;width:58px;box-sizing:border-box;border-right:1px solid #bbb;';
            btnWrap.appendChild(detailBtn);
            btnWrap.appendChild(editBtn);
            inner.appendChild(btnWrap);

            const textWrap = document.createElement('span');
            textWrap.style.cssText = 'display:inline-flex;align-items:center;height:100%;flex:1;overflow:hidden;';
            CONFIG.LABEL_FIELDS.forEach((f, i) => {
              const val = rec[f.code]?.value ?? '';
              const span = document.createElement('span');
              const s  = f.style || '';
              const isFlex = s.includes('flex:1');
              const fw = s.includes('font-weight:bold') ? 'bold' : 'normal';
              const ta = (s.match(/text-align:([^;]+)/) || [])[1] || 'left';
              const w  = colWidths[i];
              const isLast = i === CONFIG.LABEL_FIELDS.length - 1;
              // ★変更: padding を 0 8px に統一
              span.style.cssText = `
                ${isFlex ? 'flex:1;min-width:0;' : `width:${w}px;flex-shrink:0;flex-grow:0;`}
                font-size:13px; font-weight:${fw}; text-align:${ta};
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                padding:0 8px; box-sizing:border-box;
                ${!isLast ? 'border-right:1px solid #bbb;' : ''}
              `;
              span.textContent = val;
              textWrap.appendChild(span);
            });
            inner.appendChild(textWrap);
          });
        }

        requestAnimationFrame(() => requestAnimationFrame(() => {
          injectEditButtons();
          updateHeader(colWidths);
        }));
        timeline.on('changed', () => { injectEditButtons(); updateHeader(colWidths); });

        // 左クリックはドラッグ専用（モーダルは右クリックで開く）
        timeline.on('click', (p) => {
          if (p.event?.target?.closest('[data-detail-rid]')) return;
          if (p.event?.target?.closest('[data-edit-rid]')) return;
        });

        // ドラッグ&ドロップ後にkintoneへ保存
        timeline.on('itemMoved', async (props) => {
          // ドラッグ完了
          const meta = itemMeta.get(String(props.id));
          if (!meta) return;

          const newStart = toYMD(props.start);
          const newEnd   = toYMD(addDays(props.end, -1)); // endOfDayを1日戻す

          // メモリ上のallRecordsを更新
          const rec = allRecords.find(r => String(r.$id?.value) === String(meta.recordId));
          if (!rec) return;
          const rows = rec[CONFIG.SUBTABLE_CODE]?.value || [];
          const rowIdx = Number(String(props.id).split('-').pop());
          const targetRow = rows[rowIdx];
          if (!targetRow) return;

          const updatedRows = rows.map((row, i) => {
            if (i !== rowIdx) return row;
            return {
              ...row,
              value: {
                ...row.value,
                [CONFIG.START_FIELD]: { value: newStart },
                [CONFIG.END_FIELD]:   { value: newEnd }
              }
            };
          });

          // 保存中トースト表示
          const toast = document.createElement('div');
          toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 20px;border-radius:6px;font-size:13px;z-index:9999;';
          toast.textContent = '保存中…';
          document.body.appendChild(toast);

          try {
            await kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
              app: kintone.app.getId(),
              id: meta.recordId,
              record: {
                [CONFIG.SUBTABLE_CODE]: {
                  value: updatedRows.map(row => ({
                    id: row.id,
                    value: {
                      [CONFIG.TASK_FIELD]:  row.value[CONFIG.TASK_FIELD],
                      [CONFIG.START_FIELD]: row.value[CONFIG.START_FIELD],
                      [CONFIG.END_FIELD]:   row.value[CONFIG.END_FIELD]
                    }
                  }))
                }
              }
            });
            rec[CONFIG.SUBTABLE_CODE].value = updatedRows;
            itemMeta.set(String(props.id), { ...meta, start: props.start, end: props.end });
            toast.textContent = '✓ 保存しました';
            toast.style.background = '#27ae60';
          } catch (err) {
            console.error(err);
            toast.textContent = '保存に失敗しました: ' + (err.message || '');
            toast.style.background = '#e74c3c';
            buildGantt(); // 失敗時は元に戻す
          }
          setTimeout(() => toast.remove(), 2000);
        });

        if (!container._ganttEditListenerAdded) {
          container._ganttEditListenerAdded = true;
          container.addEventListener('click', (e) => {
            const detailBtn = e.target.closest('[data-detail-rid]');
            if (detailBtn) {
              e.stopPropagation();
              window.location.href = `${location.origin}/k/${kintone.app.getId()}/show#record=${detailBtn.dataset.detailRid}`;
              return;
            }
            const editBtn = e.target.closest('[data-edit-rid]');
            if (editBtn) {
              e.stopPropagation();
              openRecordEditPopup(editBtn.dataset.editRid, appId, labelCodes, allRecords);
            }
          });
        }
      }

      updateWeekLabel();
      buildGantt();

      function replaceBtn(id, handler) {
        const old = document.getElementById(id);
        if (!old) return;
        const neo = old.cloneNode(true);
        old.replaceWith(neo);
        neo.addEventListener('click', handler);
      }
      // ★変更: 今週ボタン削除、前週・次週のみ
      replaceBtn('gantt-week-prev', () => { currentMonday = addDays(currentMonday, -7); updateWeekLabel(); buildGantt(); });
      replaceBtn('gantt-week-next', () => { currentMonday = addDays(currentMonday,  7); updateWeekLabel(); buildGantt(); });

      // ★変更: 表示期間プルダウンのイベント登録
      const rangeSelect = document.getElementById('gantt-range-select');
      if (rangeSelect) {
        rangeSelect.value = String(displayDays);
        rangeSelect.addEventListener('change', () => {
          displayDays = Number(rangeSelect.value);
          buildGantt();
        });
      }

      // ★変更: 日付ピッカーのイベント登録
      const picker = document.getElementById('gantt-week-picker');
      if (picker) {
        picker.value = toYMD(new Date());
        picker.addEventListener('change', () => {
          if (!picker.value) return;
          currentMonday = getWeekMonday(new Date(picker.value));
          updateWeekLabel();
          buildGantt();
        });
      }

      return ev;
    } catch (e) {
      console.error(e);
      alert('ガント描画中にエラーが発生しました。\n' + (e?.message || String(e)));
      return ev;
    }
  });

  // ==================================================
  //  工程スケジュール編集モーダル（サブテーブル）
  // ==================================================
  function openEditModal(recordId, allRecords) {
    const rec = allRecords.find((r) => String(r.$id?.value) === String(recordId));
    if (!rec) return;

    const title = rec[CONFIG.RECORD_TITLE_FIELD]?.value || `#${recordId}`;
    const rows  = rec[CONFIG.SUBTABLE_CODE]?.value || [];

    const existing = document.getElementById('gantt-modal-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'gantt-modal-overlay';

    function rowHtml(idx, row) {
      const task  = escapeHtml(row?.value?.[CONFIG.TASK_FIELD]?.value  || '');
      const start = escapeHtml(row?.value?.[CONFIG.START_FIELD]?.value || '');
      const end   = escapeHtml(row?.value?.[CONFIG.END_FIELD]?.value   || '');
      return `
        <tr data-row-idx="${idx}">
          <td><input type="text" class="f-task"  value="${task}"  placeholder="工程名"></td>
          <td><input type="date" class="f-start" value="${start}"></td>
          ${SHOW_END_DATE ? `<td><input type="date" class="f-end" value="${end}"></td>` : ''}
          <td style="text-align:center;">
            <button class="btn-del">削除</button>
          </td>
        </tr>
      `;
    }

    const endHeader     = SHOW_END_DATE ? '<th style="width:22%">工程終了日</th>' : '';
    const colWidthTask  = SHOW_END_DATE ? '38%' : '60%';
    const colWidthStart = SHOW_END_DATE ? '20%' : '30%';

    overlay.innerHTML = `
      <div id="gantt-modal">
        <h3>✏️ 工程スケジュール編集：${escapeHtml(title)}</h3>
        <table class="gantt-modal-table">
          <thead>
            <tr>
              <th style="width:${colWidthTask}">工程名</th>
              <th style="width:${colWidthStart}">工程開始日</th>
              ${endHeader}
              <th style="width:10%"></th>
            </tr>
          </thead>
          <tbody id="gantt-modal-tbody">
            ${rows.map((row, i) => rowHtml(i, row)).join('')}
          </tbody>
        </table>
        <div class="gantt-modal-actions">
          <button class="btn-add"    id="gantt-modal-add">＋ 行追加</button>
          <button class="btn-cancel" id="gantt-modal-cancel">キャンセル</button>
          <button class="btn-save"   id="gantt-modal-save">保存</button>
        </div>
        <div id="gantt-modal-msg" style="margin-top:10px;font-size:12px;color:#e74c3c;"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    let rowCount = rows.length;
    overlay.querySelector('#gantt-modal-add').addEventListener('click', () => {
      const tbody = overlay.querySelector('#gantt-modal-tbody');
      const tmp = document.createElement('tbody');
      tmp.innerHTML = rowHtml(rowCount, null);
      tbody.appendChild(tmp.firstElementChild);
      rowCount++;
    });

    overlay.querySelector('#gantt-modal-tbody').addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-del')) e.target.closest('tr').remove();
    });

    overlay.querySelector('#gantt-modal-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    overlay.querySelector('#gantt-modal-save').addEventListener('click', async () => {
      const msgEl = overlay.querySelector('#gantt-modal-msg');
      msgEl.textContent = '';

      const tbody = overlay.querySelector('#gantt-modal-tbody');
      const trs   = tbody.querySelectorAll('tr');

      const subtableValue = [];
      for (const tr of trs) {
        const task  = tr.querySelector('.f-task').value.trim();
        const start = tr.querySelector('.f-start').value;
        const end   = SHOW_END_DATE ? tr.querySelector('.f-end').value : '';

        if (!task && !start) continue;
        if (!start) { msgEl.textContent = `「${task}」の工程開始日が未入力です。`; return; }

        const origIdx = Number(tr.dataset.rowIdx);
        const origRow = rows[origIdx];
        const entry = {
          value: {
            [CONFIG.TASK_FIELD]:  { value: task },
            [CONFIG.START_FIELD]: { value: start },
            [CONFIG.END_FIELD]:   { value: end }
          }
        };
        if (origRow?.id) entry.id = origRow.id;
        subtableValue.push(entry);
      }

      const saveBtn = overlay.querySelector('#gantt-modal-save');
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        await kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
          app: kintone.app.getId(),
          id: recordId,
          record: { [CONFIG.SUBTABLE_CODE]: { value: subtableValue } }
        });

        const target = allRecords.find((r) => r.$id?.value === recordId);
        if (target) target[CONFIG.SUBTABLE_CODE].value = subtableValue.map((entry, i) => ({
          id: entry.id || `new-${i}`,
          value: entry.value
        }));

        overlay.remove();
        if (typeof window.__ganttRebuild === 'function') {
          window.__ganttRebuild();
        } else {
          location.reload();
        }
      } catch (err) {
        console.error(err);
        msgEl.textContent = '保存に失敗しました：' + (err.message || JSON.stringify(err));
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
      }
    });
  }

})();
