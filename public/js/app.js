'use strict';

let state = {
  cues: [], // 原始提示点（供前置选择）
  scheduled: [], // 排程结果
  cycle: null,
  conflicts: [], // 演员时间冲突
  editingId: null,
  sim: null, // 延误推演结果（null 表示未在推演）
};

const els = {
  tbody: document.getElementById('cue-tbody'),
  banner: document.getElementById('cycle-banner'),
  conflictBanner: document.getElementById('conflict-banner'),
  stats: document.getElementById('stats'),
  mask: document.getElementById('modal-mask'),
  form: document.getElementById('cue-form'),
  modalTitle: document.getElementById('modal-title'),
  preList: document.getElementById('pre-list'),
  formError: document.getElementById('form-error'),
  simForm: document.getElementById('sim-form'),
  simCue: document.getElementById('sim-cue'),
  simDelay: document.getElementById('sim-delay'),
  simClear: document.getElementById('sim-clear'),
  simError: document.getElementById('sim-error'),
  simResult: document.getElementById('sim-result'),
};

document.getElementById('btn-new').addEventListener('click', () => openModal());
document.getElementById('btn-cancel').addEventListener('click', closeModal);
els.mask.addEventListener('click', (e) => {
  if (e.target === els.mask) closeModal();
});
els.form.addEventListener('submit', onSubmit);
els.simForm.addEventListener('submit', onSimulate);
els.simClear.addEventListener('click', clearSimulation);

async function refresh() {
  const [cues, scheduleResult] = await Promise.all([
    CS.api('/api/cues'),
    CS.api('/api/schedule'),
  ]);
  state.cues = cues;
  state.scheduled = scheduleResult.cues;
  state.cycle = scheduleResult.cycle;
  state.conflicts = scheduleResult.conflicts || [];
  state.sim = null; // 数据已变化，旧的推演结果作废
  hideSimError();
  render();
}

function render() {
  renderBanner();
  renderConflictBanner();
  renderStats();
  renderTable();
  renderSimControls();
  renderSimResult();
}

function renderBanner() {
  if (!state.cycle) {
    els.banner.classList.add('hidden');
    els.banner.innerHTML = '';
    return;
  }
  const byId = new Map(state.scheduled.map((c) => [c.id, c]));
  const chains = (state.cycle.paths || (state.cycle.path ? [state.cycle.path] : []))
    .map(
      (p) =>
        `<span class="cycle-chain">${p
          .map((id) => CS.esc(CS.labelOf(byId, id)))
          .join(' → ')}</span>`
    )
    .join(' ');
  const names = state.cycle.nodes
    .map((id) => {
      const c = byId.get(id);
      return c ? `${c.ref ? c.ref + ' ' : ''}「${CS.esc(c.title)}」` : `#${id}`;
    })
    .join('、');
  els.banner.innerHTML =
    `⚠ <strong>发现环依赖，涉及 ${state.cycle.nodes.length} 个提示点：</strong>${names}<br>` +
    (chains ? `环路：${chains}<br>` : '') +
    `<span>环上及其下游提示点暂无法排程，请在编辑中移除构成环的某项前置关系。</span>`;
  els.banner.classList.remove('hidden');
}

function renderConflictBanner() {
  if (!state.conflicts.length) {
    els.conflictBanner.classList.add('hidden');
    els.conflictBanner.innerHTML = '';
    return;
  }
  const cueLabel = (c) => `${c.ref ? CS.esc(c.ref) + ' ' : ''}「${CS.esc(c.title)}」`;
  const items = state.conflicts
    .map(
      (cf) =>
        `<span class="conflict-item"><strong>${CS.esc(cf.actor)}</strong>：` +
        `${cueLabel(cf.cueA)} 与 ${cueLabel(cf.cueB)} 重叠 ` +
        `<code>${CS.fmtTime(cf.overlapStart)} – ${CS.fmtTime(cf.overlapEnd)}</code></span>`
    )
    .join(' ');
  els.conflictBanner.innerHTML =
    `⚠ <strong>发现 ${state.conflicts.length} 处演员时间冲突：</strong><br>` +
    `${items}<br>` +
    `<span>结束恰好等于另一项开始不算冲突；环依赖及其阻塞项不参与检查。修改演员、时长或前置关系后自动重新检查。</span>`;
  els.conflictBanner.classList.remove('hidden');
}

