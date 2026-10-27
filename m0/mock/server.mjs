// 本地模拟环境：模拟 WeGame 助手页、官方周报页和它们用到的接口，用来自测两个书签。
// 数据全是编造的。只监听 127.0.0.1:8770。
// 用法：node m0/mock/server.mjs   然后打开 http://127.0.0.1:8770/helper/df/score/ 或 /cp/weekly/
// 页面地址可以带这些参数，测试各种「立刻停止」和兜底：
//   WeGame 页：?captcha=1 第一次拉战绩列表就要人机校验；?captcha=paging 只在翻页试验时要人机校验；
//              ?role8000102=1 QQ 类型查角色返回 8000102（书签应换微信类型再试一次）
//   周报页：  ?stall=2 第 2 个请求 Milo 不回调（模拟弹验证码 / 登录框）；?noOapI101=1 NoOapI 方法返回 101
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const PORT = Number(process.env.MOCK_PORT || 8770);

const SELF = '144115219000000001';
const MATE1 = '144115219000000002';
const MATE2 = '8007';               // 模拟「当局临时编号」
const pad = n => String(n).padStart(2, '0');
const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const now = Date.now();
const MATCHES = Array.from({ length: 40 }, (_, i) => {
  const t = fmt(new Date(now - (i + 1) * 40 * 60 * 1000));
  return {
    roomId: String(7300000000000000000n + BigInt(i * 7919)), startTime: t, dtEventTime: t,
    mapId: [2201, 3902, 8103, 1901, 80][i % 5], armedForceId: 30000 + (i % 6),
    gameResult: i % 3 === 0 ? 3 : 0, gainedPrice: String(100000 + i * 3333), collectionPrice: '0',
  };
});
const ok = extra => JSON.stringify(Object.assign({ result: { error_code: 0, error_message: 'success' } }, extra));

function battle(method, body, url) {
  switch (method) {
    case 'GetRoleInfo':
      if (url.searchParams.get('role8000102') === '1') {
        return body.account_type === 2
          ? ok({ role_info: { openid: SELF, area: 36, name: '测试玩家甲', level: 42 } })
          : JSON.stringify({ result: { error_code: 8000102, error_message: 'fetch role info failed' } });
      }
      return body.account_type === 1
        ? ok({ role_info: { openid: SELF, area: 36, name: '测试玩家甲', icon: 'https://example.invalid/icon.png', level: 42, tdmLevel: 7, totalPrice: '98766432', currentAsset: '12345678', noncurrentAsset: '200000' } })
        : ok({ role_info: {} });
    case 'GetBattleList': {
      const captcha = url.searchParams.get('captcha');
      if (captcha === '1' || (captcha === 'paging' && (Number(body.size) > 5 || body.after))) {
        return JSON.stringify({ result: { error_code: 8000022, error_message: 'need verify' } });
      }
      const size = Math.min(Number(body.size) || 5, 8);
      let rows = MATCHES;
      if (body.after) rows = rows.filter(r => r.dtEventTime < String(body.after));
      // has_next 是布尔标记：书签不能把它当游标，更不能把 true 加进自检名单（那样会把报告里所有 true 换坏）
      return ok({ sols: rows.slice(0, size), tdms: [], has_next: rows.length > size });
    }
    case 'GetBattleDetail':
      return ok({ battle_detail: {
        sol_players: [
          { vopenid: SELF, name: '测试玩家甲', teamId: 1, armedForceId: 30001, escapeResult: 0, carryOutPrice: 223344, carryOutItems: [{ objectID: 15080050001, num: 1, price: 1500000 }] },
          { vopenid: MATE1, name: '队友乙', teamId: 1, armedForceId: 30002, escapeResult: 3, carryOutPrice: 0, carryOutItems: [] },
          { vopenid: MATE2, name: '路人丙', teamId: 1, armedForceId: 30003, escapeResult: 0, carryOutPrice: 50000, carryOutItems: [] },
        ],
        tdm_players: [],
        // 用 openid 当键的字典：报告里只许出现键的形态，不许出现键本身
        kill_by_openid: { [SELF]: { kills: 3 }, [MATE1]: { kills: 1 } },
      } });
    case 'GetBattleReport':
      return ok({ season: { stats: { rankpoint: 1000, solEscaperatio: 55 }, sol: { level_score: 3200, total_fight: 120, total_escape: 66, escape_ratio: 55, total_gained_price: 99999999, low_kill_death_ratio: 120 } } });
    case 'GetMapStats':
      return ok({ maps: (body.mapids || []).map(m => ({ mapid: m, total: 10, win: 6, total_value: '1234567', total_item: '30', kill: 12, assist: 3, death: 4, score: 900, gametime: 7200 })) });
    case 'GetDailyStats':
      return ok({ daily_assets: Array(30).fill(1), daily_values: Array(30).fill(1), daily_hafcoins: Array(30).fill(1), rankpoints: Array(30).fill(1) });
    case 'GetCollectibles':
      return ok({ collectibles: [{ id: 28010010001 }, { id: 28010010002 }], opers: [{ id: 88000000001 }] });
    default:
      return JSON.stringify({ result: { error_code: 404, error_message: 'unknown method' } });
  }
}

