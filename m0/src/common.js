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