function renderStats() {
  const total = state.scheduled.length;
  const scheduled = state.scheduled.filter((c) => c.scheduled);
  const overdue = state.scheduled.filter((c) => c.overdue).length;
  const cyclic = state.cycle ? state.cycle.nodes.length : 0;
  const blocked = state.scheduled.filter((c) => c.blockedByCycle).length;
  const conflicts = state.conflicts.length;
  const finish = scheduled.length ? Math.max(...scheduled.map((c) => c.earliestFinish)) : null;

  const stat = (cls, num, label) =>
    `<div class="stat ${cls}"><div class="num">${num}</div><div class="label">${label}</div></div>`;

  els.stats.innerHTML =
    stat('', total, '提示点总数') +
    stat('', scheduled.length, '可排程') +
    stat(cyclic ? 'danger' : '', cyclic, '环依赖') +
    stat(blocked ? 'warn' : '', blocked, '被环阻塞') +
    stat(conflicts ? 'warn' : '', conflicts, '演员冲突') +
    stat(overdue ? 'danger' : '', overdue, '超过最晚完成') +
    stat('', finish == null ? '—' : CS.fmtTime(finish), '预计全部完成');
}

function renderTable() {
  const byId = new Map(state.scheduled.map((c) => [c.id, c]));
  els.tbody.innerHTML = state.scheduled
    .map((c, i) => {
      const hasConflict = (c.conflictActors || []).length > 0;
      const rowCls = c.inCycle
        ? 'row-cycle'
        : c.blockedByCycle
          ? 'row-blocked'
          : c.overdue
            ? 'row-overdue'
            : hasConflict
              ? 'row-conflict'
              : '';

      const pres = c.prerequisites.length
        ? `<div class="pres">${c.prerequisites
            .map((pid) => {
              const exists = byId.has(pid);
              return `<span class="pre-tag ${exists ? '' : 'pre-missing'}" title="${
                exists ? '' : '前置提示点已删除'
              }">${CS.esc(CS.labelOf(byId, pid))}</span>`;
            })
            .join('')}</div>`
        : '<span class="hint">—</span>';

      const actors = (c.actors || []).length
        ? `<div class="actors">${c.actors
            .map((name) => {
              const hit = (c.conflictActors || []).includes(name);
              return `<span class="actor-tag ${hit ? 'actor-conflict' : ''}" title="${
                hit ? '该演员与其他提示点时间重叠' : ''
              }">${CS.esc(name)}</span>`;
            })
            .join('')}</div>`
        : '<span class="hint">—</span>';

      const slackCell = c.scheduled
        ? c.slack == null
          ? '—'
          : c.slack < 0
            ? `<span class="t-slack-neg">${CS.fmtDur(Math.abs(c.slack))} 超时</span>`
            : c.slack === 0
              ? `<span class="t-slack-zero">0:00</span>`
              : CS.fmtDur(c.slack)
        : '—';

      return `
      <tr class="${rowCls}">
        <td>${i + 1}</td>
        <td>
          <span class="cue-ref">${CS.esc(c.ref || `#${c.id}`)}</span>
          <span class="cue-name">${CS.esc(c.title)}</span>
        </td>
        <td class="num">${CS.fmtDur(c.duration)}</td>
        <td class="num t-time">${CS.fmtTime(c.minStart)}</td>
        <td>${pres}</td>
        <td>${actors}</td>
        <td class="num t-time">${c.scheduled ? CS.fmtTime(c.earliestStart) : '—'}</td>
        <td class="num t-time ${c.overdue ? 't-overdue' : ''}">${
          c.scheduled ? CS.fmtTime(c.earliestFinish) : '—'
        }</td>
        <td class="num t-time">${c.maxFinish == null ? '不限' : CS.fmtTime(c.maxFinish)}</td>
        <td class="num">${slackCell}</td>
        <td>${statusBadge(c)}</td>
        <td>
          <div class="row-ops">
            <button class="btn btn-sm" data-act="edit" data-id="${c.id}">编辑</button>
            <button class="btn btn-sm btn-danger-text" data-act="del" data-id="${c.id}">删除</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  els.tbody.querySelectorAll('button[data-act]').forEach((btn) => {
    const id = Number(btn.dataset.id);
    if (btn.dataset.act === 'edit') btn.addEventListener('click', () => openModal(id));
    if (btn.dataset.act === 'del') btn.addEventListener('click', () => onDelete(id));
  });
}

