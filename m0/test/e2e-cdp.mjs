// 端到端自测：用本机 Edge（无头）+ Chrome DevTools 协议，在模拟环境里完整跑一遍
//   书签 A → 交接给接收页（W7）；再跑各种「立刻停」场景。验证 B 暂缓，相关用例已移除。
// 前提：已运行 node m0/build.mjs，并启动了 node m0/mock/server.mjs（8770）和 node m0/serve.mjs（8766）。
// 用法：node m0/test/e2e-cdp.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const exe = BROWSERS.find(p => existsSync(p));
if (!exe) { console.error('找不到 Edge 或 Chrome'); process.exit(2); }
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'dfp-e2e-'));
const proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 不能用的值：模拟数据里的 ID、昵称、场次号，一个都不许出现在报告里
const FORBIDDEN = ['144115219000000001', '144115219000000002', '144115219000000099', '测试玩家甲', '队友乙', '路人丙', '7300000000000000000'];

let ws, seq = 0;
const pending = new Map();
const events = [];
function send(method, params = {}, sessionId) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      ws = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (d.id && pending.has(d.id)) {
          const p = pending.get(d.id); pending.delete(d.id);
          d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
        } else events.push(d);
      };
      return;
    } catch (e) { await sleep(200); }
  }
  throw new Error('连不上浏览器调试端口');
}
async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}
async function evalIn(sessionId, expression, userGesture = false) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}
async function waitFor(sessionId, expression, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await evalIn(sessionId, expression).catch(() => false)) return true;
    await sleep(300);
  }
  throw new Error('等待超时：' + expression);
}
async function runProbe(url) {
  const page = await openPage(url);
  await waitFor(page.sessionId, `document.readyState === 'complete' && !!document.getElementById('run')`);
  await evalIn(page.sessionId, `document.getElementById('run').click()`, true);
  await waitFor(page.sessionId, `typeof window.__DFP_TEST_REPORT === 'string'`, 90000);
  const text = await evalIn(page.sessionId, 'window.__DFP_TEST_REPORT');
  const leaked = await evalIn(page.sessionId, 'window.__DFP_TEST_LEAKED');
  // 报告文本是自检替换「之后」的：结构摘要真漏了值也会被 [已移除] 盖住，只查 FORBIDDEN 永远是绿的，所以还要断言自检一处都没替换
  check(`${new URL(url).pathname}${new URL(url).search}：结构摘要本身不带值（自检替换 0 处）`, () => assert.equal(leaked, 0));
  return { page, report: JSON.parse(text), text, leaked };
}
async function receiverSession() {
  const { targetInfos } = await send('Target.getTargets');
  const t = targetInfos.find(x => x.type === 'page' && x.url.startsWith('http://127.0.0.1:8766/receiver.html'));
  if (!t) return null;
  const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  return sessionId;
}

const results = [];
const check = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name + '：' + e.message]); } };

