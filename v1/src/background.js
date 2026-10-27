/* ============================================================================
 * SolLedger · 后台（MV3 service worker）
 *
 * 用户在扩展页面（弹窗 / 汇总页）里点「同步」时：找到或打开 WeGame 助手页面，把 pageSync 放进页面里跑，
 * 拿回某一天的对局和小队，把玩家 ID 换成带本机密钥的代号，存进扩展自己的 IndexedDB。
 * 扩展自己不发任何网络请求，不读 Cookie；只有扩展自己的页面能让它同步，网页不行。
 * ========================================================================== */
import { CONFIG } from './config.js';
import { pageSync } from './page-sync.js';
import { putAll, get, matchesOfDay, localKey, aliasOf, clearAll } from './db.js';

const running = new Map();   // day -> Promise
const STATUS_KEY = 'syncStatus';

/** 北京时间的「某一天」 */
export const dayOf = ms => new Date(ms + 8 * 36e5).toISOString().slice(0, 10);
const startMs = row => (/^\d{9,10}$/.test(String(row.startTime))
  ? Number(row.startTime) * 1000
  : Date.parse(String(row.startTime || row.dtEventTime).replace(' ', 'T') + '+08:00'));

// 后台被浏览器停掉后，残留的「正在同步」其实已经没人在跑了
chrome.storage.local.get(STATUS_KEY).then(s => {
  const st = s[STATUS_KEY];
  if (st && st.state === 'running') setStatus({ state: 'error', day: st.day, error: 'interrupted' });
});
async function setStatus(st) {
  await chrome.storage.local.set({ [STATUS_KEY]: Object.assign({ at: Date.now() }, st) });
}

function waitComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('官方页面 30 秒没加载完')); }, 30000);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') { done(); resolve(); } }, e => { done(); reject(e); });
  });
}

/** 找已经打开的 WeGame 助手页面；没有就在后台新开一个（同步完自动关掉） */
async function openTarget(query) {
  const target = CONFIG.target;
  if (!query) {
    // 被浏览器丢弃的标签页（节省内存、Edge 睡眠标签页）状态是 unloaded，不会自己加载完，用它只会白等 30 秒报「没加载完」
    const tab = (await chrome.tabs.query({ url: target.match })).find(t => !t.discarded && t.status !== 'unloaded' && !t.frozen);
    if (tab) { await waitComplete(tab.id); return { tabId: tab.id, opened: false }; }
  }
  const tab = await chrome.tabs.create({ url: target.url + (query || ''), active: false });
  await waitComplete(tab.id);
  return { tabId: tab.id, opened: true };
}

/** 一个玩家（列表行或小队成员）→ 存下来的样子：只留汇总要用的字段，ID 换成代号 */
const PLAYER_FIELDS = ['armedForceId', 'killCnt', 'killPlayer', 'assistCnt', 'rescue', 'gameResult', 'gameTime',
  'gainedPrice', 'collectionPrice', 'ProfitLoss', 'originalEquipmentPriceWithoutKeyChain', 'hasBlueBox', 'isLeave', 'teamId'];
// pageSync 跑在 MAIN world，官方页面的脚本能改写 fetch / JSON / 返回值：交回来的东西按不可信数据处理。
// 只收数字、布尔和短字符串；昵称、物品名去掉控制符和双向排版符；条数封顶（正常最多 60 页 × 8 条、60 局 × 3 人）。
const MAX_ROWS = 600, MAX_DETAILS = 80, MAX_SQUAD = 4;
const ROOM_RE = /^\d{6,24}$/;
const scalar = v => ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' ? v
  : typeof v === 'string' ? v.slice(0, 32) : undefined);
// 控制符、零宽字符、双向排版符一律写成 \u 转义：正则字面量里不能出现真的 U+2028（行终止符，会让整个后台脚本语法错误）
const text = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').slice(0, n);
function pick(p) {
  const o = {};
  if (!p || typeof p !== 'object') return o;
  for (const k of PLAYER_FIELDS) { const v = scalar(p[k]); if (v !== undefined) o[k] = v; }
  o.collections = Array.isArray(p.collections)
    ? p.collections.slice(0, 50).filter(c => c && typeof c === 'object')
      .map(c => ({ id: scalar(c.id), name: text(c.name, 40), grade: scalar(c.grade), num: scalar(c.num), price: scalar(c.price) }))
    : [];
  return o;
}