function statusBadge(c) {
  const badges = [];
  if (c.inCycle) badges.push('<span class="badge badge-cycle">⚠ 环依赖</span>');
  else if (c.blockedByCycle) badges.push('<span class="badge badge-blocked">环阻塞</span>');
  else if (c.overdue) badges.push('<span class="badge badge-overdue">⚠ 超过最晚完成</span>');

  if ((c.conflictActors || []).length) {
    badges.push(
      `<span class="badge badge-conflict" title="演员 ${CS.esc(
        c.conflictActors.join('、')
      )} 与其他提示点时间重叠">⚠ 演员冲突</span>`
    );
  }
  if (!badges.length) badges.push('<span class="badge badge-ok">正常</span>');
  return badges.join(' ');
}

/* ---------- 延误推演 ---------- */

/** 起点下拉框：仅列已成功排程的提示点（环上 / 被环阻塞者不可作为起点） */
function renderSimControls() {
  const options = state.scheduled.filter((c) => c.scheduled);
  const prev = els.simCue.value;
  if (!options.length) {
    els.simCue.innerHTML = '<option value="">暂无可推演的已排程提示点</option>';
    return;
  }
  els.simCue.innerHTML = options
    .map((c) => {
      const label = `${c.ref ? c.ref + ' · ' : ''}${c.title}`;
      return `<option value="${c.id}">${CS.esc(label)}（开始 ${CS.fmtTime(c.earliestStart)}）</option>`;
    })
    .join('');
  if (prev && options.some((c) => String(c.id) === prev)) els.simCue.value = prev;
}

async function onSimulate(e) {
  e.preventDefault();
  hideSimError();

  const cueId = Number(els.simCue.value);
  if (!cueId) return showSimError('请选择要推演的提示点');

  const delay = els.simDelay.value.trim();
  if (!delay) return showSimError('请填写延误量（纯数字按分钟，也支持 MM:SS、H:MM:SS）');
  if (/^-/.test(delay)) return showSimError('延误量不能为负');

  try {
    state.sim = await CS.api('/api/simulate-delay', {
      method: 'POST',
      body: JSON.stringify({ cueId, delay }),
    });
    renderSimResult();
  } catch (err) {
    state.sim = null;
    renderSimResult();
    showSimError(err.message);
  }
}

/** 清除推演：关闭推演视图，恢复查看正式排程 */
function clearSimulation() {
  state.sim = null;
  els.simDelay.value = '';
  hideSimError();
  render();
}

function showSimError(msg) {
  els.simError.textContent = msg;
  els.simError.classList.remove('hidden');
}

function hideSimError() {
  els.simError.classList.add('hidden');
  els.simError.textContent = '';
}

