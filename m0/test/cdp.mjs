// 端到端测试共用：起一个无头 Edge / Chrome，用 Chrome DevTools 协议（CDP）开页面、执行脚本、等条件。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 起浏览器并连上调试端口。
 * opts.extension：要加载的解压缩扩展目录（只有 Edge 还支持 --load-extension，所以这时只找 Edge）
 */
export async function launch({ port, extension } = {}) {
  const candidates = extension
    ? ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
    : ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  const exe = candidates.find(p => existsSync(p));
  if (!exe) throw new Error('找不到 Edge' + (extension ? '' : ' 或 Chrome'));
  const profile = mkdtempSync(join(tmpdir(), 'dfp-e2e-'));
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check'];
  if (extension) args.push(`--load-extension=${extension}`, `--disable-extensions-except=${extension}`);
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: 'ignore' });

  let ws = null, seq = 0;
  const pending = new Map();
  for (let i = 0; i < 50 && !ws; i++) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const sock = new WebSocket(v.webSocketDebuggerUrl);
      await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
      ws = sock;
    } catch (e) { await sleep(200); }
  }
  if (!ws) { proc.kill(); throw new Error('连不上浏览器调试端口'); }
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const p = pending.get(d.id); pending.delete(d.id);
      d.error ? p.reject(new Error(JSON.stringify(d.error))) : p.resolve(d.result);
    }
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const attach = async targetId => {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId).catch(() => {});
    return sessionId;
  };
  const openPage = async url => {
    const { targetId } = await send('Target.createTarget', { url });
    return { targetId, sessionId: await attach(targetId) };
  };
  const evalIn = async (sessionId, expression, userGesture = false) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };
  const waitFor = async (sessionId, expression, ms = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await evalIn(sessionId, expression).catch(() => false)) return true;
      await sleep(300);
    }
    throw new Error('等待超时：' + expression);
  };
  const targets = async () => (await send('Target.getTargets')).targetInfos;
  const close = async () => {
    try { ws.close(); } catch (e) { /* ignore */ }
    proc.kill();
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* 浏览器可能还没释放文件 */ }
  };
  return { send, attach, openPage, evalIn, waitFor, targets, close };
}

/** 收集检查结果，最后统一打印 */
export function checker() {
  const results = [];
  const check = (name, fn) => { try { fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name + '：' + e.message]); } };
  const fail = msg => results.push(['FAIL', msg]);
  const report = () => {
    for (const [s, n] of results) console.log(`${s === 'ok' ? '✓' : '✗'} ${n}`);
    const fails = results.filter(r => r[0] !== 'ok').length;
    console.log(`\n${results.length - fails}/${results.length} 通过`);
    return fails;
  };
  return { check, fail, report };
}
