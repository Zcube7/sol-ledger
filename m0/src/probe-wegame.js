/* ============================================================================
 * M0 验证书签 A · 在 WeGame 助手页面（https://www.wegame.com.cn/helper/df/score/）上运行
 *
 * 只查烽火地带（queue=sol）。请求和官方页面自己发的一样：同源、带 trpc-caller 头、
 * 请求体带 from_src=df_web；Origin / Referer / UA 都由浏览器真实给出，脚本不手写。
 * 遇到人机校验（8000022）或未登录就立刻停，不重试。
 * 验证项：W1（接口能不能调通）、W2（单局详情字段）、W3（战绩列表翻页）。
 * ========================================================================== */

const DFP_VERSION = 'm0-a-2';
const DFP_ORIGIN = 'https://www.wegame.com.cn';

if (location.origin !== DFP_ORIGIN && !dfpIsMock()) {
  if (DFP_MODE !== 'ext') alert('请在 WeGame 助手页面上点这个书签：\nhttps://www.wegame.com.cn/helper/df/score/\n（先在那个页面登录 QQ 号）');
  return { error: 'wrong_page' };
}
if (window.__DFP_RUNNING) {
  if (DFP_MODE !== 'ext') alert('验证已经在运行了，请等它结束。');   // 扩展模式不弹框：alert 会卡住官方页面，原因由扩展弹窗显示
  return { error: 'already_running' };
}
window.__DFP_RUNNING = true;

const API = '/api/v1/wegame.pallas.dfm.DfmBattle/';
const SEASON_API = '/api/rail/web/data_filter/game_config/query';
const NOT_LOGIN = [8000102, 8000103, 1001001, 1001002];
const CAPTCHA = 8000022;
const GAP_MS = 900;          // 两次请求之间的间隔
const LIST_GAP_MS = 1500;    // 翻页试验时两次战绩列表请求之间的间隔：官方只给这个接口套了人机校验，放慢一点
const MAX_LIST_CALLS = 12;   // 战绩列表最多请求这么多次（含翻页试验）
const MAX_DETAIL = 4;        // 最多看几局详情（W6 要比对队友，样本多一点；单局详情官方没套人机校验）

const panel = dfpMakePanel('M0 验证 · 书签 A（WeGame 助手）');
panel.setVersion(DFP_VERSION);
const report = {
  tool: 'sol-ledger-m0', probe: 'A-wegame', version: DFP_VERSION,
  page: location.origin + location.pathname,
  ua: dfpShortUa(),
  steps: [], findings: {}, stop: null,
};
const secrets = new Set();      // 本次看到的 ID / 昵称 / roomId，最后用来自检报告
const privateOnly = { teammateIdHashes: [] };   // 只交给本机接收页，不进复制 / 下载
let stopReason = null;
let listCalls = 0;

async function call(label, url, body, headers) {
  if (stopReason) return null;
  if (report.steps.length) await dfpSleep(GAP_MS);
  const step = { label, endpoint: url.replace(API, '') };
  // 运行时兜底：只许发到本页同源。红线单测只核对 fetch( 的实参名叫 url，管不到 call() 被传进什么地址（'https://…'、'//…' 都会出站）
  if (new URL(url, location.href).origin !== location.origin) throw new Error('只许同源请求：' + label);
  const t0 = performance.now();
  try {
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body),
    });
    step.http = r.status;
    const j = await r.json().catch(() => null);
    step.ms = Math.round(performance.now() - t0);
    const res = j && j.result;
    step.code = res && res.error_code !== undefined ? res.error_code : null;
    // 先把带数字的长串（openid、roomId、QQ 号、token）换成形态再截断，免得截出半个 ID 绕过自检
    if (res && res.error_message) step.msg = String(res.error_message).replace(/[\w\-+/=.@%]{5,}/g, m => (/\d/.test(m) ? `‹${dfpStrKind(m)}›` : m)).slice(0, 60);
    step.shape = j ? dfpShape(j) : null;
    report.steps.push(step);
    const ok = r.ok && (step.code === 0 || step.code === null);
    panel.log(`${ok ? '✓' : '✗'} ${label}：HTTP ${step.http}，code ${step.code}`, ok ? 'ok' : 'err');
    if (step.code === CAPTCHA) {
      stopReason = 'captcha';
      panel.log('官方要求人机校验（8000022）。已停止，不会重试。请按 F5 刷新这个页面：页面加载战绩列表时如果弹出验证码，按提示完成；能正常看到自己的战绩后再点书签。', 'warn');
    } else if (NOT_LOGIN.includes(step.code)) {
      stopReason = 'not_login';
      panel.log('官方说未登录。请先在这个页面用 QQ 登录，再点书签。', 'warn');
    }
    return j;
  } catch (e) {
    step.error = String(e && e.message || e).slice(0, 100);
    report.steps.push(step);
    panel.log(`✗ ${label}：${step.error}`, 'err');
    return null;
  }
}