function renderSimResult() {
  const result = state.sim;
  if (!result) {
    els.simResult.classList.add('hidden');
    els.simResult.innerHTML = '';
    return;
  }

  const o = result.origin;
  const originLabel = `${o.ref ? CS.esc(o.ref) + ' ' : ''}「${CS.esc(o.title)}」`;
  const parts = [];

  parts.push(
    `<div class="banner banner-warn sim-summary">🔍 <strong>推演模式：</strong>${originLabel} ` +
      `计算开始 <code>${CS.fmtTime(o.originalStart)}</code> → <code>${CS.fmtTime(o.simulatedStart)}</code>` +
      `（延误 ${CS.fmtDur(result.delay)}），共影响 <strong>${result.changes.length}</strong> 个提示点；` +
      `新增超时 <strong>${result.newOverdue.length}</strong> 处，新增演员冲突 <strong>${result.newConflicts.length}</strong> 处。<br>` +
      `<span>模拟结果仅用于本次推演，未写入数据库，正式排程不受影响；点击“清除推演”关闭本视图。</span></div>`
  );

  /* 受影响提示点：原排程 vs 模拟排程 */
  parts.push('<h3>受影响提示点</h3>');
  if (!result.changes.length) {
    parts.push('<p class="sim-empty">排程无变化。</p>');
  } else {
    const rows = result.changes
      .map((ch) => {
        const isOrigin = ch.id === o.id;
        const label =
          (ch.ref ? `<span class="cue-ref">${CS.esc(ch.ref)}</span>` : '') +
          `<span class="cue-name">${CS.esc(ch.title)}</span>`;
        return `<tr class="${isOrigin ? 'sim-origin' : ''}">
          <td>${label}${isOrigin ? ' <span class="badge badge-conflict">起点</span>' : ''}</td>
          <td class="num t-time">${CS.fmtTime(ch.originalStart)}</td>
          <td class="num t-time">${CS.fmtTime(ch.originalFinish)}</td>
          <td class="num t-time sim-new">${CS.fmtTime(ch.simulatedStart)}</td>
          <td class="num t-time sim-new">${CS.fmtTime(ch.simulatedFinish)}</td>
          <td class="num sim-delta">+${CS.fmtDur(ch.delta)}</td>
        </tr>`;
      })
      .join('');
    parts.push(
      `<div class="table-wrap"><table class="cue-table sim-table"><thead><tr>` +
        `<th>提示点</th><th class="num">原开始</th><th class="num">原结束</th>` +
        `<th class="num">模拟开始</th><th class="num">模拟结束</th><th class="num">变化量</th>` +
        `</tr></thead><tbody>${rows}</tbody></table></div>`
    );
  }

  /* 新出现的超时 */
  parts.push('<h3>新出现的超时</h3>');
  if (!result.newOverdue.length) {
    parts.push('<p class="sim-empty">无新增超时。</p>');
  } else {
    const items = result.newOverdue
      .map((it) => {
        const label = `${it.ref ? CS.esc(it.ref) + ' ' : ''}「${CS.esc(it.title)}」`;
        return (
          `<li>⚠ ${label}：模拟结束 <code>${CS.fmtTime(it.simulatedFinish)}</code> 超过最晚完成 ` +
          `<code>${CS.fmtTime(it.maxFinish)}</code>（超时 ${CS.fmtDur(it.overdueBy)}）</li>`
        );
      })
      .join('');
    parts.push(`<ul class="sim-list sim-list-danger">${items}</ul>`);
  }

  /* 新出现的演员时间冲突 */
  parts.push('<h3>新出现的演员时间冲突</h3>');
  if (!result.newConflicts.length) {
    parts.push('<p class="sim-empty">无新增演员冲突。</p>');
  } else {
    const items = result.newConflicts
      .map((cf) => {
        const la = `${cf.cueA.ref ? CS.esc(cf.cueA.ref) + ' ' : ''}「${CS.esc(cf.cueA.title)}」`;
        const lb = `${cf.cueB.ref ? CS.esc(cf.cueB.ref) + ' ' : ''}「${CS.esc(cf.cueB.title)}」`;
        return (
          `<li>⚠ 演员 <strong>${CS.esc(cf.actor)}</strong>：${la} 与 ${lb} 在 ` +
          `<code>${CS.fmtTime(cf.overlapStart)} – ${CS.fmtTime(cf.overlapEnd)}</code> 重叠</li>`
        );
      })
      .join('');
    parts.push(`<ul class="sim-list sim-list-warn">${items}</ul>`);
  }

  parts.push('<p class="hint">已存在的超时与演员冲突仍以上方正式排程为准，不计入以上新增。</p>');

  els.simResult.innerHTML = parts.join('');
  els.simResult.classList.remove('hidden');
}

