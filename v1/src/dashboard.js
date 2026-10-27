// 汇总页：选日期 → 同步 → 列出当天一起玩的人和每人的数据合计。所有渲染都用 textContent，不拼 HTML。
import { CONFIG } from './config.js';
import { matchesOfDay, getMany, get } from './db.js';
import { summarizeDay, topCounts } from './aggregate.js';
import { armedForceName, mapName, gameResultText, setNameOverrides, LABELS } from './labels.js';

const $ = id => document.getElementById(id);
const dayOf = ms => new Date(ms + 8 * 36e5).toISOString().slice(0, 10);
const hm = ms => new Date(ms + 8 * 36e5).toISOString().slice(11, 16);
const shift = (day, n) => dayOf(Date.parse(day + 'T12:00:00+08:00') + n * 864e5);

const STOP_TEXT = {
  captcha: '官方要求人机校验，已停止（已经拿到的数据保留了）：打开 WeGame 助手页面按 F5，完成验证码后再同步一次',
  not_login: '官方说未登录或登录已过期：到 www.wegame.com.cn 右上角退出后用 QQ 重新登录，再同步',
  no_role: '没取到角色信息：确认登录的是玩三角洲的那个号',
  page_cap: '这一天离现在太远，翻了 30 页战绩还没翻到，只拿到了一部分',
  detail_cap: '这一天对局多，这次先查了 30 局的小队（怕请求太密），再点一次同步会接着查剩下的',
  api_error: '官方接口返回了错误，已停止（已经拿到的数据保留了）',
  exception: '取数时出错（比如断网），已停止，已经拿到的数据保留了：再点一次同步会接着查',
  list_end: '官方战绩已经翻到底，还没翻到这一天的 0 点：官方只给最近一段时间的战绩（也可能是更早你就没有对局了），这一天更早的对局拿不到，下面的数据可能不全',
  time_cap: '这次同步跑了 4 分钟还没跑完，先把拿到的存下了：再点一次「同步这一天」会接着查',
};
const ERROR_TEXT = {
  busy: '上一次同步还没结束，等它跑完再点',
  interrupted: '上次同步没跑完就中断了（浏览器或扩展被重启过），再点一次就行',
  moved: 'WeGame 助手页面跳到了别的地址（多半是登录页）：先在 www.wegame.com.cn 登录，再同步',
  tab_closed: '同步过程中 WeGame 助手页面被关掉或刷新了：再点一次，跑完之前别动那个页面',
  timeout: '同步 4 分半钟还没完，已放弃：刷新 WeGame 助手页面后再试',
  already_running: 'WeGame 助手页面里上一次同步还在跑，等它结束再点',
  wrong_page: '没在 WeGame 助手页面上运行',
  bad_day: '日期不对（只能选今天或以前的日期）',
  no_result: '官方页面没交回结果：再点一次',
};

const wan = v => (Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(Math.abs(v) >= 1e6 ? 0 : 1) + ' 万' : String(Math.round(v)));
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
function table(headers, rows, rowClass) {
  const t = el('table');
  const tr = el('tr');
  headers.forEach(h => tr.appendChild(el('th', h.text, h.cls)));
  t.appendChild(el('thead')).appendChild(tr);
  const tb = t.appendChild(el('tbody'));
  rows.forEach((r, i) => {
    const row = el('tr');
    if (rowClass) row.className = rowClass(i) || '';
    r.forEach((c, j) => row.appendChild(el('td', c, headers[j].cls)));
    tb.appendChild(row);
  });
  return t;
}
function setStatus(text, cls = '') { $('status').textContent = text; $('status').className = cls; }

