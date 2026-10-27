// v1 单测：按天汇总的纯函数 + 源码红线（扩展自己不发请求、不碰 Cookie 值；只有取数函数读 tgp_user_type 标记位）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeDay, topCounts } from '../src/aggregate.js';
import { isEscaped, gameResultText, armedForceName, mapName, setNameOverrides } from '../src/labels.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = f => readFileSync(join(here, '..', 'src', f), 'utf8');
const ESC = 0;   // 官方：gameResult === 0 是撤离成功

const P = (alias, name, o = {}) => Object.assign({ alias, name, isSelf: alias === 'me', armedForceId: 1, killCnt: 1, killPlayer: 1, assistCnt: 0, rescue: 0, gameResult: ESC, gainedPrice: '100', ProfitLoss: 0, collections: [] }, o);
const M = (roomId, start, o = {}) => Object.assign({ roomId, start, mapId: 9, armedForceId: 1, killCnt: 2, killPlayer: 1, assistCnt: 1, rescue: 1, gameResult: ESC, gainedPrice: '1000', ProfitLoss: 10, collections: [] }, o);

test('按人加总：同队 2 局以上算好友，1 局的算路人；「我」是全天合计', () => {
  const matches = [M('r1', 1), M('r2', 2), M('r3', 3, { gameResult: -999 })];
  const details = {
    r1: { players: [P('me', '我'), P('a', '老王', { rescue: 1, armedForceId: 7 }), P('b', '小李')] },
    r2: { players: [P('me', '我'), P('a', '老王', { killPlayer: 3, armedForceId: 7 }), P('c', '路人')] },
  };
  const s = summarizeDay(matches, details);
  assert.equal(s.matchCount, 3);
  assert.equal(s.withDetail, 2);
  assert.equal(s.self.totals.matches, 3);
  assert.equal(s.self.totals.escaped, 2);
  assert.equal(s.self.totals.rescue, 3);
  assert.deepEqual(s.friends.map(p => p.name), ['老王']);
  const w = s.friends[0].totals;
  assert.equal(w.matches, 2);
  assert.equal(w.killPlayer, 4);
  assert.equal(w.rescue, 1);
  assert.deepEqual(w.armedForces, { 7: 2 });
  assert.deepEqual(s.others.map(p => p.name).sort(), ['小李', '路人']);
  assert.equal(s.perMatch[2].hasDetail, false);
});

test('同一个人改了昵称：按代号算同一个人，显示最后一次的昵称', () => {
  const s = summarizeDay([M('r1', 1), M('r2', 2)], {
    r1: { players: [P('me', '我'), P('a', '旧名')] },
    r2: { players: [P('me', '我'), P('a', '新名')] },
  });
  assert.equal(s.friends.length, 1);
  assert.equal(s.friends[0].name, '新名');
  assert.equal(s.friends[0].totals.matches, 2);
});

test('minTogether=1 时所有同队过的人都算', () => {
  const s = summarizeDay([M('r1', 1)], { r1: { players: [P('me', '我'), P('a', '甲'), P('b', '乙')] } }, { minTogether: 1 });
  assert.equal(s.friends.length, 2);
});

test('带出藏品按件数和价格合计；干员按局数排序', () => {
  const s = summarizeDay([M('r1', 1, { collections: [{ num: 2, price: 500 }, { num: 1, price: 100 }] })], {});
  assert.equal(s.self.totals.collectionsNum, 3);
  assert.equal(s.self.totals.collectionsPrice, 1100);
  assert.deepEqual(topCounts({ 3: 1, 5: 4, 9: 2 }, 2), [{ id: 5, n: 4 }, { id: 9, n: 2 }]);
});

test('红线：扩展自己不发请求、不读 Cookie 值；页面取数只读 tgp_user_type', () => {
  const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/gm, '$1');
  const ext = ['background.js', 'db.js', 'aggregate.js', 'labels.js', 'dashboard.js'].map(f => strip(src(f))).join('\n');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'sendBeacon', 'document.cookie', 'chrome.cookies', 'webRequest', 'eval(', 'new Function', 'innerHTML']) {
    assert.ok(!ext.includes(bad), `扩展源码里出现了 ${bad}`);
  }
  const page = strip(src('page-sync.js'));
  assert.equal((page.match(/document\.cookie/g) || []).length, 1);
  assert.match(page, /startsWith\('tgp_user_type='\)/);
  assert.deepEqual([...page.matchAll(/fetch\(([^,]+),/g)].map(m => m[1].trim()).sort(), ['API + method', 'CDN + path']);
  assert.match(page, /fetch\(CDN \+ path, \{ credentials: 'omit' \}\)/);   // 读公开配置不带 Cookie
  assert.match(page, /credentials: 'same-origin'/);
  for (const bad of ['access_token', 'tgp_ticket', 'localStorage', 'sessionStorage', 'sendBeacon', 'new Image']) assert.ok(!page.includes(bad), bad);
});

test('口径照官方：gameResult 0 = 撤离成功，其他都算失败；名称先用官方配置，再用快照，查不到不瞎猜', () => {
  assert.equal(isEscaped(0), true);
  assert.equal(isEscaped('0'), true);
  assert.equal(isEscaped(3), false);
  assert.equal(gameResultText(0), '撤离成功');
  assert.equal(gameResultText(2), '撤离失败');
  assert.equal(armedForceName(10010), '威龙');
  assert.equal(mapName(2202), '零号大坝-机密');
  assert.equal(armedForceName(99999), '干员#99999');
  setNameOverrides({ armed: { 99999: '新干员' }, maps: { 2202: '改名的地图' } });
  assert.equal(armedForceName(99999), '新干员');
  assert.equal(mapName(2202), '改名的地图');
  setNameOverrides(null);
  assert.equal(mapName(2202), '零号大坝-机密');
});

test('带出价值照官方口径：gainedPrice 为 0 / 空时用 collectionPrice', () => {
  const s = summarizeDay([M('r1', 1, { gainedPrice: '0', collectionPrice: '500000' }), M('r2', 2, { gainedPrice: '10' })], {});
  assert.equal(s.self.totals.gainedPrice, 500010);
});

test('空的小队名单当没查到；小队里认不出自己时这一局的队友不算，并计数提醒', () => {
  const s = summarizeDay([M('r1', 1), M('r2', 2), M('r3', 3)], {
    r1: { players: [] },
    r2: { players: [P('x', '甲'), P('y', '乙'), P('z', '丙')] },   // 没有 isSelf
    r3: { players: [P('me', '我'), P('a', '老王')] },
  }, { minTogether: 1 });
  assert.equal(s.withDetail, 1);
  assert.equal(s.selfMissing, 1);
  assert.deepEqual(s.friends.map(p => p.name), ['老王']);
  assert.equal(s.perMatch[0].hasDetail, false);
  assert.equal(s.perMatch[1].selfMissing, true);
});