try {
  await connect();

  // ---- 书签 A ----
  const A = await runProbe('http://127.0.0.1:8770/helper/df/score/');
  check('A：7 个接口全部调通', () => assert.deepEqual(Object.values(A.report.findings.W1), Array(7).fill('ok')));
  check('A：没有提前停止', () => assert.equal(A.report.stop, null));
  check('A：试出了翻页游标并量到 40 局', () => {
    assert.ok(A.report.findings.battleList.window.cursorField);
    assert.equal(A.report.findings.battleList.window.uniqueMatches, 40);
  });
  check('A：size 被封顶在 8', () => assert.equal(A.report.findings.battleList.size20Count, 8));
  check('A：mapId=80 被数出来', () => assert.ok(A.report.findings.battleList.page1Mapid80 >= 0));
  check('A：单局详情认出 ID 字段、昵称字段、小队字段', () => {
    const d = A.report.findings.battleDetail[0];
    assert.equal(d.idKey, 'vopenid'); assert.equal(d.nameKey, 'name'); assert.equal(d.teamKey, 'teamId');
    assert.deepEqual(d.selfFoundBy, ['vopenid']);
  });
  check('A：找到带出物品字段', () => assert.ok(A.report.findings.battleDetail[0].itemLike.some(h => h.path.includes('carryOutItems'))));
  check('A：单局详情看了 4 局（第 1 页 5 条里取前 4 条）', () => assert.equal(A.report.findings.battleDetail.length, 4));
  check('A：用 openid 当键的字典只留键的形态', () => assert.ok(A.text.includes('<键:digits(18)>')));
  check('A：has_next 这种布尔标记没被当成游标', () => assert.equal(A.report.findings.battleList.respCursorKey, null));
  check('A：UA 只留浏览器和主版本号', () => assert.match(A.report.ua, /^[A-Za-z]+\/\d+$/));
  check('A：报告里没有任何模拟的 ID / 昵称 / 场次号', () => { for (const f of FORBIDDEN) assert.ok(!A.text.includes(f), f); });

  // W7：在面板里点「测试交接」（用 userGesture，等同于真人点击）
  await evalIn(A.page.sessionId, 'window.__DFP_TEST_HOOKS.handoff()', true);
  let rs = null;
  for (let i = 0; i < 30 && !rs; i++) { await sleep(300); rs = await receiverSession(); }
  check('W7：书签 A 弹出了接收页', () => assert.ok(rs));
  if (rs) await waitFor(rs, `/验证 A\t已收到/.test(document.body.innerText)`, 15000);
  const recvText = rs ? await evalIn(rs, 'document.body.innerText') : '';
  check('W7：接收页收到 A，按人去重后数出队友 2 人', () => assert.match(recvText, /一起组队的有 2 人/));
  check('接收页：原始报告区域里也没有模拟的 ID / 昵称', () => { for (const f of FORBIDDEN) assert.ok(!recvText.includes(f), f); });

  // ---- 人机校验：立刻停 ----
  const C = await runProbe('http://127.0.0.1:8770/helper/df/score/?captcha=1');
  check('8000022：报告标记 captcha 并停止', () => assert.equal(C.report.stop, 'captcha'));
  check('8000022：遇到之后不再请求战绩列表', () => {
    const idx = C.report.steps.findIndex(s => s.code === 8000022);
    assert.ok(idx >= 0);
    assert.equal(C.report.steps.slice(idx + 1).length, 0);
  });

  // ---- 翻页试验时才要人机校验：前面的 W1 / W2 不受影响 ----
  const D = await runProbe('http://127.0.0.1:8770/helper/df/score/?captcha=paging');
  check('翻页被拦：7 个接口仍然全部调通（翻页放在最后）', () => assert.deepEqual(Object.values(D.report.findings.W1), Array(7).fill('ok')));
  check('翻页被拦：标记 captcha，被拦之后一个请求都不再发', () => {
    assert.equal(D.report.stop, 'captcha');
    assert.equal(D.report.steps[D.report.steps.length - 1].code, 8000022);
    assert.equal(D.report.steps.filter(s => s.code === 8000022).length, 1);
  });
  check('翻页被拦：单局详情照样拿到', () => assert.equal(D.report.findings.battleDetail.length, 4));

  // ---- 查角色返回 8000102：换另一种账号类型再试一次 ----
  const E = await runProbe('http://127.0.0.1:8770/helper/df/score/?role8000102=1');
  check('8000102：换成微信类型取到角色，没有误报未登录', () => {
    assert.equal(E.report.findings.role.ok, true);
    assert.equal(E.report.findings.role.accountType, 2);
    assert.notEqual(E.report.stop, 'not_login');
  });

  // ---- 登录过期（8025004，真机实测到的码）：当成未登录立刻停，不再试另一种账号类型 ----
  const X = await runProbe('http://127.0.0.1:8770/helper/df/score/?expired=1');
  check('8025004 登录过期：标记 not_login，只查了一次角色', () => {
    assert.equal(X.report.stop, 'not_login');
    assert.equal(X.report.steps.length, 1);
    assert.equal(X.report.steps[0].code, 8025004);
  });

} catch (e) {
  results.push(['FAIL', '运行出错：' + e.message]);
} finally {
  try { ws && ws.close(); } catch (e) { /* ignore */ }
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* Edge 可能还没释放文件 */ }
}
for (const [s, n] of results) console.log(`${s === 'ok' ? '✓' : '✗'} ${n}`);
const fails = results.filter(r => r[0] !== 'ok').length;
console.log(`\n${results.length - fails}/${results.length} 通过`);
process.exit(fails ? 1 : 0);
