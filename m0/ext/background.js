/* ============================================================================
 * SolLedger 数据助手 · 后台（MV3 service worker）
 *
 * 做的事：用户在扩展弹窗里点「跑验证」时，在官方页面里跑取数脚本（和书签同一份代码；现在只有 A，验证 B 暂缓），
 * 把「只含结构的报告」和仅本机用的哈希存进扩展自己的存储；我们的网站只能来读（哈希换成带本机密钥的代号）和清空，
 * 不能发起取数。
 *
 * 不做的事：扩展自己不向任何接口发请求，也不读任何 Cookie。请求都由官方页面里的脚本同源发出，
 * Origin / Referer 由浏览器真实给出。
 * ========================================================================== */
import { CONFIG } from './config.js';

const PROBES = Object.keys(CONFIG.targets);   // 现在只有 'A'
const running = new Map();   // probe -> Promise，同一个书签同时只跑一份
let clearGen = 0;            // 每清空一次加 1：清空之前就开始跑的那次，跑完不再把结果写回来

// 全局变量在 service worker 被停掉时会丢。浏览器关掉重开、扩展被重新加载、后台被回收之后，
// 存储里残留的「正在跑」其实已经没人在跑了：后台每次启动时把它改成「中断」，否则弹窗的「跑验证」按钮一直是灰的
chrome.storage.local.get(PROBES.map(p => `status_${p}`)).then(s => {
  for (const p of PROBES) {
    const st = s[`status_${p}`];
    if (st && st.state === 'running' && !running.has(p)) setStatus(p, { state: 'error', error: 'interrupted' });
  }
});

/** 等标签页加载完成（最多 30 秒） */
function waitComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error('官方页面 30 秒没加载完')); }, 30000);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { done(); resolve(); } };
    function done() { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(t => { if (t.status === 'complete') { done(); resolve(); } }, e => { done(); reject(e); });
  });
}

/** 找已经打开的官方页面；没有就新开一个（放在前台：没登录的话用户能直接在那里登录） */
async function openTarget(target, query) {
  if (!query) {
    const tabs = await chrome.tabs.query({ url: target.match });
    if (tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      await chrome.windows.update(tabs[0].windowId, { focused: true });   // 在别的窗口里的话也带到前面，面板、验证码用户才看得见
      await waitComplete(tabs[0].id);
      return tabs[0].id;
    }
  }
  const tab = await chrome.tabs.create({ url: target.url + (query || ''), active: true });
  await waitComplete(tab.id);
  return tab.id;
}

/** 取数脚本跑在官方页面里，它的返回值要当成不可信数据：只收认识的字段 */
function sanitize(probe, out) {
  if (!out || typeof out !== 'object') return { error: 'no_result' };
  if (out.error) return { error: String(out.error).slice(0, 120) };
  const r = out.report;
  if (out.probe !== probe || !r || typeof r !== 'object' || r.tool !== 'sol-ledger-m0') return { error: 'bad_result' };
  // 报告来自官方页面的主世界，页面脚本能改它：限大小（防把扩展存储塞满；storage.local 在 Chrome 113 及以前只有 5MB，A、B 各 2MB 以内放得下），
  // 停止原因只收短字符串（弹窗、接收页拿它显示）。真实报告由 dfpShape 限深、数组只取前 8 个，正常远小于这个上限
  let json;
  try { json = JSON.stringify(r); } catch (e) { return { error: 'bad_result' }; }
  if (json.length > 2000000) return { error: 'result_too_big' };
  if (r.stop != null && (typeof r.stop !== 'string' || r.stop.length > 60)) return { error: 'bad_result' };
  const hashes = list => (Array.isArray(list) ? list.filter(h => typeof h === 'string' && /^[0-9a-f]{12}$/.test(h)).slice(0, 500) : []);
  const p = out.privateOnly || {};
  return {
    report: JSON.parse(json),
    leaked: Number.isInteger(out.leaked) ? out.leaked : null,
    privateOnly: { teammateIdHashes: hashes(p.teammateIdHashes) },
  };
}

async function setStatus(probe, status) {
  await chrome.storage.local.set({ [`status_${probe}`]: Object.assign({ at: Date.now() }, status) });
}

