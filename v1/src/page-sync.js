/* ============================================================================
 * 取数函数：由扩展后台用 chrome.scripting.executeScript({ func: pageSync, args: [params], world: 'MAIN' })
 * 放进玩家已登录的 WeGame 助手页面里跑。函数会被序列化后注入，所以必须自包含：不能引用外面的变量。
 *
 * 做的事：查出某一天（北京时间、按开局时间）的烽火地带对局，再逐局查小队（单局详情只有本小队 3 人）。
 * 原则：只读；同源请求，Origin / Referer 由浏览器给；只读 tgp_user_type 这一个 Cookie 标记位，不读任何凭据；
 *       请求之间有间隔；碰到人机校验 / 未登录 / 登录过期立刻停，不重试，把已经拿到的交回去。
 * 返回原始数据（含玩家 ID），由扩展后台立刻换成带本机密钥的代号再存，原始 ID 不落盘。
 * 干员、地图名称：和官方页面一样读腾讯公开的静态配置（不带 Cookie）；读不到不影响同步。
 * 口径照官方页面：mapId === 80 的对局不算（官方前端直接丢掉）。
 * ========================================================================== */
export async function pageSync(params) {
  // 上限先放保守些（真机还没验证过大批量请求的风控）：一次最多翻 30 页战绩（240 局）、查 30 局小队；没查完的再点一次接着查
  const { day, knownDetailRoomIds = [], maxPages = 30, maxDetails = 30, listGapMs = 1500, gapMs = 1000, startDelayMs = 0, mockOrigin = null } = params || {};
  const OFFICIAL = 'https://www.wegame.com.cn';
  // 本地模拟环境只在开发版里由后台传 mockOrigin 进来；正式版只认官方页面
  const isMock = !!mockOrigin && location.origin === mockOrigin && window.__DFP_TEST_ORIGIN_OK === true;
  // host_permissions 里的路径 Chrome 不认（实测 getAll() 报的是整个源），后台检查完 URL 到注入之间页面还可能跳走：这里再按路径把一次关
  if ((location.origin !== OFFICIAL || !location.pathname.startsWith('/helper/df/score/')) && !isMock) return { error: 'wrong_page' };
  if (window.__SOL_SYNCING) return { error: 'already_running' };
  window.__SOL_SYNCING = true;

  const API = '/api/v1/wegame.pallas.dfm.DfmBattle/';
  const CAPTCHA = 8000022;
  const NOT_LOGIN = [8000102, 8000103, 1001001, 1001002, 8025004];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const dayStart = Date.parse(day + 'T00:00:00+08:00');
  const dayEnd = dayStart + 864e5;
  const out = { day, rows: [], details: {}, pages: 0, stop: null, stopCode: null, self: null, names: null };
  let calls = 0;
  // 自己定死线：后台等 270 秒就放弃，页面里不能还接着发请求（复用用户自己的标签页时后台不会关它）；到点停下，已拿到的照常交回
  const deadline = Date.now() + ((params && params.budgetMs) || 240000);

  async function call(method, body, gap) {
    if (calls++) await sleep(gap);
    if (Date.now() + 15000 > deadline) { out.stop = 'time_cap'; out.stopCode = null; return null; }
    const r = await fetch(API + method, {
      signal: AbortSignal.timeout(15000),   // 单个请求最多等 15 秒，卡住就当出错停下
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'trpc-caller': 'wegame.pallas.web.DfmBattle' },
      body: JSON.stringify(Object.assign({ from_src: 'df_web' }, body)),
    });
    const j = await r.json().catch(() => null);
    const code = j && j.result ? j.result.error_code : null;
    if (code === 0) return j;
    const msg = String((j && j.result && j.result.error_message) || '');
    out.stopCode = code;
    out.stop = code === CAPTCHA ? 'captcha' : (NOT_LOGIN.includes(code) || /登录/.test(msg)) ? 'not_login' : 'api_error';
    return null;
  }
  // 开局时间：真实接口是 10 位秒级时间戳串；兜底按「YYYY-MM-DD HH:mm:ss」北京时间解析
  const startMs = row => (/^\d{9,10}$/.test(String(row.startTime))
    ? Number(row.startTime) * 1000
    : Date.parse(String(row.startTime || row.dtEventTime).replace(' ', 'T') + '+08:00'));

  // 官方页面显示干员、地图名用的公开配置（jsonschema.qpic.cn，ACAO *，不需要登录）；不带 Cookie
  async function fetchNames() {
    const CDN = 'https://jsonschema.qpic.cn/f17859b917badfa9a083ad92c9eca90b/';
    const getJson = async path => {
      // 公开 CDN 卡住时最多等 8 秒，不拖住后面的取数（sleep 到点返回 undefined，按读不到处理）
      try { const r = await Promise.race([fetch(CDN + path, { credentials: 'omit' }), sleep(8000)]); return r && r.ok ? await Promise.race([r.json(), sleep(8000)]) : null; } catch (e) { return null; }
    };
    const [agents, maps] = await Promise.all([getJson('b965f0631cd937fde49b54fe0b709276/agentInfo'), getJson('558596903da9c0e12df38eee20dcfc36/map')]);
    const armed = {}, mapNames = {};
    for (const a of (agents && Array.isArray(agents.data) ? agents.data : [])) if (a && a.id != null && typeof a.name === 'string') armed[Number(a.id)] = a.name.slice(0, 20);
    for (const m of (maps && Array.isArray(maps.mapDetail) ? maps.mapDetail : [])) if (m && m.id != null && typeof m.name === 'string') mapNames[Number(m.id)] = m.name.slice(0, 30);
    return { armed, maps: mapNames };
  }

  try {
    if (startDelayMs) await sleep(startDelayMs);   // 新开的官方页自己也在发请求，等它一会儿
    if (!isMock) out.names = await fetchNames();   // 本地模拟环境里不去碰真实 CDN

    // 1. 自己是谁：QQ / 微信只看 tgp_user_type 这个标记位（官方：1 = 微信）
    const flag = (document.cookie.split('; ').find(c => c.startsWith('tgp_user_type=')) || '').split('=')[1];
    const first = flag === '1' ? 2 : 1;
    let role = null, accountType = first;
    for (const t of [first, first === 1 ? 2 : 1]) {
      const j = await call('GetRoleInfo', { account_type: t, area: 36 }, gapMs);
      if (j && j.role_info && j.role_info.openid) { role = j.role_info; accountType = t; break; }
      if (out.stop && !(out.stopCode === 8000102 && t === first)) break;   // 8000102 官方当「查不到角色」：换另一种账号类型再试一次
      out.stop = null; out.stopCode = null;
    }
    if (!role) { out.stop = out.stop || 'no_role'; return out; }
    out.self = { id: String(role.openid), name: role.name || '' };
    // 官方查战绩、查单局用的是角色信息里的 area（只有查角色时固定 36）
    const base = { openid: String(role.openid), area: role.area !== undefined ? role.area : 36, account_type: accountType, queue: 'sol', filters: [] };

    // 2. 从最新往前翻战绩列表（服务端固定一页 8 条），翻过这一天的 0 点就停
    let after = null;
    for (let page = 1; page <= maxPages; page++) {
      const j = await call('GetBattleList', Object.assign({ size: 8, after }, base), listGapMs);
      if (!j) break;
      out.pages = page;
      const rows = j.sols || [];
      if (!rows.length) { out.stop = 'list_end'; break; }   // 翻到底了还没翻过这一天的 0 点：官方战绩只能往前翻这么深，这一天（更早的部分）拿不到
      for (const r of rows) { const t = startMs(r); if (t >= dayStart && t < dayEnd && r.mapId !== 80) out.rows.push(r); }
      if (startMs(rows[rows.length - 1]) < dayStart) break;
      const next = rows[rows.length - 1].dtEventTime;
      if (!next || next === after) break;
      after = next;
      if (page === maxPages) out.stop = 'page_cap';
    }

    // 3. 逐局查小队；已经查过的不再查
    const known = new Set(knownDetailRoomIds.map(String));
    const todo = out.rows.filter(r => !known.has(String(r.roomId)));
    const listStop = out.stop;   // null / page_cap / list_end：列表没拿全，拿到的局照样查小队；其他（人机校验、登录、超时）不再发请求
    let failedInRow = 0;
    for (const r of todo.slice(0, maxDetails)) {
      if (out.stop !== listStop || !(listStop === null || listStop === 'page_cap' || listStop === 'list_end')) break;
      const j = await call('GetBattleDetail', Object.assign({}, base, { roomId: r.roomId, start_time: r.startTime }), gapMs);
      if (!j) {
        // 单独一局查不到（不是人机校验、登录、超时）：跳过这一局接着查后面的，不然它每次同步都排第一、永远卡住后面所有局；
        // 连着 2 局都失败才停（可能是没认出来的限流码）；同一局不重试
        if (out.stop !== 'api_error' || ++failedInRow >= 2) break;
        out.skipped = (out.skipped || 0) + 1;
        out.stop = listStop; out.stopCode = null;
        continue;
      }
      failedInRow = 0;
      const players = (j.battle_detail && j.battle_detail.sol_players) || [];
      if (players.length) out.details[String(r.roomId)] = players;   // 空名单不记：记了就永远算「查过」、永远显示成单排，下次同步再查
    }
    // 小队没查完时最要紧的是告诉用户「再点一次」：列表没拿全（翻到底 / 翻页上限）的情况另外记在 listStop 里，一起提示
    if (todo.length > maxDetails && (out.stop === null || out.stop === 'page_cap' || out.stop === 'list_end')) { out.listStop = out.stop; out.stop = 'detail_cap'; }
    return out;
  } catch (e) {
    out.stop = 'exception';
    out.error = String(e && e.message || e).slice(0, 160);
    return out;
  } finally {
    window.__SOL_SYNCING = false;
  }
}