async function store(out) {
  const key = await localKey();
  out.stop = typeof out.stop === 'string' ? out.stop.slice(0, 20) : null;   // 也会原样进同步状态和数据库
  out.listStop = out.listStop === 'page_cap' || out.listStop === 'list_end' ? out.listStop : null;
  out.stopCode = typeof out.stopCode === 'number' && Number.isFinite(out.stopCode) ? out.stopCode : null;
  const selfId = out.self && out.self.id != null ? String(out.self.id) : '';
  // 每局记上「是哪个号同步的」（本人代号）：同一个浏览器换号同步时，汇总页只看当前这个号的，不混在一起
  const owner = selfId ? await aliasOf(selfId, key) : '';
  const rows = out.rows.slice(0, MAX_ROWS)
    .filter(r => r && typeof r === 'object' && ROOM_RE.test(String(r.roomId)) && Number.isFinite(startMs(r)) && dayOf(startMs(r)) === out.day);
  const matches = rows.map(r => Object.assign(pick(r), {
    roomId: String(r.roomId),
    owner,
    day: dayOf(startMs(r)),
    start: startMs(r),
    end: text(r.dtEventTime, 19),
    mapId: scalar(r.mapId), isRankMatch: scalar(r.isRankMatch), gameRule: scalar(r.gameRule),
  }));
  const details = [];
  const got = out.details && typeof out.details === 'object' && !Array.isArray(out.details) ? out.details : {};
  for (const [roomId, players] of Object.entries(got).slice(0, MAX_DETAILS)) {
    if (!ROOM_RE.test(roomId) || !Array.isArray(players)) continue;
    const list = [];
    for (const p of players.slice(0, MAX_SQUAD)) {
      if (!p || typeof p !== 'object') continue;
      const id = String(p.playerId || p.vopenid || '');
      list.push(Object.assign(pick(p), {
        alias: id ? await aliasOf(id, key) : '',
        isSelf: !!selfId && (String(p.playerId) === selfId || String(p.vopenid) === selfId),   // 官方用 vopenid 和登录 openid 比
        name: text(p.name, 40),
      }));
    }
    details.push({ roomId, players: list });
  }
  await putAll('matches', matches);
  await putAll('details', details);
  if (out.self) await putAll('meta', [{ key: 'self', name: text(out.self.name, 40), alias: owner }]);
  const n = out.names;
  if (n && typeof n === 'object' && Object.keys(n.armed || {}).length >= 5 && Object.keys(n.maps || {}).length >= 5) {
    const clean = obj => Object.fromEntries(Object.entries(obj).slice(0, 2000).filter(([k, v]) => /^\d{1,9}$/.test(k) && typeof v === 'string').map(([k, v]) => [k, text(v, 30)]));
    await putAll('meta', [{ key: 'names', armed: clean(n.armed), maps: clean(n.maps), at: Date.now() }]);
  }
  return { matches: matches.length, details: details.length };
}

