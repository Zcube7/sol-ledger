// 扩展端到端自测：无头 Edge 加载 dist/ext-dev（开发版扩展，多了本地模拟环境的权限），在模拟环境里跑完整流程：
//   弹窗发起 A → 关掉弹窗后台照样跑完 → 结果进扩展存储 → B → 本机接收页通过 site-bridge 读到两份报告（W6 / W7）
//   → 翻页时才要人机校验 → Milo 不回调立刻停 → 普通网页没法跟扩展说话。
// 前提：已运行 node m0/build.mjs，并启动了 node m0/mock/server.mjs（8770）和 node m0/serve.mjs（8766）。
// 用法：node m0/test/e2e-ext.mjs
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, checker, sleep } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(join(here, '..', 'dist', 'ext-dev'));
// 模拟数据里的 ID、昵称、场次号：一个都不许出现在报告里
const FORBIDDEN = ['144115219000000001', '144115219000000002', '144115219000000099', '测试玩家甲', '队友乙', '路人丙', '7300000000000000000'];

const { check, fail, report } = checker();
const b = await launch({ port: 9334, extension: EXT });

try {
  // 找到扩展的 service worker，拿扩展 ID
  let sw = null;
  for (let i = 0; i < 50 && !sw; i++) {
    sw = (await b.targets()).find(t => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    if (!sw) await sleep(200);
  }
  if (!sw) throw new Error('扩展没加载起来（没找到 background.js）');
  const extId = new URL(sw.url).host;
  const popupUrl = `chrome-extension://${extId}/popup.html`;

  /** 像用户一样：打开弹窗、点「跑验证」、马上关掉弹窗；再开一个弹窗等后台把结果写进存储 */
  async function runViaPopup(probe, query = '') {
    const p = await b.openPage(popupUrl);
    await b.waitFor(p.sessionId, `document.readyState === 'complete'`);
    await b.evalIn(p.sessionId, `chrome.storage.local.remove(['status_${probe}', 'result_${probe}']).then(() => true)`);
    await b.evalIn(p.sessionId, `chrome.runtime.sendMessage({ type: 'run', probe: '${probe}', query: '${query}' }).catch(() => {}); true`);
    await sleep(500);
    await b.send('Target.closeTarget', { targetId: p.targetId });   // 弹窗关了，后台要自己跑完
    const q = await b.openPage(popupUrl);
    await b.waitFor(q.sessionId, `chrome.storage.local.get('status_${probe}').then(s => s.status_${probe} && s.status_${probe}.state !== 'running')`, 240000);   // 本机负载高时模拟环境的 A 要 100 多秒
    const s = await b.evalIn(q.sessionId, `chrome.storage.local.get(['status_${probe}', 'result_${probe}'])`);
    const popupText = await b.evalIn(q.sessionId, 'document.body.innerText');
    await b.send('Target.closeTarget', { targetId: q.targetId });
    return { status: s[`status_${probe}`], result: s[`result_${probe}`], popupText };
  }

  // ---- A：正常跑完（模拟环境里约 45~110 秒，随本机负载变）。保活写着，但这条用例验证不到它：
  //      实测去掉保活也照样跑完，在途的 executeScript 本身就让后台活着。真正的风险是后台被停掉，见下面单独的用例 ----
  const A = await runViaPopup('A');
  check('扩展 A：后台跑完（弹窗关掉也不影响）', () => assert.equal(A.status.state, 'done', JSON.stringify(A.status)));
  check('扩展 A：7 个接口全部调通，没有提前停止', () => {
    assert.deepEqual(Object.values(A.result.report.findings.W1), Array(7).fill('ok'));
    assert.equal(A.result.report.stop, null);
  });
  check('扩展 A：结构摘要本身不带值（自检替换 0 处）', () => assert.equal(A.result.leaked, 0));
  check('扩展 A：存储里没有任何模拟的 ID / 昵称 / 场次号', () => { const t = JSON.stringify(A.result); for (const f of FORBIDDEN) assert.ok(!t.includes(f), f); });
  check('扩展 A：队友哈希只有 12 位十六进制', () => assert.ok(A.result.privateOnly.teammateIdHashes.length > 0 && A.result.privateOnly.teammateIdHashes.every(h => /^[0-9a-f]{12}$/.test(h))));
  check('扩展 A：弹窗显示完成', () => assert.match(A.popupText, /A · WeGame 助手[\s\S]*完成/));

  // ---- B ----
  const B = await runViaPopup('B');
  check('扩展 B：后台跑完', () => assert.equal(B.status.state, 'done', JSON.stringify(B.status)));
  check('扩展 B：周报、好友、个人中心、大红、日报都取到数', () => {
    const w = B.result.report.findings.W5;
    for (const k of ['weekly.sol.record', 'weekly.sol.highlights', 'weekly.sol.friend.record', 'center.person.resource', 'center.person.redcollection', 'center.recent.detail']) assert.equal(w[k], true, k);
  });
  check('扩展 B：结构摘要本身不带值（自检替换 0 处）', () => assert.equal(B.result.leaked, 0));
  check('扩展 B：存储里没有任何模拟的 ID / 昵称', () => { const t = JSON.stringify(B.result); for (const f of FORBIDDEN) assert.ok(!t.includes(f), f); });

  // ---- W6 / W7：本机接收页通过 site-bridge 从扩展读两份报告 ----
  const r = await b.openPage('http://127.0.0.1:8766/receiver.html?test=1');
  await b.waitFor(r.sessionId, `/书签 B\t已收到/.test(document.body.innerText)`, 20000).catch(e => fail('接收页没读到扩展里的报告：' + e.message));
  const recvText = await b.evalIn(r.sessionId, 'document.body.innerText');
  check('W7：接收页从扩展读到 A、B 两份报告', () => assert.match(recvText, /书签 A\t已收到（[^）]*来自 SolLedger 扩展）[\s\S]*书签 B\t已收到（[^）]*来自 SolLedger 扩展）/));
  check('W6：按人去重后算出队友 2 个、好友 2 个、重合 1 个', () => assert.match(recvText, /队友 2 个、好友 2 个，重合 1 个/));
  check('接收页：页面上没有模拟的 ID / 昵称', () => { for (const f of FORBIDDEN) assert.ok(!recvText.includes(f), f); });

  // ---- 网站一侧只能读和清：拿到的是带本机密钥的代号（不是原始哈希），也不能发起取数 ----
  const askSite = (sessionId, action, probe) => b.evalIn(sessionId, `new Promise(res => {
    const id = 'probe-' + Math.random();
    addEventListener('message', e => { if (e.data && e.data.type === 'dfp-ext-response' && e.data.id === id) res(e.data); });
    postMessage({ type: 'dfp-ext-request', id, action: '${action}', probe: '${probe || ''}' }, location.origin);
    setTimeout(() => res('no-response'), 3000);
  })`);
  const viaSite = await askSite(r.sessionId, 'get-reports');
  check('网站拿到的是代号：个数对得上，但和扩展里存的原始哈希一个都不一样', () => {
    const raw = A.result.privateOnly.teammateIdHashes;
    const got = viaSite.resp.A.privateOnly.teammateIdHashes;
    assert.equal(got.length, raw.length);
    assert.ok(got.every(h => /^[0-9a-f]{12}$/.test(h) && !raw.includes(h)), JSON.stringify({ raw, got }));
  });
  const viaSite2 = await askSite(r.sessionId, 'get-reports');
  check('网站两次读取的代号一样（W6 跨读取也能比）', () => assert.deepEqual(viaSite2.resp.A.privateOnly, viaSite.resp.A.privateOnly));
  const pagesBefore = (await b.targets()).filter(t => t.type === 'page').length;
  const runFromSite = await askSite(r.sessionId, 'run', 'A');
  await sleep(1500);
  const pagesAfter = (await b.targets()).filter(t => t.type === 'page').length;
  check('网站发「run」：没有回应，也没有打开官方页面', () => {
    assert.equal(runFromSite, 'no-response');
    assert.equal(pagesAfter, pagesBefore);
  });
  const inst = await b.openPage('http://127.0.0.1:8766/install.html');
  await b.waitFor(inst.sessionId, `document.readyState === 'complete'`);
  await sleep(500);
  const fromInstall = await askSite(inst.sessionId, 'get-reports');
  check('接收页以外的本机页面（install.html）没有扩展通道', () => assert.equal(fromInstall, 'no-response'));
  await b.send('Target.closeTarget', { targetId: inst.targetId });

  // ---- 普通网页（不在 site-bridge 的范围里）没法跟扩展说话 ----
  const m = await b.openPage('http://127.0.0.1:8770/helper/df/score/');
  await b.waitFor(m.sessionId, `document.readyState === 'complete'`);
  const hasRuntime = await b.evalIn(m.sessionId, `typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
  check('别的网页：没有 chrome.runtime.sendMessage 可用', () => assert.equal(hasRuntime, false));
  const forged = await b.evalIn(m.sessionId, `new Promise(res => {
    addEventListener('message', e => { if (e.data && e.data.type === 'dfp-ext-response') res('got-response'); });
    postMessage({ type: 'dfp-ext-request', id: 'x', action: 'get-reports' }, location.origin);
    setTimeout(() => res('no-response'), 2000);
  })`);
  check('别的网页：照着接收页的格式发请求也没有回应', () => assert.equal(forged, 'no-response'));
  await b.send('Target.closeTarget', { targetId: m.targetId });

  // ---- 翻页时才要人机校验：前面的 W1 / W2 照样拿到，被拦就停 ----
  const D = await runViaPopup('A', '?captcha=paging');
  check('扩展 · 翻页被拦：7 个接口仍然调通，标记 captcha，被拦之后不再请求', () => {
    assert.deepEqual(Object.values(D.result.report.findings.W1), Array(7).fill('ok'));
    assert.equal(D.result.report.stop, 'captcha');
    const steps = D.result.report.steps;
    assert.equal(steps[steps.length - 1].code, 8000022);
  });
  check('扩展 · 翻页被拦：弹窗提示人机校验', () => assert.match(D.popupText, /人机校验/));

  // ---- 后台跑到一半被浏览器停掉（浏览器关掉重开、扩展重新加载、后台崩溃都是这样）：弹窗不能永远卡在「正在跑」 ----
  {
    const p = await b.openPage(popupUrl);
    await b.waitFor(p.sessionId, `document.readyState === 'complete' && !!(chrome.runtime && chrome.runtime.sendMessage)`);
    await b.evalIn(p.sessionId, `chrome.storage.local.remove(['status_B', 'result_B']).then(() => true)`);
    await b.evalIn(p.sessionId, `chrome.runtime.sendMessage({ type: 'run', probe: 'B' }).catch(() => {}); true`);
    await sleep(3000);
    await b.send('ServiceWorker.enable', {}, p.sessionId);
    await b.send('ServiceWorker.stopAllWorkers', {}, p.sessionId);
    await sleep(1000);
    await b.send('Target.closeTarget', { targetId: p.targetId });
    const q = await b.openPage(popupUrl);
    await b.waitFor(q.sessionId, `chrome.storage.local.get('status_B').then(s => s.status_B && s.status_B.state === 'error')`, 10000).catch(() => {});
    await sleep(300);
    const st = await b.evalIn(q.sessionId, `chrome.storage.local.get('status_B').then(s => s.status_B)`);
    const disabled = await b.evalIn(q.sessionId, `document.querySelector('.card[data-probe="B"] [data-act="run"]').disabled`);
    check('后台中途被停：状态改成「中断」，「跑验证 B」按钮能再点', () => {
      assert.equal(st && st.error, 'interrupted', JSON.stringify(st));
      assert.equal(disabled, false);
    });
    await b.send('Target.closeTarget', { targetId: q.targetId });
  }

  // ---- 书签 B：Milo 不回调（弹验证码 / 登录框）→ 15 秒后停，后面的请求一个都不发 ----
  const F = await runViaPopup('B', '?stall=2');
  check('扩展 · Milo 不回调：停下且只发了 2 个请求', () => {
    assert.equal(F.result.report.stop, 'captcha_or_timeout');
    assert.equal(F.result.report.steps.length, 2);
  });
} catch (e) {
  fail('运行出错：' + e.message);
} finally {
  await b.close();
}
process.exit(report() ? 1 : 0);
