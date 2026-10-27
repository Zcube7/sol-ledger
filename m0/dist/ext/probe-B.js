(async () => {
const DFP_MODE = 'ext';
/* ============================================================================
 * M0 验证书签 · 共用部分
 *
 * 原则：报告里只有「数据长什么样」（字段名、类型、长度、条数、错误码），没有具体的值。
 * 具体的值只在本页内存里用一下就丢；对外（复制 / 下载 / 交给本地接收页）只给结构。
 * 不读取、不保存、不发送任何 Cookie 值、access_token、tgp_ticket。
 * ========================================================================== */

const DFP_MAX_DEPTH = 8;
const DFP_MOCK_ORIGIN = 'http://127.0.0.1:8770';

/** 是不是本地模拟页：只认「严格等于 true」+ 模拟页 origin。
 *  只判真值的话，官方页里的 <div id="__DFP_TEST_ORIGIN_OK">（DOM clobbering）或页面脚本就能打开测试开关 */
function dfpIsMock() {
  return window.__DFP_TEST_ORIGIN_OK === true && location.origin === DFP_MOCK_ORIGIN;
}

/** 字段名本身也可能是值（按 openid / roomId / 昵称当键的字典）：不像字段名的键（非 ASCII 标识符、超长、数字 4 个以上）只留形态 */
function dfpSafeKey(k) {
  return /^[A-Za-z_$][\w$.\-]{0,47}$/.test(k) && (k.match(/\d/g) || []).length < 4 ? k : `<键:${dfpStrKind(k)}>`;
}

/** 一组字段名，逐个过 dfpSafeKey、去重、排序 */
function dfpSafeKeys(obj) {
  return obj && typeof obj === 'object' ? [...new Set(Object.keys(obj).map(dfpSafeKey))].sort() : [];
}

/** 浏览器和主版本号就够排查了；完整 UA 带系统版本、内嵌客户端版本，算一种指纹 */
function dfpShortUa() {
  return (navigator.userAgent.match(/(Edg|OPR|Firefox|Chrome|Version)\/\d+/) || ['other'])[0];
}

function dfpTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 字符串只描述形态，不带内容 */
function dfpStrKind(s) {
  if (s === '') return 'str(0)';
  if (/^\d+$/.test(s)) return `digits(${s.length})`;
  if (/^-?\d+\.\d+$/.test(s)) return 'decimal-str';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?/.test(s)) return 'datetime-str';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return 'date-str';
  if (/^\d{8}$/.test(s)) return 'yyyymmdd-str';
  if (/^https?:\/\//.test(s)) return 'url-str';
  const t = s.trim();
  if ((t[0] === '[' || t[0] === '{') && t.length > 1) {
    try { JSON.parse(t); return 'json-str'; } catch (e) { /* 不是 JSON */ }
  }
  const seps = [',', ';', '|', '#', ':', '-'].filter(c => s.includes(c));
  if (s.length > 16 && seps.length) return `delim-str(${s.length},sep=${seps.join('')})`;
  return `str(${s.length})`;
}

/** 把任意 JSON 值变成「结构摘要」 */
function dfpShape(v, depth = 0) {
  const t = dfpTypeOf(v);
  if (t === 'string') return dfpStrKind(v);
  if (t === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (t === 'boolean') return 'bool';
  if (t === 'null' || t === 'undefined') return t;
  if (t === 'array') {
    if (!v.length) return 'array[0]';
    if (depth >= DFP_MAX_DEPTH) return `array[${v.length}]`;
    return { [`array[${v.length}]`]: dfpMergeShapes(v.slice(0, 8).map(x => dfpShape(x, depth + 1))) };
  }
  if (t === 'object') {
    if (depth >= DFP_MAX_DEPTH) return 'object{…}';
    const out = {};
    for (const k of Object.keys(v).sort()) {
      // 不像字段名的键只留形态（见 dfpSafeKey），同形态的多个键收成一个、结构取并集
      const key = dfpSafeKey(k);
      const s = dfpShape(v[k], depth + 1);
      out[key] = Object.prototype.hasOwnProperty.call(out, key) ? dfpMergeShapes([out[key], s]) : s;
    }
    return out;
  }
  return t;
}

/** 合并数组里多个元素的结构：字段取并集，不是每个元素都有的字段名后面加「?」 */
function dfpMergeShapes(list) {
  if (list.length === 1) return list[0];
  const isObj = s => s && typeof s === 'object';
  if (list.every(isObj)) {
    const keys = [...new Set(list.flatMap(s => Object.keys(s)))].sort();
    const out = {};
    for (const k of keys) {
      const present = list.filter(s => k in s);
      const merged = dfpMergeShapes(present.map(s => s[k]));
      out[present.length < list.length ? `${k}?` : k] = merged;
    }
    return out;
  }
  const seen = [];
  for (const s of list) {
    const key = typeof s === 'string' ? s : JSON.stringify(s);
    if (!seen.includes(key)) seen.push(key);
  }
  return seen.length === 1 ? list[0] : seen.join(' | ');
}

/** 统计一组字符串的「形态」分布，例如 { 'digits(19)': 2, 'digits(4)': 1 } */
function dfpKindHistogram(values) {
  const h = {};
  for (const v of values) {
    const k = v === undefined || v === null ? String(v) : (typeof v === 'string' ? dfpStrKind(v) : dfpTypeOf(v));
    h[k] = (h[k] || 0) + 1;
  }
  return h;
}

/** 找出对象里「像物品 / 带出 / 价格」的数组字段，返回路径和元素结构 */
function dfpFindItemLike(v, path = '', out = []) {
  if (!v || typeof v !== 'object' || out.length > 20) return out;
  if (Array.isArray(v)) {
    v.slice(0, 3).forEach((x, i) => dfpFindItemLike(x, `${path}[${i}]`, out));
    return out;
  }
  for (const k of Object.keys(v)) {
    const sk = dfpSafeKey(k);   // 路径里的键也可能是 ID / 昵称
    const p = path ? `${path}.${sk}` : sk;
    if (/item|carry|object|loot|collect|prop|price|red|award|gain/i.test(k)) {
      const val = v[k];
      out.push({ path: p, shape: Array.isArray(val) ? `array[${val.length}]` : dfpShape(val, DFP_MAX_DEPTH - 2) });
    }
    dfpFindItemLike(v[k], p, out);
  }
  return out;
}

/** 找出对象里哪些字段的值等于 target（用来认「哪个字段是自己的 ID」），只返回字段名 */
function dfpKeysEqualTo(obj, target) {
  if (!obj || typeof obj !== 'object' || target == null) return [];
  return Object.keys(obj).filter(k => obj[k] != null && String(obj[k]) === String(target));
}

function dfpSleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 只取某个 Cookie 的值（只用于 tgp_user_type 这种标记位，不用于任何凭据） */
function dfpCookieFlag(name) {
  const hit = document.cookie.split('; ').find(c => c.startsWith(name + '='));
  return hit ? hit.slice(name.length + 1) : null;
}

/** 只判断某个 Cookie 名字是否存在，不读值 */
function dfpCookiePresent(name) {
  return document.cookie.split('; ').some(c => c.startsWith(name + '='));
}

/** SHA-256 前 12 位十六进制（只用于交给本机接收页做重合比对，不进复制 / 下载的报告） */
async function dfpHash12(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dfp-m0|' + text));
  return [...new Uint8Array(buf)].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 报告对外前的自检：观察到的标识值（openid、昵称、roomId…）一个都不许出现在报告里。
 *  在对象层面逐个字符串（含字段名）替换：不会把 JSON 里的数字 / null / true 换坏，也不受 JSON 转义（引号、反斜杠、孤立代理项）影响；
 *  短于 8 个字符、两端是字母或数字的值，要求边界外不紧挨同类字符，免得昵称「Get」「666」把字段名、标签误伤 */
function dfpScrub(reportJson, secrets) {
  let leaked = 0;
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cls = c => (/\d/.test(c) ? '\\d' : /[A-Za-z_]/.test(c) ? '[A-Za-z_]' : '');
  const vals = [...new Set([...secrets].filter(s => s !== undefined && s !== null).map(String))].filter(s => s.length >= 3);
  const longVals = new Set(vals.filter(s => s.length >= 8));
  const pats = vals
    .sort((a, b) => b.length - a.length)
    .map(s => {
      const pre = s.length < 8 ? cls(s[0]) : '', post = s.length < 8 ? cls(s[s.length - 1]) : '';
      return new RegExp(`${pre ? `(?<!${pre})` : ''}${esc(s)}${post ? `(?!${post})` : ''}`, 'g');
    });
  const clean = str => pats.reduce((t, re) => t.replace(re, () => { leaked += 1; return '[已移除]'; }), str);
  const walk = v => {
    if (typeof v === 'string') return clean(v);
    // 数字只在「8 位以上且和观察到的值完全相同」时替换（ID 被当成数字漏进报告）；条数、错误码、耗时不会被昵称「666」之类误伤
    if (typeof v === 'number') { if (longVals.has(String(v))) { leaked += 1; return '[已移除]'; } return v; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[clean(k)] = walk(v[k]);
      return o;
    }
    return v;   // 布尔 / null
  };
  return { text: JSON.stringify(walk(JSON.parse(reportJson)), null, 2), leaked };
}

/** 页面右上角的结果面板（放在 Shadow DOM 里，不受官方页面样式影响，也不改官方页面） */
function dfpMakePanel(title) {
  const host = document.createElement('div');
  // 同一个页面里跑第二次（扩展复用已打开的官方标签页，或再点一次书签）时先收掉上一次的面板，免得两块叠在一起
  const old = document.getElementById('dfp-m0-panel');
  if (old) old.remove();
  host.id = 'dfp-m0-panel';
  host.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box{width:420px;max-height:80vh;display:flex;flex-direction:column;background:#111827;color:#e5e7eb;
           font:13px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;border-radius:10px;
           box-shadow:0 8px 30px rgba(0,0,0,.45);border:1px solid #374151}
      .hd{padding:10px 12px;font-weight:600;border-bottom:1px solid #374151;display:flex;justify-content:space-between}
      .log{padding:8px 12px;overflow:auto;flex:1;white-space:pre-wrap}
      .ok{color:#86efac}.warn{color:#fcd34d}.err{color:#fca5a5}.dim{color:#9ca3af}
      .ft{padding:8px 12px;border-top:1px solid #374151;display:flex;gap:8px;flex-wrap:wrap}
      button{background:#374151;color:#f9fafb;border:0;border-radius:6px;padding:6px 10px;cursor:pointer;font:inherit}
      button:hover{background:#4b5563} button:disabled{opacity:.4;cursor:default}
      .note{padding:0 12px 8px;color:#9ca3af;font-size:12px}
    </style>
    <div class="box">
      <div class="hd"><span></span><span class="dim ver"></span></div>
      <div class="log"></div>
      <div class="note">报告只含字段名、类型、条数和错误码，不含你的 ID、昵称、战绩数值，也不含任何登录凭据。</div>
      <div class="ft">
        <button data-act="copy" disabled>复制报告</button>
        <button data-act="download" disabled>下载报告</button>
        <button data-act="handoff" disabled>测试交接（W7）</button>
        <button data-act="close">关闭</button>
      </div>
    </div>`;
  root.querySelector('.hd span').textContent = title;
  // 扩展模式下结果直接交给扩展，不需要「测试交接」按钮（DFP_MODE 由打包脚本在外层声明）
  if (typeof DFP_MODE !== 'undefined' && DFP_MODE === 'ext') root.querySelector('button[data-act="handoff"]').remove();
  document.documentElement.appendChild(host);
  const logEl = root.querySelector('.log');
  const handlers = {};
  if (dfpIsMock()) window.__DFP_TEST_HOOKS = handlers;   // 只在本地模拟页里暴露，供自动化测试点按钮
  root.querySelector('.ft').addEventListener('click', e => {
    const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
    if (!act) return;
    if (act === 'close') { host.remove(); return; }
    if (handlers[act]) handlers[act]();
  });
  return {
    setVersion(v) { root.querySelector('.ver').textContent = v; },
    log(text, cls = '') {
      const line = document.createElement('div');
      if (cls) line.className = cls;
      line.textContent = text;
      logEl.appendChild(line);
      logEl.scrollTop = logEl.scrollHeight;
    },
    enable(act, fn) {
      handlers[act] = fn;
      const b = root.querySelector(`button[data-act="${act}"]`);
      if (b) b.disabled = false;
    },
  };
}

/** 复制到剪贴板：优先用 Clipboard API，失败退回到临时文本框 */
async function dfpCopy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 退回 */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

function dfpDownload(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * W7：把报告交给本机接收页（http://127.0.0.1:8766/receiver.html）。
 * 用 window.open 打开接收页，等它回「ready」，再用 postMessage 把报告（含仅本机用的哈希）发过去。
 * targetOrigin 写死成接收页的 origin，别的页面收不到。
 */
function dfpHandoff(payload, panel) {
  // 去向写死成本机接收页，不再读页面全局 __DFP_RECEIVER：官方页里的脚本或 <a id="__DFP_RECEIVER" href="https://…">（DOM clobbering）都能改它，
  // 报告和 privateOnly 哈希就会交给别的页面。只有本地模拟页（127.0.0.1:8770）多带 ?test=1
  const url = 'http://127.0.0.1:8766/receiver.html' + (dfpIsMock() ? '?test=1' : '');
  const origin = new URL(url).origin;
  const win = window.open(url, 'dfp_m0_receiver');
  if (!win) { panel.log('W7：弹窗被浏览器拦了。请允许本站弹窗后再点一次。', 'err'); return; }
  let done = false;
  const onMsg = e => {
    if (e.origin !== origin || e.source !== win || !e.data || e.data.type !== 'dfp-ready') return;
    window.removeEventListener('message', onMsg);
    done = true;
    win.postMessage({ type: 'dfp-report', payload }, origin);
    panel.log('W7：已把报告交给本机接收页，请到接收页查看。', 'ok');
  };
  window.addEventListener('message', onMsg);
  setTimeout(() => {
    if (!done) {
      window.removeEventListener('message', onMsg);
      panel.log('W7：10 秒内没等到接收页回应。确认已按说明启动本机接收页（node m0/serve.mjs）。', 'err');
    }
  }, 10000);
}

/* ============================================================================
 * M0 验证书签 B · 在官方周报页（https://df.qq.com/cp/weekly20250821/index.html）上运行
 *
 * 借用官方页面自己的 Milo.emit 发请求：登录信息由官方的 Milo 自己带，
 * 脚本不读、不拼、不发任何 access_token / openid / Cookie 值。
 * 只查烽火地带（resourceType=sol、weekly.sol.*）。遇到未登录就停，不重试。
 * 验证项：W4（能不能借 Milo）、W5（各方法能不能取到数）、W6（好友 ID 和对局 ID 是否同一套，在本机接收页里比）。
 * ========================================================================== */

const DFP_VERSION = 'm0-b-2';
const DFP_ORIGIN = 'https://df.qq.com';
const ACT_ID = '21_3LXYAj';
const WEEKLY_URL = 'https://df.qq.com/cp/weekly20250821/index.html';

if (location.origin !== DFP_ORIGIN && !dfpIsMock()) {
  if (DFP_MODE !== 'ext') alert('请在官方周报页上点这个书签：\n' + WEEKLY_URL + '\n（先在那个页面用 QQ 登录）');
  return { error: 'wrong_page' };
}
if (window.__DFP_RUNNING) {
  if (DFP_MODE !== 'ext') alert('验证已经在运行了，请等它结束。');   // 扩展模式不弹框：alert 会卡住官方页面，原因由扩展弹窗显示
  return { error: 'already_running' };
}
window.__DFP_RUNNING = true;

const GAP_MS = 900;
const panel = dfpMakePanel('M0 验证 · 书签 B（官方周报页）');
panel.setVersion(DFP_VERSION);
const report = {
  tool: 'sol-ledger-m0', probe: 'B-ams', version: DFP_VERSION,
  page: location.origin + location.pathname,
  ua: dfpShortUa(),
  steps: [], findings: {}, stop: null,
};
const secrets = new Set();
const privateOnly = { friendIdHashes: [] };
let stopReason = null;

/* ---------- 1. 页面里有没有可借用的 Milo（W4） ---------- */
const milo = window.Milo;
report.findings.W4 = {
  miloGlobal: !!milo,
  miloEmit: !!(milo && typeof milo.emit === 'function'),
  // 只列名字，不读值
  windowNamesLikeAms: Object.keys(window).filter(k => /milo|emit|ams|flow|getLastWeekDate/i.test(k)).slice(0, 30).map(dfpSafeKey),
  loginCookieNamesPresent: Object.fromEntries(
    ['openid', 'access_token', 'acctype', 'appid', 'ieg_ams_session_token', 'ieg_ams_token'].map(n => [n, dfpCookiePresent(n)])),
};
if (!report.findings.W4.miloEmit) {
  stopReason = 'no_milo';
  panel.log('这个页面上没有可用的 Milo.emit。请打开官方周报页并用 QQ 登录后再点：\n' + WEEKLY_URL, 'err');
}

/** 照官方周报页 request() 的格式拼 sData；成功 / 失败都只留结构 */
function emit(label, token, method, params, source) {
  return new Promise(resolve => {
    if (stopReason) { resolve(null); return; }
    // NoOapI 照 H5 工具助手 doFlowEmit2：sData 只有 method / source / param，param 里只放业务参数；
    // 它自己的 emit 会把 source 改成 5（n&&n.source&&(s.sData.source=5)），所以官方实际发的是 5
    const sData = token === 'NoOapI' ? { method, source: 5, param: JSON.stringify(params) } : Object.assign({ source: String(source), sArea: 36, method }, params,
      { param: JSON.stringify(Object.assign({ source: String(source), method }, params)) });
    const t0 = performance.now();
    let settled = false;
    const finish = (ok, res) => {
      if (settled) return;
      settled = true;
      const step = {
        label, token, method, ok,
        ms: Math.round(performance.now() - t0),
        iRet: res && res.iRet !== undefined ? res.iRet : (res && res.ret !== undefined ? res.ret : null),
        // Milo 失败回调里的下一层错误码（官方 utils.js：iRet -9999 且 details.retCode -1001 是登录态问题）
        retCode: res && res.details && res.details.retCode !== undefined ? res.details.retCode : undefined,
        // 先把带数字的长串（QQ 号、openid、token、URL 参数）换成形态再截断：书签 B 不知道自己的 QQ 号 / openid，自检兜不住；截断还会留下半个 ID
        sMsg: res && res.sMsg ? String(res.sMsg).replace(/[\w\-+/=.@%]{5,}/g, m => (/\d/.test(m) ? `‹${dfpStrKind(m)}›` : m)).slice(0, 60) : undefined,
        // 业务层的码（H5 工具助手判 jData.data.code），W5 没取到时靠它分清是「方法不通」还是「没数据」
        bizCode: (o => (o && typeof o === 'object' ? (o.code !== undefined ? o.code : (o.ret !== undefined ? o.ret : null)) : null))(res && res.details && res.details.jData && res.details.jData.data),
        shape: res ? dfpShape(res) : null,
      };
      report.steps.push(step);
      panel.log(`${ok ? '✓' : '✗'} ${label}：iRet ${step.iRet}`, ok ? 'ok' : 'err');
      if (step.iRet === 'timeout' || String(step.iRet) === '501') {
        // Milo 遇到 iRet 501 会自己弹人机验证、验证后自动重发，期间不调 success / fail（milo.min.js「[Milo iRet 501]:Need Cap」→ doCap → 重发），
        // 所以这里只会等到 15 秒超时。超时一律当成人机验证 / 登录框：立刻停，后面的请求一个都不发
        stopReason = 'captcha_or_timeout';
        panel.log('15 秒没有回应（多半是官方弹出了人机验证或登录框）。已停止，不再发后面的请求。完成验证后再点书签。', 'warn');
      } else if (String(step.iRet) === '101') {
        if (token === 'NoOapI' && report.steps.some(s => s.token === 'KfXJwH' && s.ok)) {
          // 几秒前周报页自己的 KfXJwH 还能用，登录态大概率没问题；NoOapI 的 101 原因未知
          //（H5 工具助手调 NoOapI 时会在 sData 里显式带 acctype/appid/access_token/openid，按原则不带）。
          // 记为「NoOapI 在周报页上借 Milo 不通」，不让用户反复重新登录；后面的 NoOapI 也不再发
          stopReason = 'noOapI_101_after_kfxjwh_ok';
          report.findings.noOapI = { iRet: 101, kfxjwhOkBefore: true };
          panel.log('NoOapI 这组方法返回 101，但前面周报接口刚刚成功，你的登录大概率没问题，不用重新登录。已停止，记为「NoOapI 在周报页上不通」。', 'warn');
          resolve(res || null);
          return;
        }
        stopReason = 'not_login';
        panel.log('官方说登录态失效（101）。请在周报页重新用 QQ 登录后再点书签。', 'warn');
      } else if (String(step.iRet) === '-9999') {
        // Milo 的通用失败；官方周报页遇到 details.retCode -1001 时按登录失效处理。不管哪种都先停，不连着往下发
        stopReason = step.retCode === -1001 ? 'not_login' : 'milo_fail';
        panel.log(step.retCode === -1001
          ? '官方说登录态失效（-9999 / -1001）。请在周报页重新用 QQ 登录后再点书签。'
          : `官方请求失败（iRet -9999，retCode ${step.retCode}）。已停止，不再发后面的请求。`, 'warn');
      }
      resolve(res || null);
    };
    setTimeout(() => finish(false, { iRet: 'timeout' }), 15000);
    try {
      milo.emit({ actId: ACT_ID, token, sData, success: r => finish(true, r), fail: r => finish(false, r) });
    } catch (e) {
      finish(false, { iRet: 'throw', sMsg: String(e && e.message || e) });
    }
  });
}

/** Milo 的回包里业务数据的位置不固定，这里按常见路径找 */
function dataOf(res) {
  if (!res) return null;
  const c = [
    res.details && res.details.jData && res.details.jData.data && res.details.jData.data.data,
    res.jData && res.jData.data && res.jData.data.data,
    res.data && res.data.data && res.data.data.data,
  ];
  // 业务码不为 0（H5 工具助手判的是 jData.data.code）就算没取到，免得把失败回包里的空对象当成「取到了」
  const outer = [res.details && res.details.jData && res.details.jData.data, res.jData && res.jData.data, res.data && res.data.data]
    .find(x => x && typeof x === 'object');
  if (outer && ((outer.code !== undefined && String(outer.code) !== '0') || (outer.ret !== undefined && String(outer.ret) !== '0'))) return null;
  return c.find(x => x !== undefined && x !== null) || null;
}

function lastSunday() {
  if (typeof window.getLastWeekDate === 'function') {
    try { return { value: window.getLastWeekDate('beforeWeek'), from: 'official' }; } catch (e) { /* 退回 */ }
  }
  // 照官方 utils.js getLastWeekDate('beforeWeek') 的算法：上一周的周日
  const d = new Date(Date.now() - 7 * 864e5);
  const day = d.getDay();
  const sun = new Date(d.getTime() + (day === 0 ? 0 : 7 - day) * 864e5);
  const p = n => String(n).padStart(2, '0');
  return { value: `${sun.getFullYear()}${p(sun.getMonth() + 1)}${p(sun.getDate())}`, from: 'local' };
}

if (!stopReason) {
  panel.log('开始。只查烽火地带，大约 7 次请求，每次间隔约 1 秒。\n如果页面弹出「选择大区 / 角色」的窗口，直接关掉，不要提交。', 'dim');
  const stat = lastSunday();
  report.findings.statDate = { from: stat.from, kind: dfpStrKind(String(stat.value)) };
  const W5 = {};
  const pause = () => dfpSleep(GAP_MS);

  /* ---------- 2. 周报：本周战绩、高光局、好友（KfXJwH，官方周报页用的格式） ---------- */
  const solRecord = await emit('weekly.sol.record', 'KfXJwH', 'dfm/weekly.sol.record', { statDate: stat.value }, 5);
  W5['weekly.sol.record'] = !!dataOf(solRecord);
  const sr = dataOf(solRecord);
  report.findings.weeklySolRecord = sr ? {
    keys: dfpSafeKeys(sr),
    carryOutHighprice: sr.solDetail && sr.solDetail.CarryOut_highprice_list !== undefined
      ? dfpStrKind(String(sr.solDetail.CarryOut_highprice_list)) : (sr.CarryOut_highprice_list !== undefined ? dfpStrKind(String(sr.CarryOut_highprice_list)) : 'not_found'),
  } : null;
  await pause();
  const solHl = await emit('weekly.sol.highlights', 'KfXJwH', 'dfm/weekly.sol.highlights', { statDate: stat.value }, 5);
  W5['weekly.sol.highlights'] = !!dataOf(solHl);
  await pause();
  const fr = await emit('weekly.sol.friend.record', 'KfXJwH', 'dfm/weekly.sol.friend.record', { statDate: stat.value }, 5);
  const frData = dataOf(fr);
  W5['weekly.sol.friend.record'] = !!frData;
  // 在回包里找「好友列表」数组：元素里有 friend_openid 之类字段的那个
  const findFriendList = v => {
    if (!v || typeof v !== 'object') return null;
    if (Array.isArray(v)) return v.length && v[0] && typeof v[0] === 'object' && Object.keys(v[0]).some(k => /friend/i.test(k)) ? v : null;
    for (const k of Object.keys(v)) { const hit = findFriendList(v[k]); if (hit) return hit; }
    return null;
  };
  const friends = findFriendList(frData) || [];
  const friendIdKey = friends.length   // 官方周报页认的是 friend_openid（main.js:943、954），先精确匹配，再退回宽松正则
    ? (['friend_openid', 'Friend_openid', 'friendOpenid'].find(k => k in friends[0]) || Object.keys(friends[0]).find(k => /friend.*(openid|id)/i.test(k)) || null) : null;
  for (const f of friends) {
    if (friendIdKey && f[friendIdKey] != null) {
      secrets.add(String(f[friendIdKey]));
      const h = await dfpHash12(String(f[friendIdKey]));
      if (!privateOnly.friendIdHashes.includes(h)) privateOnly.friendIdHashes.push(h);
    }
    Object.values(f).forEach(v => { if (typeof v === 'string' && v.length >= 6) secrets.add(v); });
  }
  report.findings.friendRecord = {
    friends: friends.length,
    friendIdKey: friendIdKey && dfpSafeKey(friendIdKey),
    friendIdKinds: friendIdKey ? dfpKindHistogram(friends.map(f => f[friendIdKey])) : null,
    friendShape: friends.length ? dfpMergeShapes(friends.slice(0, 6).map(f => dfpShape(f))) : null,
  };
  await pause();

  /* ---------- 3. 个人中心、大红、日报（NoOapI，官方 H5 工具助手用的格式） ---------- */
  const seasonParams = { resourceType: 'sol', seasonid: [1, 2, 3, 4], isAllSeason: true };
  const resource = await emit('center.person.resource(sol, 全部赛季)', 'NoOapI', 'dfm/center.person.resource', seasonParams, 2);
  const rd = dataOf(resource);
  W5['center.person.resource'] = !!rd;
  const sol = rd && (rd.solDetail || rd);
  report.findings.personResource = sol ? {
    keys: dfpSafeKeys(sol),
    redCollectionDetail: Array.isArray(sol.redCollectionDetail)
      ? { count: sol.redCollectionDetail.length, shape: dfpMergeShapes(sol.redCollectionDetail.slice(0, 6).map(x => dfpShape(x))) }
      : (sol.redCollectionDetail !== undefined ? dfpShape(sol.redCollectionDetail) : 'not_found'),
  } : null;
  await pause();
  const redc = await emit('center.person.redcollection(sol, 全部赛季)', 'NoOapI', 'dfm/center.person.redcollection', seasonParams, 2);
  W5['center.person.redcollection'] = !!dataOf(redc);
  await pause();
  const daily = await emit('center.recent.detail(sol)', 'NoOapI', 'dfm/center.recent.detail', { resourceType: 'sol' }, 2);
  const dd = dataOf(daily);
  W5['center.recent.detail'] = !!dd;
  const sd = dd && (dd.solDetail || dd);
  report.findings.recentDetail = sd ? {
    keys: dfpSafeKeys(sd),
    userCollectionTop: sd.userCollectionTop !== undefined ? dfpShape(sd.userCollectionTop) : 'not_found',
  } : null;
  await pause();
  /* 第三方（DeltaUID）里见过的方法，官方页面没用过；只读，试一次看看 */
  const unlock = await emit('center.recent.redUnlockRecord(第三方见过)', 'NoOapI', 'dfm/center.recent.redUnlockRecord', {}, 2);
  W5['center.recent.redUnlockRecord'] = !!dataOf(unlock);

  report.findings.W5 = W5;
  const okN = Object.values(W5).filter(Boolean).length;
  panel.log(`W5：${okN}/${Object.keys(W5).length} 个方法取到了数据。好友周报里有 ${friends.length} 个好友。`, okN ? 'ok' : 'warn');
}

/* ---------- 4. 汇总 ---------- */
report.stop = stopReason;
const raw = JSON.stringify(report, null, 2);
const { text, leaked } = dfpScrub(raw, secrets);
if (leaked) panel.log(`自检：报告里发现 ${leaked} 处疑似具体值，已替换成「[已移除]」。`, 'warn');
else panel.log('自检通过：报告里没有你的 ID、昵称或好友 ID。', 'ok');
const fname = `m0-B-ams-${new Date().toISOString().slice(0, 10)}.json`;
panel.enable('copy', async () => panel.log(await dfpCopy(text) ? '已复制，粘贴给我就行。' : '复制失败，请用「下载报告」。', 'dim'));
panel.enable('download', () => dfpDownload(text, fname));
if (DFP_MODE !== 'ext') panel.enable('handoff', () => dfpHandoff({ probe: 'B', report: JSON.parse(text), privateOnly }, panel));
if (dfpIsMock()) {
  window.__DFP_TEST_REPORT = text;     // 只在本地模拟页里暴露，供自动化测试检查有没有漏值
  window.__DFP_TEST_LEAKED = leaked;   // e2e 要断言它是 0：自检会把漏出来的值盖成 [已移除]，只查替换后的文本永远是绿的
}
window.__DFP_RUNNING = false;
if (DFP_MODE === 'ext') {
  panel.log('完成。结果已交给 SolLedger 扩展：可以在扩展弹窗里复制报告，或打开本机接收页看 W6 / W7。', 'dim');
  return { probe: 'B', version: DFP_VERSION, report: JSON.parse(text), leaked, privateOnly };   // 交给扩展（executeScript 的返回值）
}
panel.log('完成。可以复制或下载报告；W6 / W7 需要把 A、B 两份都交给本机接收页。', 'dim');

})().catch(e => { window.__DFP_RUNNING = false; return { error: String(e && e.message || e) }; });