async function run(probe, query) {
  const target = CONFIG.targets[probe];
  if (!target) return { error: 'unknown_probe' };
  if (running.has(probe)) return { error: 'busy' };
  // 取数要 10~40 秒。service worker 闲置 30 秒会被浏览器停掉，跑的过程中定时调一个扩展接口保活
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(); }, 20000);
  const gen = clearGen;
  const cleared = () => gen !== clearGen;
  const job = (async () => {
    await setStatus(probe, { state: 'running' });
    try {
      const tabId = await openTarget(target, CONFIG.dev ? query : '');
      // host_permissions 里的路径浏览器不认（实测写 /helper/* 照样能注入同站 /cp/weekly/），
      // 注入前再核一次这个标签现在的地址：跳去了同站别的页（登录跳转、用户点走）就不跑
      const now = await chrome.tabs.get(tabId);
      if (!now.url || !now.url.startsWith(target.match.slice(0, -1))) throw new Error('官方页面已经跳到别的地址，没有运行');
      // 取数脚本卡住（官方接口一直不回包，fetch 没有超时）时 executeScript 永远不返回；浏览器对单个扩展 API 调用
      // 最多等 5 分钟就停掉后台，状态会永远停在「正在跑」。自己先设 4 分钟上限：要小于浏览器的 5 分钟，
      // 又要给慢的时候留足余量（A 正常约 40 秒、B 约 10~25 秒，但本机负载高时模拟环境的 A 实测要 111 秒）
      const exec = chrome.scripting.executeScript({ target: { tabId }, files: [`probe-${probe}.js`], world: 'MAIN' });
      exec.catch(() => {});   // 超时之后它才失败的话，别再报「未处理的拒绝」
      let timer;
      const [res] = await Promise.race([exec, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 240000); })])
        .finally(() => clearTimeout(timer));
      const out = sanitize(probe, res && res.result);
      if (cleared()) return { error: 'cleared' };   // 跑的过程中用户点了清空：这次的结果不要了
      if (out.error) { await setStatus(probe, { state: 'error', error: out.error }); return out; }
      await chrome.storage.local.set({ [`result_${probe}`]: Object.assign({ at: Date.now() }, out) });
      await setStatus(probe, { state: 'done', stop: out.report.stop || null });
      return { ok: true, stop: out.report.stop || null };
    } catch (e) {
      const msg = String(e && e.message || e);
      // 浏览器给的是英文原话，换成用户看得懂的下一步
      const error = /Cannot access contents|must request permission/.test(msg) ? '官方页面跳到了别的地址（多半是登录页）：在那个标签页里登录、回到官方页面后再点一次'
        : /was removed|No tab with id|tab was closed/i.test(msg) ? '跑的过程中官方页面被关掉或刷新了，这次没拿到结果：重新点一次，跑完之前别动那个页面'
        : /showing error page/i.test(msg) ? '官方页面没打开（网络错误）：确认能正常访问后再点一次'
        : msg === 'timeout' ? '官方页面 4 分钟还没跑完，已放弃：刷新官方页面后再点一次'
        : msg.slice(0, 160);
      if (!cleared()) await setStatus(probe, { state: 'error', error });
      return { error };
    } finally {
      clearInterval(keepAlive);
      running.delete(probe);
    }
  })();
  running.set(probe, job);
  return job;
}

async function getReports() {
  const s = await chrome.storage.local.get(PROBES.map(p => `result_${p}`));
  return Object.fromEntries(PROBES.map(p => [p, s[`result_${p}`] || null]));
}

/** 消息只收两处来的：扩展自己的弹窗，和我们自己的网站（site-bridge.js 只注入在那里） */
function senderKind(sender) {
  if (sender.id !== chrome.runtime.id) return null;
  if (sender.url && sender.url.startsWith(chrome.runtime.getURL('popup.html'))) return 'popup';
  if (sender.tab && sender.url && CONFIG.siteOrigins.includes(new URL(sender.url).origin)) return 'site';
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const kind = senderKind(sender);
  if (!kind || !msg || typeof msg.type !== 'string') return false;
  const reply = p => { p.then(sendResponse, e => sendResponse({ error: String(e && e.message || e) })); return true; };
  // 取数会用用户的登录态向官方连发约 25 个请求、还会把官方页切到前台：只许用户在扩展弹窗里亲手点。
  // 网站一侧（同源的其他页面、页面里的第三方脚本、别的扩展的 content script 都能借 site-bridge 发消息）只能读和清
  if (msg.type === 'run' && kind === 'popup' && PROBES.includes(msg.probe)) {
    // 测试参数（?captcha=paging 之类）只在开发版里生效，正式版一律忽略
    const query = CONFIG.dev && typeof msg.query === 'string' && /^\?[\w=&]{0,60}$/.test(msg.query) ? msg.query : '';
    return reply(run(msg.probe, query));
  }
  if (msg.type === 'get-reports') return reply(getReports().then(r => (kind === 'site' ? forSite(r) : r)));
  // 清空只清报告和状态，给网站算代号用的随机密钥留着：不然接收页里留着的旧 A 和新跑的 B 代号对不上，W6 会误报 0 重合
  if (msg.type === 'clear') clearGen += 1;
  if (msg.type === 'clear') return reply(chrome.storage.local.remove(PROBES.flatMap(p => [`status_${p}`, `result_${p}`])).then(() => ({ ok: true })));
  return false;
});

/* 给网站的哈希再用本机随机密钥哈希一次。网站那头靠 window.postMessage 整页广播：页面里任何脚本、别的扩展的
 * content script 都能收到回复、也能自己来要；原哈希是公开固定盐 + 48 位截断，数字 ID 能穷举回去。
 * 换成带密钥的代号后，同一个人在 A、B 里、前后几次读取里代号都一样（W6 照算），但没有密钥推不回 ID。
 * 密钥只在扩展自己的存储里，从不交出去 */
let siteKeyP = null;
function siteKey() {
  return siteKeyP || (siteKeyP = chrome.storage.local.get('siteKey').then(async s => {
    if (s.siteKey) return s.siteKey;
    const k = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ siteKey: k });
    return k;
  }));
}
async function forSite(r) {
  const key = await siteKey();
  const alias = async h => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key + '|' + h))).slice(0, 6), b => b.toString(16).padStart(2, '0')).join('');
  const relabel = async (x, k) => x && Object.assign({}, x, { privateOnly: { [k]: await Promise.all(((x.privateOnly && x.privateOnly[k]) || []).map(alias)) } });
  return { A: await relabel(r.A, 'teammateIdHashes') };
}