async function render() {
  setNameOverrides(await get('meta', 'names'));   // 同步时从官方配置读到的最新干员、地图名
  const day = $('day').value;
  $('day').max = dayOf(Date.now());   // 页面跨过零点一直开着时，日期框也能选到新的一天
  const self = await get('meta', 'self');
  // 只看当前这个号（最近一次同步的号）的对局：同一个浏览器换号同步时不混在一起
  const matches = (await matchesOfDay(day)).filter(m => !m.owner || !self || !self.alias || m.owner === self.alias);
  const details = {};
  (await getMany('details', matches.map(m => m.roomId))).forEach(d => { if (d) details[d.roomId] = d; });
  const minTogether = $('friendsOnly').checked ? 2 : 1;
  const s = summarizeDay(matches, details, { minTogether });
  const meta = await get('meta', 'day:' + day);

  $('summary').textContent = '';
  $('matches').textContent = '';
  $('sumNote').textContent = matches.length
    ? `${s.matchCount} 局，已查小队 ${s.withDetail} 局${meta ? '，上次同步 ' + new Date(meta.syncedAt).toLocaleString() : ''}`
    : '';
  if (!matches.length) {
    $('summary').appendChild(el('div', !meta ? '这一天还没同步过：点上面的「同步这一天」。'
      : meta.stop === 'list_end' ? '官方战绩翻到底也没翻到这一天：太早的对局官方不再提供，这一天拿不到数据（不代表这天没玩）。'
      : meta.stop ? '上次同步这一天时中途停了，没拿到对局：' + (STOP_TEXT[meta.stop] || meta.stop)
      : '这一天没有烽火地带对局。', 'empty'));
    return;
  }

  const H = [
    { text: '昵称', cls: 'l' }, { text: LABELS.matches }, { text: LABELS.escaped }, { text: LABELS.killPlayer }, { text: LABELS.killCnt },
    { text: LABELS.assistCnt }, { text: LABELS.rescue }, { text: LABELS.gainedPrice }, { text: LABELS.ProfitLoss },
    { text: LABELS.collections }, { text: '用过的干员（局数）', cls: 'l' },
  ];
  const line = p => [
    p.isSelf ? '我（全天合计）' : (p.name || '(无昵称)'),
    String(p.totals.matches), `${p.totals.escaped}/${p.totals.matches}`,
    String(p.totals.killPlayer), String(p.totals.killCnt), String(p.totals.assistCnt), String(p.totals.rescue),
    wan(p.totals.gainedPrice), wan(p.totals.ProfitLoss),
    p.totals.collectionsNum ? `${p.totals.collectionsNum} 件 / ${wan(p.totals.collectionsPrice)}` : '0',
    topCounts(p.totals.armedForces, 5).map(x => `${armedForceName(x.id)}×${x.n}`).join('、'),
  ];
  const people = [s.self, ...s.friends];
  $('summary').appendChild(table(H, people.map(line), i => (i === 0 ? 'self' : '')));
  if (!s.friends.length) $('summary').appendChild(el('div', minTogether > 1 ? '这一天没有和谁同队 2 局以上（可能是单排或都跟路人）。取消上面的勾选可以看所有同队过的人。' : '这一天没有同队过的人（都是单排）。', 'empty'));
  if (s.others.length && minTogether > 1) {
    $('summary').appendChild(el('div', `另外还有 ${s.others.length} 个只同队 1 局的人（多半是路人）：${s.others.map(p => p.name || '(无昵称)').join('、')}`, 'dim small'));
  }
  if (s.selfMissing) {
    $('summary').appendChild(el('div', `有 ${s.selfMissing} 局的小队名单里认不出你自己（可能是微信号的 ID 口径不一样），这几局的队友没算进去。把这条提示告诉开发者。`, 'dim small'));
  }
  if (s.withDetail + s.selfMissing < s.matchCount) {
    $('summary').appendChild(el('div', `还有 ${s.matchCount - s.withDetail - s.selfMissing} 局没查到小队，队友的数据不全：再点一次「同步这一天」会接着查。`, 'dim small'));
  }

  const MH = [
    { text: '开局', cls: 'l' }, { text: '地图', cls: 'l' }, { text: '我的干员', cls: 'l' }, { text: LABELS.gameResult, cls: 'l' },
    { text: LABELS.killPlayer }, { text: LABELS.killCnt }, { text: LABELS.rescue }, { text: LABELS.gainedPrice }, { text: '队友（干员 · 击杀干员 · 救助 · 带出价值）', cls: 'l mates' },
  ];
  const gained = p => Number(p.gainedPrice) || Number(p.collectionPrice) || 0;   // 官方口径：gainedPrice 为 0 / 空时退回 collectionPrice
  const mrows = s.perMatch.slice().reverse().map(m => [
    hm(m.start), mapName(m.mapId), armedForceName(m.self.armedForceId), gameResultText(m.self.gameResult),
    String(m.self.killPlayer ?? ''), String(m.self.killCnt ?? ''), String(m.self.rescue ?? ''), wan(gained(m.self)),
    !m.hasDetail ? '（还没查小队）' : (m.mates.length
      ? m.mates.map(p => `${p.name || '(无昵称)'}：${armedForceName(p.armedForceId)} · ${p.killPlayer ?? 0} · ${p.rescue ?? 0} · ${wan(gained(p))}`).join('；')
      : '（单排）'),
  ]);
  $('matches').appendChild(table(MH, mrows));
}

