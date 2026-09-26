'use strict';

/**
 * 排程核心：
 * - 以“秒”为最小单位计算时间
 * - earliestStart(cue) = max(用户录入的最早开始时间, 所有前置提示点的结束时间)
 * - earliestFinish = earliestStart + duration
 * - 环依赖：Tarjan SCC 找出环上全部提示点，Kahn 算法找出被环阻塞的提示点
 * - 超时：计算结果晚于最晚完成时间时标记
 * - 演员冲突：同一演员被分到时间重叠的提示点时标出（仅已成功排程者参与；
 *   结束恰好等于另一项开始不算冲突；环上及被阻塞项无有效时间，不参与检查）
 *
 * 输入 cues: [{ id, ref, title, duration, minStart, maxFinish, actors:[名字...], prerequisites:[id...] }]
 * 输出: { cues:[...计算结果], cycle:{nodes, path}|null, conflicts:[演员冲突...] }
 */

function schedule(inputCues) {
  const cues = new Map();
  for (const c of inputCues) {
    cues.set(c.id, {
      ...c,
      prerequisites: Array.from(new Set(c.prerequisites || [])),
    });
  }

  /** 后继表：前置 -> 依赖它的提示点 */
  const successors = new Map();
  for (const id of cues.keys()) successors.set(id, []);
  for (const c of cues.values()) {
    for (const preId of c.prerequisites) {
      if (cues.has(preId) && preId !== c.id) {
        successors.get(preId).push(c.id);
      }
    }
  }

  /* ---------- Tarjan 强连通分量：识别环上的节点 ---------- */
  const indexOf = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  let nextIndex = 0;
  const cyclic = new Set();
  const cyclicComponents = [];

  function strongConnect(v) {
    indexOf.set(v, nextIndex);
    lowlink.set(v, nextIndex);
    nextIndex++;
    stack.push(v);
    onStack.add(v);

    for (const w of successors.get(v)) {
      if (!indexOf.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indexOf.get(w)));
      }
    }

    if (lowlink.get(v) === indexOf.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      // 多个节点构成的 SCC 是环；单节点若有自环也是环
      if (component.length > 1) {
        component.forEach((id) => cyclic.add(id));
        cyclicComponents.push(component);
      } else if (cues.get(v).prerequisites.includes(v)) {
        cyclic.add(v);
        cyclicComponents.push(component);
      }
    }
  }

  for (const id of cues.keys()) {
    if (!indexOf.has(id)) strongConnect(id);
  }

  /* ---------- 为每个环找出一条具体路径，便于向用户指出 ---------- */
  const cyclePaths = [];
  if (cyclic.size > 0) {
    for (const component of cyclicComponents) {
      cyclePaths.push(findCyclePath(cues, new Set(component)));
    }
  }

  /* ---------- Kahn 拓扑 + 正向递推 ---------- */
  const indegree = new Map();
  for (const c of cues.values()) {
    indegree.set(c.id, c.prerequisites.filter((p) => cues.has(p)).length);
  }

  const start = new Map();
  const finish = new Map();
  const queue = [];
  for (const [id, deg] of indegree) {
    if (deg === 0) queue.push(id);
  }

  while (queue.length) {
    const id = queue.shift();
    const c = cues.get(id);
    let es = c.minStart;
    for (const preId of c.prerequisites) {
      if (finish.has(preId)) es = Math.max(es, finish.get(preId));
    }
    start.set(id, es);
    finish.set(id, es + c.duration);

    for (const succId of successors.get(id)) {
      indegree.set(succId, indegree.get(succId) - 1);
      if (indegree.get(succId) === 0) queue.push(succId);
    }
  }

  /* ---------- 被环阻塞的节点：依赖链可追溯到环上节点 ---------- */
  const blocked = new Set();
  if (cyclic.size > 0) {
    const visited = new Set();
    const work = [];
    for (const id of cyclic) {
      for (const s of successors.get(id)) {
        if (!cyclic.has(s)) work.push(s);
      }
    }
    while (work.length) {
      const id = work.pop();
      if (visited.has(id) || cyclic.has(id)) continue;
      visited.add(id);
      blocked.add(id);
      for (const s of successors.get(id)) {
        if (!visited.has(s) && !cyclic.has(s)) work.push(s);
      }
    }
  }

  /* ---------- 组装结果 ---------- */
  const results = [];
  for (const c of cues.values()) {
    const isCyclic = cyclic.has(c.id);
    const isBlocked = blocked.has(c.id);
    const scheduled = !isCyclic && !isBlocked;
    const es = scheduled ? start.get(c.id) : null;
    const ef = scheduled ? finish.get(c.id) : null;

    results.push({
      id: c.id,
      ref: c.ref,
      title: c.title,
      duration: c.duration,
      minStart: c.minStart,
      maxFinish: c.maxFinish,
      actors: Array.isArray(c.actors) ? c.actors : [],
      prerequisites: c.prerequisites.filter((p) => cues.has(p)),
      earliestStart: es,
      earliestFinish: ef,
      inCycle: isCyclic,
      blockedByCycle: isBlocked,
      scheduled,
      overdue: scheduled && c.maxFinish != null && ef > c.maxFinish,
      slack: scheduled && c.maxFinish != null ? c.maxFinish - ef : null,
      conflictActors: [],
    });
  }

  /* ---------- 演员时间冲突：仅已成功排程（有有效起止时间）的提示点参与 ---------- */
  const cuesByActor = new Map();
  for (const r of results) {
    if (!r.scheduled) continue;
    for (const actor of r.actors) {
      const list = cuesByActor.get(actor);
      if (list) list.push(r);
      else cuesByActor.set(actor, [r]);
    }
  }

  const conflicts = [];
  for (const [actor, list] of cuesByActor) {
    const sorted = list
      .slice()
      .sort((a, b) => a.earliestStart - b.earliestStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        // 按开始时间排序后，b 及之后的项开始时间都不早于 a 的结束，不会再与 a 重叠
        if (b.earliestStart >= a.earliestFinish) break;
        // 半开区间 [start, finish)：结束恰好等于另一项开始不算冲突
        const overlapStart = Math.max(a.earliestStart, b.earliestStart);
        const overlapEnd = Math.min(a.earliestFinish, b.earliestFinish);
        if (overlapStart >= overlapEnd) continue;
        conflicts.push({
          actor,
          cueA: conflictCueRef(a),
          cueB: conflictCueRef(b),
          overlapStart,
          overlapEnd,
        });
        if (!a.conflictActors.includes(actor)) a.conflictActors.push(actor);
        if (!b.conflictActors.includes(actor)) b.conflictActors.push(actor);
      }
    }
  }

  conflicts.sort(
    (x, y) => x.overlapStart - y.overlapStart || x.actor.localeCompare(y.actor, 'zh')
  );

  // 走台单排序：已排程按开始时间，再按编号/ID；不可排程（环/阻塞）排在后面
  results.sort((a, b) => {
    if (a.scheduled && b.scheduled) {
      if (a.earliestStart !== b.earliestStart) {
        return a.earliestStart - b.earliestStart;
      }
      return (a.ref || String(a.id)).localeCompare(b.ref || String(b.id), 'zh');
    }
    if (a.scheduled !== b.scheduled) return a.scheduled ? -1 : 1;
    if (a.inCycle !== b.inCycle) return a.inCycle ? -1 : 1;
    return (a.ref || String(a.id)).localeCompare(b.ref || String(b.id), 'zh');
  });

  const cycle =
    cyclic.size > 0
      ? {
          nodes: Array.from(cyclic),
          paths: cyclePaths,
          path: cyclePaths[0] || null,
        }
      : null;

  return { cues: results, cycle, conflicts };
}

/** 冲突条目里引用提示点时只保留展示所需的字段 */
function conflictCueRef(c) {
  return {
    id: c.id,
    ref: c.ref,
    title: c.title,
    earliestStart: c.earliestStart,
    earliestFinish: c.earliestFinish,
  };
}

/** 在给定强连通分量中用 DFS 找出一条回到已访问节点的路径 */
function findCyclePath(cues, component) {
  const nodes = Array.from(component);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map((n) => [n, WHITE]));
  const parent = new Map();
  let found = null;

  function dfs(u) {
    if (found) return;
    color.set(u, GRAY);
    for (const v of cues.get(u).prerequisites) {
      if (found) return;
      if (!component.has(v)) continue;
      if (color.get(v) === WHITE) {
        parent.set(v, u);
        dfs(v);
      } else if (color.get(v) === GRAY) {
        // 从 v 经 parent 链到 u，再回到 v，构成环
        const path = [v];
        let cur = u;
        while (cur !== v && cur != null) {
          path.push(cur);
          cur = parent.get(cur);
        }
        path.push(v);
        path.reverse();
        found = path;
        return;
      }
    }
    color.set(u, BLACK);
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE) dfs(n);
    if (found) return found;
  }
  return nodes;
}

module.exports = { schedule };
