// 汇总：某一天里，「我」和每个同队过的人的数据加总。只做加总，不做分析。
// 纯函数，不碰浏览器 API，方便在 node 里单测。
import { isEscaped } from './labels.js';

const num = v => (v === undefined || v === null || v === '' || isNaN(Number(v)) ? 0 : Number(v));

function emptyTotals() {
  return {
    matches: 0, escaped: 0,
    killCnt: 0, killPlayer: 0, assistCnt: 0, rescue: 0,
    gainedPrice: 0, ProfitLoss: 0, gameTime: 0,
    collectionsNum: 0, collectionsPrice: 0,
    armedForces: {},   // armedForceId -> 局数
    maps: {},          // mapId -> 局数
  };
}

function add(t, p, mapId) {
  t.matches += 1;
  if (isEscaped(p.gameResult)) t.escaped += 1;
  for (const k of ['killCnt', 'killPlayer', 'assistCnt', 'rescue', 'ProfitLoss', 'gameTime']) t[k] += num(p[k]);
  t.gainedPrice += num(p.gainedPrice) || num(p.collectionPrice);   // 官方口径：Number(gainedPrice) || Number(collectionPrice)
  for (const c of p.collections || []) { t.collectionsNum += num(c.num) || 1; t.collectionsPrice += num(c.price) * (num(c.num) || 1); }
  if (p.armedForceId !== undefined) t.armedForces[p.armedForceId] = (t.armedForces[p.armedForceId] || 0) + 1;
  if (mapId !== undefined) t.maps[mapId] = (t.maps[mapId] || 0) + 1;
}

/**
 * @param matches  这一天的对局（自己那一行，来自战绩列表），每条有 roomId、start、mapId 和自己的数据
 * @param details  { roomId: { players: [{ alias, isSelf, name, ...数据 }] } }，小队 3 人；可能有的局还没查到
 * @param opts.minTogether  同队至少几局才算「一起玩的好友」（默认 2；1 = 显示所有同队过的人）
 */
export function summarizeDay(matches, details, opts = {}) {
  const minTogether = opts.minTogether || 2;
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const self = { alias: 'self', name: '我', isSelf: true, totals: emptyTotals(), times: [] };
  const people = new Map();
  const perMatch = [];
  let withDetail = 0;
  let selfMissing = 0;

  for (const m of sorted) {
    add(self.totals, m, m.mapId);
    self.times.push(m.start);
    const raw = details[m.roomId];
    const d = raw && Array.isArray(raw.players) && raw.players.length ? raw : null;   // 空名单（旧版存下的）当没查到，不显示成单排
    // 小队里认不出自己（比如微信号的 ID 口径和 QQ 号不一样）：这一局的队友不算，免得把自己算成「好友」；汇总页会提醒
    const selfFound = !!d && d.players.some(p => p.isSelf);
    if (d && !selfFound) selfMissing += 1;
    const mates = d && selfFound ? d.players.filter(p => !p.isSelf) : null;
    if (d && selfFound) withDetail += 1;
    for (const p of mates || []) {
      const key = p.alias || ('noid:' + p.name);
      const e = people.get(key) || { alias: key, name: p.name, isSelf: false, totals: emptyTotals(), times: [] };
      if (p.name) e.name = p.name;   // 昵称可能改过，用当天最后一次见到的
      add(e.totals, p, m.mapId);
      e.times.push(m.start);
      people.set(key, e);
    }
    perMatch.push({ roomId: m.roomId, start: m.start, mapId: m.mapId, self: m, mates, hasDetail: !!d && selfFound, selfMissing: !!d && !selfFound });
  }

  const all = [...people.values()].sort((a, b) => b.totals.matches - a.totals.matches || a.name.localeCompare(b.name));
  return {
    matchCount: sorted.length,
    withDetail,
    selfMissing,
    self,
    friends: all.filter(p => p.totals.matches >= minTogether),
    others: all.filter(p => p.totals.matches < minTogether),
    perMatch,
  };
}

/** 干员用得最多的几个：[{ id, n }]，按局数降序 */
export function topCounts(obj, limit = 3) {
  return Object.entries(obj).map(([id, n]) => ({ id: Number(id), n })).sort((a, b) => b.n - a.n || a.id - b.id).slice(0, limit);
}
