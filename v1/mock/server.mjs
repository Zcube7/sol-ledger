// v1 的本地模拟环境：模拟 WeGame 助手页面和 GetRoleInfo / GetBattleList / GetBattleDetail。数据全是编造的，
// 按「从现在往前每 35 分钟一局、一共 70 局」生成（覆盖今天、昨天和前天的一部分），队友有固定的好友也有路人。
// 只监听 127.0.0.1:8771。用法：node v1/mock/server.mjs
// 页面地址可以带参数造异常：?captcha=detail3 第 3 次查单局详情时要人机校验；?expired=1 查角色返回 8025004（登录过期）；
//   ?drop=detail4 从第 4 次查单局详情起直接断开连接（模拟断网，页面里 fetch 会抛异常）
// /__truth?day=YYYY-MM-DD 返回这一天按人汇总的「标准答案」（直接从生成的数据里数，给自动化测试对答案用）
import { createServer } from 'node:http';
import { ARMED, MAPS, ESCAPE, DEAD } from './fixtures.mjs';

const PORT = Number(process.env.MOCK_PORT || 8771);
const SELF = { id: '144115219000000001', name: '测试玩家甲' };
const FRIENDS = [
  { id: '144115219000000011', name: '老王' },
  { id: '144115219000000012', name: '小李' },
  { id: '1441152190000000013', name: '阿强' },   // 19 位：真机里见过 19 位的玩家 ID
];
const stranger = i => ({ id: String(144115219000100000n + BigInt(i)), name: '路人' + i });
const pad = n => String(n).padStart(2, '0');
const bj = ms => { const d = new Date(ms + 8 * 36e5); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };

// 每局：谁在队里 + 每个人的数据（确定性生成，同一个进程里不变）
const NOW = Date.now();
const MATCHES = Array.from({ length: 70 }, (_, i) => {
  const start = NOW - (i + 1) * 35 * 60 * 1000;
  const gameTime = 900 + (i % 7) * 120;
  const squadKind = i % 5;   // 0: 两个路人；1、2: 老王+小李；3: 老王+路人；4: 阿强+路人
  const mates = squadKind === 0 ? [stranger(i * 2), stranger(i * 2 + 1)]
    : squadKind <= 2 ? [FRIENDS[0], FRIENDS[1]]
    : squadKind === 3 ? [FRIENDS[0], stranger(i * 2)]
    : [FRIENDS[2], stranger(i * 2)];
  const stat = (k, who) => ({
    armedForceId: ARMED[(i + k) % ARMED.length],
    killPlayer: (i * 3 + k * 5) % 4,
    killCnt: (i * 3 + k * 5) % 4 + (i + k) % 6,
    assistCnt: (i + k * 2) % 3,
    rescue: (i + k) % 4 === 0 ? 1 : 0,
    gameResult: (i + k) % 3 === 0 ? DEAD : ESCAPE,
    gainedPrice: String(50000 + ((i * 7919 + k * 104729) % 900000)),
    collectionPrice: '0',
    ProfitLoss: ((i * 31 + k * 17) % 9 - 3) * 50000,
    collections: (i + k) % 4 === 1 ? [{ grade: 6, id: 15080050001 + k, name: '编造红' + k, num: 1, pic: 'https://example.invalid/x.png', price: 1200000 }] : [],
    playerId: who.id, vopenid: who.id, name: who.name, icon: '10000000001',
  });
  const players = [stat(0, SELF), stat(1, mates[0]), stat(2, mates[1])];
  return {
    roomId: String(7300000000000000000n + BigInt(i * 7919)),
    start, startTime: String(Math.floor(start / 1000)), dtEventTime: bj(start + gameTime * 1000),
    mapId: i % 13 === 7 ? 80 : MAPS[i % MAPS.length], gameTime, players,   // 混进几局 mapId 80：官方不算，扩展也不该算
  };
});
const row = m => Object.assign({}, m.players[0], {
  roomId: m.roomId, startTime: m.startTime, dtEventTime: m.dtEventTime, mapId: m.mapId, gameTime: m.gameTime,
  name: '', icon: '', teamId: 1, isRankMatch: 0, gameRule: 0, iZoneAreaId: 36, isLeave: 0, hasBlueBox: 0,
});