const harness = (title, script, extraHead = '') => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>${extraHead}
<script>window.__DFP_TEST_ORIGIN_OK = true;</script></head>
<body style="font:14px system-ui;padding:20px"><h1>${title}（本地模拟）</h1>
<p>这是自测用的模拟页面，数据都是编造的。点下面的按钮等于点书签。</p>
<button id="run" onclick="var s=document.createElement('script');s.src='${script}?'+Date.now();document.body.appendChild(s)">运行书签</button>
</body></html>`;

const MILO_MOCK = `<script>
document.cookie = 'openid=mock; path=/'; document.cookie = 'acctype=qc; path=/';
window.getLastWeekDate = function () { return '20261025'; };
var Q = new URLSearchParams(location.search), N = 0;
window.Milo = { emit: function (flow) {
  var s = flow.sData, m = s.method, d = null;
  N += 1;
  if (Q.get('stall') === String(N)) return;   // 不回调：真实 Milo 弹验证码 / 登录框时就是这样
  // 照官方格式校验 sData：KfXJwH 是周报页 request() 的格式；NoOapI 是 H5 工具助手的格式（source 5、没有 sArea、param 里只有业务参数）
  var badFormat = flow.token === 'NoOapI'
    ? (s.source !== 5 || 'sArea' in s || /"(source|method)"/.test(s.param) || Object.keys(s).sort().join() !== 'method,param,source')
    : (s.source !== '5' || s.sArea !== 36 || JSON.parse(s.param).method !== m);
  if (badFormat) { setTimeout(function () { flow.fail({ iRet: 190001, sMsg: '参数错误' }); }, 80); return; }
  if (flow.token === 'NoOapI' && Q.get('noOapI101') === '1') { setTimeout(function () { flow.fail({ iRet: 101, sMsg: '请先登录' }); }, 80); return; }
  if (m === 'dfm/weekly.sol.record') d = { solDetail: { total_sol_num: '12', CarryOut_highprice_list: '15080050001,1,1500000#15080050002,1,900000' } };
  if (m === 'dfm/weekly.sol.highlights') d = { max_GainedPrice_Mapid: '2201', max_GainedPrice_dtEventTime: '2026-10-20 21:00:00' };
  if (m === 'dfm/weekly.sol.friend.record') d = { friends_sol_record: [
      { friend_openid: '${MATE1}', Friend_total_sol_num: '5', Friend_is_Escape1_num: '3', Friend_Sum_Gained_Price: '888888' },
      { friend_openid: '144115219000000099', Friend_total_sol_num: '1', Friend_is_Escape1_num: '0', Friend_Sum_Gained_Price: '0' } ],
      by_friend: { '${MATE1}': { n: 5 }, '144115219000000099': { n: 1 } } };
  if (m === 'dfm/center.person.resource') d = { solDetail: { totalFight: 120, totalEscape: 66, redCollectionDetail: [ { objectID: 15080050001, count: 2 }, { objectID: 15080050002, count: 0 } ] } };
  if (m === 'dfm/center.person.redcollection') d = { title: '测试称号', objectCount: 1, totalCount: 2, totalMoney: 3000000 };
  if (m === 'dfm/center.recent.detail') d = { solDetail: { recentGainDate: '2026-10-25', recentGain: 123456, userCollectionTop: { list: [ { objectID: 15080050001 } ] } } };
  setTimeout(function () {
    if (d) flow.success({ iRet: 0, sMsg: 'ok', details: { jData: { data: { code: 0, data: d } } } });
    else flow.fail({ iRet: 190001, sMsg: '参数错误' });
  }, 80);
} };
</script>`;

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (req.method === 'GET' && url.pathname === '/helper/df/score/') {
    res.setHeader('Set-Cookie', 'tgp_user_type=0; Path=/');
    return send(200, 'text/html; charset=utf-8', harness('WeGame 助手', '/bm/A.js'));
  }
  if (req.method === 'GET' && url.pathname === '/cp/weekly/') return send(200, 'text/html; charset=utf-8', harness('官方周报页', '/bm/B.js', MILO_MOCK));
  if (req.method === 'GET' && url.pathname.startsWith('/bm/')) {
    const id = url.pathname.endsWith('A.js') ? 'A' : 'B';
    // 自测时把 ?captcha=1 透传给接口
    let code = readFileSync(join(dist, `bookmarklet-${id}.js`), 'utf8');
    return send(200, 'text/javascript; charset=utf-8', code);
  }
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }
      const referer = req.headers.referer ? new URL(req.headers.referer) : url;
      if (url.pathname === '/api/rail/web/data_filter/game_config/query') {
        return send(200, 'application/json', ok({ items: [{ season_id: '0' }, { season_id: '9' }, { season_id: '10' }] }));
      }
      const m = url.pathname.match(/DfmBattle\/(\w+)$/);
      if (m) {
        if (req.headers['trpc-caller'] !== 'wegame.pallas.web.DfmBattle') return send(400, 'application/json', JSON.stringify({ result: { error_code: 400, error_message: 'missing trpc-caller' } }));
        return send(200, 'application/json', battle(m[1], body, referer));
      }
      return send(404, 'text/plain', 'not found');
    });
    return;
  }
  send(404, 'text/plain', 'not found');
}).listen(PORT, '127.0.0.1', () => console.log(`M0 模拟环境：http://127.0.0.1:${PORT}/helper/df/score/  和  /cp/weekly/`));