async function syncDay(day, query) {
  // 只看格式会放过 2026-13-45：Date.parse 得 NaN，pageSync 里和 NaN 比较全为 false，会白翻满 60 页；
  // 2026-02-30 会被滚成 3 月 2 日；未来的日期也没必要发请求
  const t0 = Date.parse(day + 'T00:00:00+08:00');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(t0) || dayOf(t0) !== day || t0 > Date.now()) return { error: 'bad_day' };
  if (running.size) return { error: 'busy' };
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(); }, 20000);
  const job = (async () => {
    await setStatus({ state: 'running', day });
    let opened = null;
    try {
      const have = await matchesOfDay(day);
      // 小队名单是空的不算「查过」（以前的版本会把官方回的空名单存下来），下次接着查
      const haveDetails = (await Promise.all(have.map(m => get('details', m.roomId))))
        .filter(d => d && Array.isArray(d.players) && d.players.length).map(d => d.roomId);
      opened = await openTarget(CONFIG.dev ? query : '');
      const now = await chrome.tabs.get(opened.tabId);
      if (!now.url || !now.url.startsWith(CONFIG.target.match.slice(0, -1))) throw new Error('moved');
      const exec = chrome.scripting.executeScript({
        target: { tabId: opened.tabId }, world: 'MAIN', func: pageSync,
        // 新开的官方页自己也会先发一轮请求：等 3 秒再开始，别和它挤在一起。
        // 开发版（只给自动化测试用）把间隔调短、允许本地模拟页；正式版用默认间隔（列表 1.5 秒、详情 1 秒）
        args: [Object.assign({ day, knownDetailRoomIds: haveDetails, startDelayMs: opened.opened ? 3000 : 0 },
          CONFIG.dev ? { listGapMs: 300, gapMs: 200, startDelayMs: 0, mockOrigin: CONFIG.mockOrigin } : {})],
      });
      exec.catch(() => {});
      let timer;
      const [res] = await Promise.race([exec, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 270000); })])
        .finally(() => clearTimeout(timer));
      const out = res && res.result;
      // pageSync 出异常时也带着已经拿到的 rows / details 回来（stop = 'exception'），要照样存，不能整包丢；
      // 只有根本没跑起来（wrong_page / already_running，没有 rows）或交回的不是这一天时才算失败
      if (!out || typeof out !== 'object' || !Array.isArray(out.rows) || out.day !== day) {
        const error = (out && typeof out.error === 'string' && out.error.slice(0, 60)) || 'no_result';
        await setStatus({ state: 'error', day, error });
        return { error };
      }
      const saved = await store(out);
      const total = (await matchesOfDay(day)).length;
      await putAll('meta', [{ key: 'day:' + day, syncedAt: Date.now(), stop: out.stop || null, listStop: out.listStop, matches: total }]);
      await setStatus({ state: 'done', day, stop: out.stop || null, listStop: out.listStop, stopCode: out.stopCode || null, saved, total });
      return { ok: true, stop: out.stop || null, saved, total };
    } catch (e) {
      const msg = String(e && e.message || e);
      const error = msg === 'moved' || /Cannot access contents|must request permission/.test(msg) ? 'moved'
        : /was removed|No tab with id|tab was closed/i.test(msg) ? 'tab_closed'
        : msg === 'timeout' ? 'timeout' : msg.slice(0, 160);
      await setStatus({ state: 'error', day, error });
      return { error };
    } finally {
      clearInterval(keepAlive);
      running.delete(day);
      // 自己开的标签页用完就关；但用户已经切过去在看（是所在窗口的当前标签）就留着，免得把用户正在用的页面关掉
      if (opened && opened.opened) chrome.tabs.get(opened.tabId).then(t => (t.active ? null : chrome.tabs.remove(t.id))).catch(() => {});
    }
  })();
  running.set(day, job);
  return job;
}

/** 只认扩展自己的页面（弹窗、汇总页）：网页、别的扩展都不能让它同步 */
function fromOwnPage(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  return ['popup.html', 'dashboard.html'].some(p => sender.url.startsWith(chrome.runtime.getURL(p)));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!fromOwnPage(sender) || !msg || typeof msg.type !== 'string') return false;
  const reply = p => { p.then(sendResponse, e => sendResponse({ error: String(e && e.message || e) })); return true; };
  if (msg.type === 'sync-day') {
    const query = CONFIG.dev && typeof msg.query === 'string' && /^\?[\w=&]{0,60}$/.test(msg.query) ? msg.query : '';
    return reply(syncDay(String(msg.day || dayOf(Date.now())), query));
  }
  if (msg.type === 'clear') return reply(clearAll({ keepKey: true }).then(() => chrome.storage.local.remove(STATUS_KEY)).then(() => ({ ok: true })));
  return false;
});

chrome.action.onClicked && chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));