/** 标准答案：这一天每个和我同队过的人（按 ID），同队局数和各项合计 */
function truth(day) {
  const inDay = MATCHES.filter(m => bj(m.start).slice(0, 10) === day && m.mapId !== 80);
  const people = {};
  for (const m of inDay) for (const p of m.players.slice(1)) {
    const e = people[p.playerId] || (people[p.playerId] = { name: p.name, together: 0, killPlayer: 0, killCnt: 0, assistCnt: 0, rescue: 0, escaped: 0 });
    e.together += 1; e.killPlayer += p.killPlayer; e.killCnt += p.killCnt; e.assistCnt += p.assistCnt; e.rescue += p.rescue;
    if (p.gameResult === ESCAPE) e.escaped += 1;
  }
  const self = { matches: inDay.length, killPlayer: 0, rescue: 0 };
  for (const m of inDay) { self.killPlayer += m.players[0].killPlayer; self.rescue += m.players[0].rescue; }
  return { day, matches: inDay.length, self, people: Object.values(people) };
}

const ok = extra => JSON.stringify(Object.assign({ result: { error_code: 0, error_message: 'success' } }, extra));
const fail = (code, msg) => JSON.stringify({ result: { error_code: code, error_message: msg } });
let detailCalls = 0;

function api(method, body, page) {
  if (method === 'GetRoleInfo') {
    if (page.searchParams.get('expired') === '1') return fail(8025004, '登录信息过期');
    return body.account_type === 1 ? ok({ role_info: { openid: SELF.id, name: SELF.name, level: 30, area: 36 } }) : ok({ role_info: {} });
  }
  if (body.openid !== SELF.id) return fail(1001, 'bad openid');
  if (method === 'GetBattleList') {
    let rows = MATCHES;
    if (body.after) rows = rows.filter(m => m.dtEventTime < String(body.after));
    return ok({ sols: rows.slice(0, 8).map(row), tdms: [], bricks: [], openid: SELF.id });
  }
  if (method === 'GetBattleDetail') {
    detailCalls += 1;
    const drop = page.searchParams.get('drop');
    if (drop && drop.startsWith('detail') && detailCalls >= Number(drop.slice(6))) return null;   // null = 断开连接
    const cap = page.searchParams.get('captcha');
    if (cap && cap.startsWith('detail') && detailCalls === Number(cap.slice(6))) return fail(8000022, 'need verify');
    const m = MATCHES.find(x => x.roomId === String(body.roomId));
    if (!m || String(body.start_time) !== m.startTime) return fail(1002, 'not found');
    return ok({ battle_detail: { sol_players: m.players, tdm_players: [], brick_players: [] } });
  }
  return fail(404, 'unknown method');
}

const HARNESS = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>WeGame 助手（本地模拟）</title>
<script>window.__DFP_TEST_ORIGIN_OK = true; document.cookie = 'tgp_user_type=0; path=/';</script></head>
<body style="font:14px system-ui;padding:20px"><h1>WeGame 助手（本地模拟）</h1><p>自测用的模拟页面，数据都是编造的。</p></body></html>`;

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.method === 'GET' && url.pathname === '/helper/df/score/') { detailCalls = 0; return send(200, 'text/html; charset=utf-8', HARNESS); }
  if (req.method === 'GET' && url.pathname === '/__truth') return send(200, 'application/json', JSON.stringify(truth(url.searchParams.get('day'))));
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
      const m = url.pathname.match(/DfmBattle\/(\w+)$/);
      if (!m) return send(404, 'text/plain', 'not found');
      if (req.headers['trpc-caller'] !== 'wegame.pallas.web.DfmBattle') return send(400, 'application/json', fail(400, 'missing trpc-caller'));
      const page = req.headers.referer ? new URL(req.headers.referer) : url;
      const result = api(m[1], body, page);
      if (result === null) return req.socket.destroy();
      send(200, 'application/json', result);
    });
    return;
  }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`v1 模拟环境：http://127.0.0.1:${PORT}/helper/df/score/`));