/** label 的开头就是接口名（如「GetBattleList 翻页试验…」），URL 只用接口名 */
const battle = (label, body, opts = {}) => {
  const method = (label.match(/^[A-Za-z]+/) || [''])[0];
  return call(
    label, API + method,
    opts.noFromSrc ? body : Object.assign({ from_src: 'df_web' }, body),
    { 'trpc-caller': 'wegame.pallas.web.DfmBattle' },
  );
};

/* ---------- 1. 登录与角色（W1） ---------- */
panel.log('开始。只查烽火地带，最多约 25 次请求，每次间隔 1~1.5 秒，大约 40 秒跑完。', 'dim');
const userType = dfpCookieFlag('tgp_user_type');           // 只是「QQ / 微信」标记位，不是凭据
const firstType = userType === '1' ? 2 : 1;                 // 官方：tgp_user_type=1 表示微信
report.findings.accountTypeGuess = { fromCookieFlag: userType !== null, accountType: firstType };

let accountType = firstType;
let role = null;
for (const t of [firstType, firstType === 1 ? 2 : 1]) {
  const j = await battle(`GetRoleInfo(account_type=${t})`, { account_type: t, area: 36 });
  // 官方把 GetRoleInfo 的 8000102 当成「查不到角色」，不一定是没登录：账号类型猜错时也可能这样，换另一种类型再试一次
  if (stopReason === 'not_login' && report.steps[report.steps.length - 1].code === 8000102 && t === firstType) {
    stopReason = null;
    panel.log('这种账号类型查不到角色，换另一种再试一次。', 'dim');
    continue;
  }
  if (stopReason) break;
  const ri = j && j.role_info;
  if (ri && ri.openid) { role = ri; accountType = t; break; }
}
if (!role) {
  report.findings.role = { ok: false };
  if (!stopReason) { stopReason = 'no_role'; panel.log('两种账号类型都没取到角色信息。确认这个号有三角洲角色，并且已在本页登录。', 'warn'); }
} else {
  const openid = String(role.openid);
  secrets.add(openid);
  ['name', 'tgp_id', 'icon'].forEach(k => role[k] && secrets.add(String(role[k])));
  report.findings.role = {
    ok: true, accountType,
    openidKind: dfpStrKind(openid),
    keys: dfpSafeKeys(role),
  };
  const base = { openid, area: 36, account_type: accountType };

  /* ---------- 2. 赛季列表 ---------- */
  const seasonsJ = await call('赛季列表 df_helper_score_season_list', SEASON_API,
    { data_names: 'df_helper_score_season_list', command: 'list_all', params: { start_page: 0, items_per_pager: 50, filters: [] } });
  const seasonItems = (seasonsJ && seasonsJ.items) || [];
  const seasonIds = seasonItems.map(s => s && s.season_id).filter(x => x !== undefined && x !== null).map(String);
  const latestSid = seasonIds.filter(s => s !== '0' && /^\d+$/.test(s)).sort((a, b) => Number(b) - Number(a))[0] || '0';
  report.findings.seasons = { count: seasonItems.length, seasonIds, latestSid };

  /* ---------- 3. 战绩列表与翻页（W3） ---------- */
  const listCall = async (label, extra) => {
    if (listCalls >= MAX_LIST_CALLS) return null;
    listCalls += 1;
    if (listCalls > 1) await dfpSleep(LIST_GAP_MS - GAP_MS);   // call() 自己还会再等 GAP_MS
    const j = await battle(label, Object.assign({ size: 5, after: null, filters: [] }, base, { queue: 'sol' }, extra));
    return j;
  };
  const rowsOf = j => ((j && j.sols) || []);
  const timeOf = row => {
    const v = row && (row.dtEventTime || row.startTime);
    if (v === undefined || v === null) return NaN;
    if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
    if (/^\d+$/.test(String(v))) { const n = Number(v); return n > 1e12 ? n : n * 1000; }
    return Date.parse(String(v).replace(' ', 'T') + '+08:00');
  };
  const idOf = row => row && (row.roomId !== undefined ? String(row.roomId) : null);

  const p1j = await listCall('GetBattleList(sol, size=5, 第1页)', {});
  const p1 = rowsOf(p1j);
  p1.forEach(r => idOf(r) && secrets.add(idOf(r)));
  const listInfo = {
    page1Count: p1.length,
    page1Mapid80: p1.filter(r => r && r.mapId === 80).length,
    rowKeysUnion: [...new Set(p1.flatMap(r => dfpSafeKeys(r)))].sort(),
    hasRoomId: p1.every(r => idOf(r) !== null),
    timeFieldKinds: dfpKindHistogram(p1.map(r => r && (r.dtEventTime !== undefined ? r.dtEventTime : r.startTime))),
    otherQueues: Object.keys((p1j || {})).filter(k => /s$/.test(k) && Array.isArray(p1j[k]) && k !== 'sols').map(dfpSafeKey),
  };

  report.findings.battleList = listInfo;
  // 翻页试验（W3）要连着请求战绩列表，而官方只给战绩列表套了 8000022 人机校验处理，最容易在这里被拦。
  // 所以先用第 1 页把 W2 / W1 要的都取完，翻页试验放到最后（见 5b），被拦也不影响前面的结论。
  const base1 = p1;

  /* ---------- 4. 单局详情（W2） ---------- */
  const recent = base1.slice(0, MAX_DETAIL);
  const details = [];
  for (const row of recent) {
    if (stopReason) break;
    const j = await battle('GetBattleDetail(sol)', Object.assign({}, base, {
      roomId: row.roomId, queue: 'sol', start_time: row.startTime !== undefined ? row.startTime : '',
    }));
    const bd = (j && j.battle_detail) || {};
    const players = Array.isArray(bd.sol_players) ? bd.sol_players : [];
    // 认「哪个字段是 ID / 昵称」：先看值等于自己 openid 的字段
    const selfKeys = [...new Set(players.flatMap(p => dfpKeysEqualTo(p, openid)))];
    const idKey = selfKeys[0] || ['vopenid', 'openid', 'playerId', 'uid'].find(k => players.some(p => p && p[k] !== undefined)) || null;
    const nameKey = ['name', 'nickName', 'nickname', 'charac_name', 'roleName'].find(k => players.some(p => p && p[k] !== undefined)) || null;
    for (const p of players) {
      if (!p) continue;
      if (idKey && p[idKey] != null) secrets.add(String(p[idKey]));
      if (nameKey && p[nameKey] != null) secrets.add(String(p[nameKey]));
      Object.values(p).forEach(v => { if (typeof v === 'string' && v.length >= 6) secrets.add(v); });
    }
    const teammates = idKey ? players.filter(p => p && p[idKey] != null && String(p[idKey]) !== openid) : [];
    for (const p of teammates) {
      const h = await dfpHash12(String(p[idKey]));
      if (!privateOnly.teammateIdHashes.includes(h)) privateOnly.teammateIdHashes.push(h);   // 同一个人出现在多局里只算一次
    }
    const teamKey = ['teamId', 'TeamId', 'team_id', 'squadId', 'camp', 'color'].find(k => players.some(p => p && p[k] !== undefined)) || null;
    details.push({
      battleDetailKeys: dfpSafeKeys(bd),
      solPlayersCount: players.length,
      playerShape: players.length ? dfpMergeShapes(players.slice(0, 8).map(p => dfpShape(p))) : null,
      selfFoundBy: selfKeys,
      idKey, nameKey, teamKey,
      idKinds: idKey ? dfpKindHistogram(players.map(p => p && p[idKey])) : null,
      teamDistinct: teamKey ? new Set(players.map(p => p && p[teamKey])).size : null,
      itemLike: dfpFindItemLike(bd).slice(0, 15),
      otherPlayerLists: Object.keys(bd).filter(k => /players/i.test(k) && k !== 'sol_players').map(dfpSafeKey),
    });
  }
  report.findings.battleDetail = details;
  if (details.length) {
    const d = details[0];
    panel.log(`单局详情：sol_players ${d.solPlayersCount} 人；ID 字段 ${d.idKey || '未找到'}；` +
      `像物品 / 带出的字段 ${d.itemLike.length} 处`, d.solPlayersCount ? 'ok' : 'warn');
  }

  /* ---------- 5. 赛季汇总、分地图、资产、藏品（W1） ---------- */
  const repLatest = await battle(`GetBattleReport(sol, sid=${latestSid})`, Object.assign({}, base, { sid: latestSid, queue: 'sol' }));
  const repAll = await battle('GetBattleReport(sol, sid=0 全部赛季)', Object.assign({}, base, { sid: '0', queue: 'sol' }));
  report.findings.battleReport = {
    latestHasSol: !!(repLatest && repLatest.season && repLatest.season.sol),
    allHasSol: !!(repAll && repAll.season && repAll.season.sol),
  };
  const mapids = [...new Set(base1.map(r => r && r.mapId).filter(x => x !== undefined && x !== null && x !== 80))];
  // 官方只在「有地图列表、赛季不是 0（全部）」时才调 GetMapStats；不满足就不发，免得发出官方不会发的请求
  const mapsOk = mapids.length > 0 && latestSid !== '0';
  const mapsJ = mapsOk ? await battle('GetMapStats(sol)', Object.assign({}, base, { sid: latestSid, mapids, queue: 'sol' })) : null;
  report.findings.mapStats = { requestedMapCount: mapids.length, skipped: !mapsOk, returned: mapsJ && Array.isArray(mapsJ.maps) ? mapsJ.maps.length : null };
  const daily = await battle('GetDailyStats', base, { noFromSrc: true });
  report.findings.dailyStats = daily ? {
    lengths: Object.fromEntries(['daily_assets', 'daily_values', 'daily_hafcoins', 'rankpoints']
      .map(k => [k, Array.isArray(daily[k]) ? daily[k].length : null])),
  } : null;
  const coll = await battle('GetCollectibles', base);
  report.findings.collectibles = coll ? {
    collectibles: Array.isArray(coll.collectibles) ? coll.collectibles.length : null,
    opers: Array.isArray(coll.opers) ? coll.opers.length : null,
  } : null;

  /* ---------- 5b. 战绩列表翻页试验（W3，放在最后） ---------- */
  if (stopReason) {
    listInfo.window = { cursorField: null, note: '前面已停止，没有做翻页试验' };
  } else {
    // size 是否被服务端封顶
    const bigj = await listCall('GetBattleList(sol, size=20)', { size: 20 });
    listInfo.size20Count = rowsOf(bigj).length;
    rowsOf(bigj).forEach(r => idOf(r) && secrets.add(idOf(r)));

    // 游标试验：先试回包顶层像游标的字段（after / next / cursor…），再试最后一条 / 第 7 条的 dtEventTime、startTime、roomId；
    // 试出第一个能往前翻的就停，不把候选全试一遍
    const pool = rowsOf(bigj).length > p1.length ? rowsOf(bigj) : p1;
    const seen1 = new Set(pool.map(idOf));
    const oldest1 = Math.min(...pool.map(timeOf).filter(x => !isNaN(x)));
    const cursorTrials = [];
    const candidates = [];
    const respJ = [bigj, p1j].find(x => x && typeof x === 'object') || {};
    // 只认字符串 / 数字值；has_next、is_after 这类布尔标记不算游标
    const respCursorKey = Object.keys(respJ).find(k => /after|cursor|next|offset/i.test(k) && !/^(has|is)/i.test(k) &&
      (typeof respJ[k] === 'string' || typeof respJ[k] === 'number') && String(respJ[k]) !== '') || null;
    // 自检名单只收 6 位以上的值：短值（如页码 20、偏移 100）不是隐私
    const addCursorSecret = v => { if (String(v).length >= 6) secrets.add(String(v)); };
    listInfo.respCursorKey = respCursorKey && dfpSafeKey(respCursorKey);
    if (respCursorKey) {
      addCursorSecret(respJ[respCursorKey]);
      candidates.push({ field: respCursorKey, idx: -1, value: respJ[respCursorKey], fromResponse: true });
    }
    for (const field of ['dtEventTime', 'startTime', 'roomId']) {
      for (const idx of [pool.length - 1, 6]) {
        const row = pool[idx];
        if (row && row[field] !== undefined && row[field] !== null && !candidates.some(c => c.field === field && c.idx === idx)) {
          candidates.push({ field, idx, value: row[field] });
        }
      }
    }
    const cursorLabel = c => (c.fromResponse ? `回包里的 ${dfpSafeKey(c.field)}` : `第${c.idx + 1}条的 ${c.field}`);
    let bestCursor = null;
    for (const c of candidates) {
      if (stopReason || listCalls >= MAX_LIST_CALLS - 3) break;
      const j = await listCall(`GetBattleList 翻页试验(after=${cursorLabel(c)})`, { size: 20, after: c.value });
      const rows = rowsOf(j);
      rows.forEach(r => idOf(r) && secrets.add(idOf(r)));
      const overlap = rows.filter(r => seen1.has(idOf(r))).length;
      const newest = Math.max(...rows.map(timeOf).filter(x => !isNaN(x)));
      const trial = {
        field: dfpSafeKey(c.field), fromIndex: c.idx + 1, fromResponse: !!c.fromResponse, valueKind: dfpStrKind(String(c.value)),
        code: report.steps[report.steps.length - 1].code,
        count: rows.length, overlapWithPage1: overlap,
        movesOlder: rows.length > 0 && isFinite(oldest1) && isFinite(newest) ? newest <= oldest1 : null,
      };
      cursorTrials.push(trial);
      if (rows.length > 0 && overlap < rows.length && trial.movesOlder !== false) { bestCursor = c; break; }
    }
    listInfo.cursorTrials = cursorTrials;

    // 用试出来的游标往前翻，量一下窗口有多深
    if (bestCursor && !stopReason) {
      let after = bestCursor.value;
      const all = new Map(pool.map(r => [idOf(r), r]));
      let pages = 1;
      let depthStop = 'cap';
      while (listCalls < MAX_LIST_CALLS && !stopReason) {
        const j = await listCall(`GetBattleList 量窗口(第${pages + 1}页)`, { size: 20, after });
        const rows = rowsOf(j);
        rows.forEach(r => idOf(r) && secrets.add(idOf(r)));
        const before = all.size;
        rows.forEach(r => all.set(idOf(r), r));
        pages += 1;
        if (!rows.length) { depthStop = stopReason || 'empty'; break; }
        if (all.size === before) { depthStop = 'no_progress'; break; }
        const pick = bestCursor.fromResponse ? j : (bestCursor.idx === 6 ? rows[6] : rows[rows.length - 1]);
        if (!pick || pick[bestCursor.field] === undefined || pick[bestCursor.field] === null) { depthStop = 'no_cursor'; break; }
        after = pick[bestCursor.field];
        if (bestCursor.fromResponse) addCursorSecret(after);
      }
      const times = [...all.values()].map(timeOf).filter(x => !isNaN(x));
      listInfo.window = {
        cursorField: dfpSafeKey(bestCursor.field), cursorFromIndex: bestCursor.idx + 1, cursorFromResponse: !!bestCursor.fromResponse,
        pagesFetched: pages, uniqueMatches: all.size, stop: depthStop,
        spanHours: times.length > 1 ? Math.round((Math.max(...times) - Math.min(...times)) / 36e5) : null,
      };
    } else {
      listInfo.window = { cursorField: null, note: stopReason ? `翻页试验中途停止（${stopReason}）` : '没有试出能往前翻的游标' };
    }
    panel.log(`战绩列表：第一页 ${p1.length} 条；size=20 时 ${listInfo.size20Count} 条；` +
      (bestCursor ? `能用「${cursorLabel(bestCursor)}」往前翻，共拿到 ${listInfo.window.uniqueMatches} 局` : '没试出翻页游标'),
      bestCursor ? 'ok' : 'warn');
  }
}

