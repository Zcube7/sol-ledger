// v1 端到端自测：无头 Edge 加载 v1/dist/ext-dev，在本地模拟环境（node v1/mock/server.mjs，8771）里：
//   汇总页同步当天 → 每人合计和模拟环境的「标准答案」逐项对上 → 换一天再对 → 本机数据库里没有原始玩家 ID
//   → 同步时自己开的官方页用完就关 → 中途人机校验：已拿到的留着、再同步接着查 → 登录过期给出提示
// 用法：node v1/build.mjs && node v1/mock/server.mjs（另开一个终端）&& node v1/test/e2e.mjs
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, checker, sleep } from '../../m0/test/cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(join(here, '..', 'dist', 'ext-dev'));
const MOCK = 'http://127.0.0.1:8771';
const RAW_IDS = ['144115219000000001', '144115219000000011', '144115219000000012', '1441152190000000013', '14411521900010'];
const dayOf = ms => new Date(ms + 8 * 36e5).toISOString().slice(0, 10);

const { check, fail, report } = checker();
const b = await launch({ port: 9361, extension: EXT });

try {
  let sw = null;
  for (let i = 0; i < 50 && !sw; i++) {
    sw = (await b.targets()).find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    if (!sw) await sleep(200);
  }
  if (!sw) throw new Error('扩展没加载起来（没找到 background.js）');
  const extId = new URL(sw.url).host;
  const dash = await b.openPage(`chrome-extension://${extId}/dashboard.html`);
  const D = dash.sessionId;
  await b.waitFor(D, `document.readyState === 'complete' && !!document.getElementById('sync')`);
  await b.evalIn(D, 'window.confirm = () => true; true');

  /** 在汇总页里选日期、点同步、等结束；返回同步状态 */
  async function syncDay(day, query = '') {
    await b.evalIn(D, `(() => { const i = document.getElementById('day'); i.value = '${day}'; i.dispatchEvent(new Event('change')); window.__SOL_TEST_QUERY = '${query}'; return true; })()`);
    await sleep(300);
    await b.evalIn(D, `document.getElementById('sync').click(); true`, true);
    await sleep(500);
    await b.waitFor(D, `chrome.storage.local.get('syncStatus').then(s => s.syncStatus && s.syncStatus.day === '${day}' && s.syncStatus.state !== 'running')`, 180000);
    await sleep(500);
    return b.evalIn(D, `chrome.storage.local.get('syncStatus').then(s => s.syncStatus)`);
  }
  /** 像用户一样：提示「这次先查了 30 局，再点一次接着查」时就再点，直到查完（最多 4 次） */
  async function syncFully(day) {
    const runs = [];
    for (let i = 0; i < 4; i++) {
      const st = await syncDay(day);
      runs.push(st);
      if (st.stop !== 'detail_cap') break;
    }
    return runs;
  }
  /** 读「每人汇总」表：[{ 昵称, 局数, 撤离, 击杀玩家, 击杀总数, 助攻, 救援, ... }] */
  const readSummary = () => b.evalIn(D, `(() => {
    const t = document.querySelector('#summary table'); if (!t) return [];
    const h = [...t.querySelectorAll('th')].map(x => x.textContent);
    return [...t.querySelectorAll('tbody tr')].map(r => Object.fromEntries([...r.children].map((c, i) => [h[i], c.textContent])));
  })()`);
  const truthOf = async day => (await fetch(`${MOCK}/__truth?day=${day}`)).json();

  async function compareDay(day, label) {
    const truth = await truthOf(day);
    const rows = await readSummary();
    const self = rows[0] || {};
    check(`${label}：「我」这一行 = 全天 ${truth.matches} 局，击杀干员、救助合计对得上`, () => {
      assert.equal(self['昵称'], '我（全天合计）');
      assert.equal(Number(self['局数']), truth.matches);
      assert.equal(Number(self['击杀干员']), truth.self.killPlayer);
      assert.equal(Number(self['救助']), truth.self.rescue);
    });
    const friends = truth.people.filter(p => p.together >= 2);
    check(`${label}：同队 2 局以上的人 = ${friends.map(f => f.name).join('、')}，每人局数、撤离成功、击杀干员、总击杀、助攻、救助都对得上`, () => {
      const got = rows.slice(1);
      // 按局数从多到少排（局数相同的先后不管）
      assert.deepEqual(got.map(r => Number(r['局数'])), friends.map(f => f.together).sort((a, b) => b - a));
      assert.deepEqual(got.map(r => r['昵称']).sort(), friends.map(f => f.name).sort());
      friends.forEach(f => {
        const r = got.find(x => x['昵称'] === f.name);
        assert.equal(Number(r['局数']), f.together, f.name + ' 局数');
        assert.equal(r['撤离成功'], `${f.escaped}/${f.together}`, f.name + ' 撤离');
        assert.equal(Number(r['击杀干员']), f.killPlayer, f.name + ' 击杀玩家');
        assert.equal(Number(r['总击杀']), f.killCnt, f.name + ' 击杀总数');
        assert.equal(Number(r['助攻']), f.assistCnt, f.name + ' 助攻');
        assert.equal(Number(r['救助']), f.rescue, f.name + ' 救援');
      });
    });
    return truth;
  }

  // ---- 1. 当天（默认日期就是今天；今天模拟对局太少的话用昨天） ----
  const today = dayOf(Date.now());
  const defaultDay = await b.evalIn(D, `document.getElementById('day').value`);
  check('汇总页默认日期是今天（北京时间）', () => assert.equal(defaultDay, today));
  const first = (await truthOf(today)).matches >= 4 ? today : dayOf(Date.now() - 864e5);
  const runs1 = await syncFully(first);
  const st1 = runs1[runs1.length - 1];
  const n1 = (await truthOf(first)).matches;
  check(`同步 ${first}（${n1} 局）：每次最多查 30 局小队，超过就提示再点一次；点到第 ${runs1.length} 次查完`, () => {
    assert.equal(st1.state, 'done', JSON.stringify(st1));
    assert.equal(st1.stop, null);
    assert.equal(runs1.length, Math.ceil(n1 / 30));
    runs1.slice(0, -1).forEach(r => assert.equal(r.stop, 'detail_cap'));
  });
  await compareDay(first, first);
  const leftTabs = (await b.targets()).filter(t => t.type === 'page' && t.url.startsWith(MOCK));
  check('同步时自己开的 WeGame 页面用完就关了', () => assert.equal(leftTabs.length, 0));

  // ---- 2. 换一天 ----
  const second = dayOf(Date.parse(first + 'T12:00:00+08:00') - 864e5);
  const runs2 = await syncFully(second);
  const st2 = runs2[runs2.length - 1];
  check(`同步 ${second}：完成`, () => assert.equal(st2.state, 'done', JSON.stringify(st2)));
  await compareDay(second, second);

  // ---- 3. 取消「只看 2 局以上」：路人也列出来 ----
  await b.evalIn(D, `(() => { const c = document.getElementById('friendsOnly'); c.checked = false; c.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(500);
  const allRows = await readSummary();
  const t2 = await truthOf(second);
  check('取消勾选后，所有同队过的人都列出来', () => assert.equal(allRows.length - 1, t2.people.length));
  await b.evalIn(D, `(() => { const c = document.getElementById('friendsOnly'); c.checked = true; c.dispatchEvent(new Event('change')); return true; })()`);

  // ---- 4. 本机数据库里没有原始玩家 ID（只有带本机密钥的代号） ----
  const dump = await b.evalIn(D, `new Promise(res => {
    const r = indexedDB.open('sol-ledger');
    r.onsuccess = () => { const db = r.result; const out = {}; const names = [...db.objectStoreNames]; let left = names.length;
      names.forEach(n => { const q = db.transaction(n).objectStore(n).getAll(); q.onsuccess = () => { out[n] = q.result; if (!--left) res(JSON.stringify(out)); }; }); };
  })`);
  check('本机数据库里没有任何原始玩家 ID', () => { for (const id of RAW_IDS) assert.ok(!dump.includes(id), id); });
  check('本机数据库里队友有昵称和代号（16 位十六进制）', () => assert.match(dump, /"alias":"[0-9a-f]{16}"/));

  // ---- 5. 中途人机校验：已经拿到的留着，提示怎么办；再同步接着查剩下的 ----
  await b.evalIn(D, `document.getElementById('clear').click(); true`, true);
  await sleep(800);
  const st3 = await syncDay(first, '?captcha=detail3');
  const text3 = await b.evalIn(D, `document.getElementById('status').textContent + ' | ' + document.getElementById('summary').textContent`);
  check('人机校验：标记 captcha，提示去官方页面完成验证码，已查到的 2 局小队留着', () => {
    assert.equal(st3.stop, 'captcha');
    assert.match(text3, /人机校验/);
    assert.match(text3, /没查到小队/);
  });
  const runs4 = await syncFully(first);
  const st4 = runs4[runs4.length - 1];
  check('再同步：接着查完剩下的小队', () => { assert.equal(st4.state, 'done'); assert.equal(st4.stop, null); });
  await compareDay(first, '人机校验之后补齐的 ' + first);

  // ---- 6. 登录过期：提示重新登录 ----
  const st5 = await syncDay(second, '?expired=1');
  const text5 = await b.evalIn(D, `document.getElementById('status').textContent`);
  check('登录过期：标记 not_login，提示到 www.wegame.com.cn 重新登录', () => {
    assert.equal(st5.stop, 'not_login');
    assert.match(text5, /重新登录/);
  });

  // ---- 7. 太早的日期：官方战绩翻到底也到不了，明确告诉用户「拿不到」，不说「没打」 ----
  const old = dayOf(Date.now() - 5 * 864e5);
  const st6 = await syncDay(old);
  const text6 = await b.evalIn(D, `document.getElementById('summary').textContent`);
  check('太早的日期：标记 list_end，汇总区说拿不到、不说「没有对局」', () => {
    assert.equal(st6.stop, 'list_end');
    assert.match(text6, /翻到底/);
    assert.doesNotMatch(text6, /这一天没有烽火地带对局/);
  });

  // ---- 8. 同步中途断网：已经拿到的留着，再同步接着查 ----
  await b.evalIn(D, `document.getElementById('clear').click(); true`, true);
  await sleep(800);
  const st7 = await syncDay(first, '?drop=detail4');
  const text7 = await b.evalIn(D, `document.getElementById('status').textContent + ' | ' + document.getElementById('summary').textContent`);
  check('断网：标记 exception，列表和前 3 局小队都存下了，提示再点一次接着查', () => {
    assert.equal(st7.state, 'done', JSON.stringify(st7));
    assert.equal(st7.stop, 'exception');
    assert.ok(st7.saved.matches > 0 && st7.saved.details === 3, JSON.stringify(st7.saved));
    assert.match(text7, /已经拿到的数据保留了/);
  });
  const runs8 = await syncFully(first);
  const st8 = runs8[runs8.length - 1];
  check('断网之后再同步：补齐', () => { assert.equal(st8.state, 'done'); assert.equal(st8.stop, null); });
  await compareDay(first, '断网之后补齐的 ' + first);

  // ---- 9. 普通网页没法让扩展同步 ----
  const m = await b.openPage(MOCK + '/helper/df/score/');
  await b.waitFor(m.sessionId, `document.readyState === 'complete'`);
  const hasRuntime = await b.evalIn(m.sessionId, `typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
  check('普通网页拿不到扩展的通道', () => assert.equal(hasRuntime, false));
} catch (e) {
  fail('运行出错：' + (e && e.stack || e));
} finally {
  await b.close();
}
process.exit(report() ? 1 : 0);