async function showSyncStatus() {
  const st = (await chrome.storage.local.get('syncStatus')).syncStatus;
  const busy = !!(st && st.state === 'running' && Date.now() - st.at < 300000);
  $('sync').disabled = busy;
  // 后台被浏览器停掉时这个「正在同步」不会再变：到点自己再看一次，把按钮放开，不用用户刷新页面
  if (busy) setTimeout(showSyncStatus, 300000 - (Date.now() - st.at) + 1000);
  if (!st) return;
  if (st.state === 'running' && !busy) setStatus(`同步 ${st.day} 超过 5 分钟没有结果，多半中断了：再点一次「同步这一天」。`, 'err');
  else if (st.state === 'running') setStatus(`正在同步 ${st.day}……扩展在后台的 WeGame 助手页面里查数据，每次请求间隔 1~1.5 秒。`, 'warn');
  else if (st.state === 'error') setStatus(`同步 ${st.day} 出错：${ERROR_TEXT[st.error] || st.error}`, 'err');
  else if (st.state === 'done') {
    const base = `已同步 ${st.day}：这一天共 ${st.total} 局。`;
    const extra = st.listStop ? ' 另外：' + (STOP_TEXT[st.listStop] || st.listStop) : '';
    setStatus(st.stop ? base + (STOP_TEXT[st.stop] || st.stop) + (st.stopCode ? `（错误码 ${st.stopCode}）` : '') + extra : base, st.stop ? 'warn' : 'ok');
  }
}

$('day').value = dayOf(Date.now());
$('day').max = dayOf(Date.now());
$('day').addEventListener('change', render);
const current = () => ($('day').value || dayOf(Date.now()));   // 日期框被清空时按今天算，免得 Invalid Date
$('prev').addEventListener('click', () => { $('day').value = shift(current(), -1); render(); });
$('next').addEventListener('click', () => { const d = shift(current(), 1); if (d <= dayOf(Date.now())) { $('day').value = d; render(); } });
$('friendsOnly').addEventListener('change', render);
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: 'sync-day', day: $('day').value, query: window.__SOL_TEST_QUERY || '' }).catch(e => ({ error: String(e) }));
  if (r && r.error === 'busy') setStatus(ERROR_TEXT.busy, 'warn');
  await showSyncStatus();
  await render();
});
$('clear').addEventListener('click', async () => {
  if (!confirm('清空这个浏览器里保存的所有战绩？（官方数据不受影响，以后可以重新同步）')) return;
  await chrome.runtime.sendMessage({ type: 'clear' });
  setStatus('已清空。', 'ok');
  render();
});
chrome.storage.onChanged.addListener(changes => { if (changes.syncStatus) { showSyncStatus(); render(); } });
if (CONFIG.dev) document.title += '（开发版）';
showSyncStatus();
render();