/* ---------- 6. 汇总 ---------- */
report.stop = stopReason;
const methods = ['GetRoleInfo', 'GetBattleList', 'GetBattleDetail', 'GetBattleReport', 'GetMapStats', 'GetDailyStats', 'GetCollectibles'];
report.findings.W1 = Object.fromEntries(methods.map(m => {
  const s = report.steps.filter(x => x.label.startsWith(m));
  return [m, s.length ? (s.some(x => x.http === 200 && x.code === 0) ? 'ok' : `fail(${s.map(x => x.code).join(',')})`) : 'not_called'];
}));
const okCount = Object.values(report.findings.W1).filter(v => v === 'ok').length;
panel.log(`W1：${okCount}/7 个接口调通。${stopReason ? '（提前停止：' + stopReason + '）' : ''}`, okCount === 7 ? 'ok' : 'warn');

const raw = JSON.stringify(report, null, 2);
const { text, leaked } = dfpScrub(raw, secrets);
if (leaked) panel.log(`自检：报告里发现 ${leaked} 处疑似具体值，已替换成「[已移除]」。`, 'warn');
else panel.log('自检通过：报告里没有你的 ID、昵称或场次号。', 'ok');

const fname = `m0-A-wegame-${new Date().toISOString().slice(0, 10)}.json`;
panel.enable('copy', async () => panel.log(await dfpCopy(text) ? '已复制，粘贴给我就行。' : '复制失败，请用「下载报告」。', 'dim'));
panel.enable('download', () => dfpDownload(text, fname));
if (DFP_MODE !== 'ext') panel.enable('handoff', () => dfpHandoff({ probe: 'A', report: JSON.parse(text), privateOnly }, panel));
if (dfpIsMock()) {
  window.__DFP_TEST_REPORT = text;     // 只在本地模拟页里暴露，供自动化测试检查有没有漏值
  window.__DFP_TEST_LEAKED = leaked;   // e2e 要断言它是 0：自检会把漏出来的值盖成 [已移除]，只查替换后的文本永远是绿的
}
window.__DFP_RUNNING = false;
if (DFP_MODE === 'ext') {
  panel.log('完成。结果已交给 SolLedger 扩展：可以在扩展弹窗里复制报告，或打开本机接收页看 W6 / W7。', 'dim');
  return { probe: 'A', version: DFP_VERSION, report: JSON.parse(text), leaked, privateOnly };   // 交给扩展（executeScript 的返回值）
}
panel.log('完成。可以复制或下载报告；W7 需要先启动本机接收页。', 'dim');