/* ---------- 弹窗 ---------- */

function openModal(id) {
  state.editingId = id || null;
  els.form.reset();
  els.formError.classList.add('hidden');
  els.modalTitle.textContent = id ? '编辑提示点' : '新增提示点';

  const cue = id ? state.cues.find((c) => c.id === id) : null;
  els.form.elements.id.value = id || '';
  if (cue) {
    els.form.elements.ref.value = cue.ref || '';
    els.form.elements.title.value = cue.title || '';
    els.form.elements.duration.value = CS.durationForInput(cue.duration);
    els.form.elements.minStart.value = cue.minStart ? CS.fmtTime(cue.minStart) : '';
    els.form.elements.maxFinish.value = cue.maxFinish == null ? '' : CS.fmtTime(cue.maxFinish);
    els.form.elements.actors.value = (cue.actors || []).join('、');
  }

  // 前置候选项不含自身
  const selected = new Set(cue ? cue.prerequisites : []);
  const candidates = state.cues.filter((c) => !id || c.id !== id);
  els.preList.innerHTML = candidates.length
    ? candidates
        .map((c) => {
          const label = `${c.ref ? c.ref + ' · ' : ''}${CS.esc(c.title)}`;
          return `<label class="pre-item">
            <input type="checkbox" name="prerequisites" value="${c.id}" ${
              selected.has(c.id) ? 'checked' : ''
            } /> ${label}</label>`;
        })
        .join('')
    : '<span class="pre-list-empty">暂无其他提示点，可先保存本项后再设置前置。</span>';

  els.mask.classList.remove('hidden');
  els.form.elements.title.focus();
}

function closeModal() {
  els.mask.classList.add('hidden');
  state.editingId = null;
}

async function onSubmit(e) {
  e.preventDefault();
  const f = els.form.elements;
  const payload = {
    ref: f.ref.value.trim(),
    title: f.title.value.trim(),
    duration: f.duration.value.trim(),
    minStart: f.minStart.value.trim(),
    maxFinish: f.maxFinish.value.trim(),
    actors: parseActorsInput(f.actors.value),
    prerequisites: Array.from(els.preList.querySelectorAll('input:checked')).map((i) =>
      Number(i.value)
    ),
  };

  try {
    if (state.editingId) {
      await CS.api(`/api/cues/${state.editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await CS.api('/api/cues', { method: 'POST', body: JSON.stringify(payload) });
    }
    closeModal();
    await refresh();
  } catch (err) {
    els.formError.textContent = err.message;
    els.formError.classList.remove('hidden');
  }
}

/** 演员输入框：逗号 / 顿号 / 分号 / 换行分隔，去空白去重 */
function parseActorsInput(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[,，、;；\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

async function onDelete(id) {
  const cue = state.cues.find((c) => c.id === id);
  const label = cue ? `${cue.ref ? cue.ref + ' ' : ''}「${cue.title}」` : `#${id}`;
  if (!confirm(`确定删除提示点 ${label} 吗？相关依赖关系会一并移除。`)) return;
  try {
    await CS.api(`/api/cues/${id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
}

refresh().catch((err) => {
  els.banner.textContent = '加载排程失败：' + err.message;
  els.banner.classList.remove('hidden');
});
