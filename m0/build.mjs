// 把 src/ 里的源码拼成两个书签、两个扩展包，并生成安装页 dist/install.html。
//   dist/bookmarklet-A.js / B.js   书签（备用）
//   dist/ext/                      扩展正式版：只能在官方页面上跑（在 Chrome / Edge 里「加载解压缩的扩展」选这个目录）
//   dist/ext-dev/                  扩展开发版：多了本地模拟环境 127.0.0.1:8770，只给自动化测试用，不进仓库
// 用法：node m0/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = f => readFileSync(join(here, 'src', f), 'utf8');
const extSrc = f => readFileSync(join(here, 'ext', f), 'utf8');
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

const common = src('common.js');
const probes = [
  { id: 'A', file: 'probe-wegame.js', title: 'M0-A WeGame', page: 'https://www.wegame.com.cn/helper/df/score/' },
  { id: 'B', file: 'probe-ams.js', title: 'M0-B 周报页', page: 'https://df.qq.com/cp/weekly20250821/index.html' },
];

/* ---------- 扩展：正式版 + 开发版 ---------- */
const EXT_VERSION = '0.1.0';
// 只有本机接收页。zcube7.github.io 和其他 Pages 项目共用一个 origin，网站上线时要换专用域名再加进来（同时改 content_scripts 的 matches）
const SITE_ORIGINS = ['http://127.0.0.1:8766'];
const variants = [
  {
    dir: 'ext', dev: false, name: 'SolLedger 数据助手（M0 验证）',
    targets: {
      A: { url: probes[0].page, match: 'https://www.wegame.com.cn/helper/df/score/*' },
      B: { url: probes[1].page, match: 'https://df.qq.com/cp/weekly20250821/*' },
    },
    hosts: ['https://www.wegame.com.cn/helper/df/*', 'https://df.qq.com/cp/*'],
  },
  {
    dir: 'ext-dev', dev: true, name: 'SolLedger 数据助手（开发版）',
    targets: {
      A: { url: 'http://127.0.0.1:8770/helper/df/score/', match: 'http://127.0.0.1:8770/helper/df/score/*' },
      B: { url: 'http://127.0.0.1:8770/cp/weekly/', match: 'http://127.0.0.1:8770/cp/weekly/*' },
    },
    hosts: ['https://www.wegame.com.cn/helper/df/*', 'https://df.qq.com/cp/*', 'http://127.0.0.1:8770/*'],
  },
];
for (const v of variants) {
  const out = join(dist, v.dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: v.name,
    version: EXT_VERSION,
    description: '在三角洲行动官方页面里查你自己的烽火地带数据，只导出数据结构，不读取登录凭据。非官方工具。',
    minimum_chrome_version: '110',
    permissions: ['scripting', 'storage'],
    host_permissions: v.hosts,
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_title: 'SolLedger 数据助手' },
    content_scripts: [{
      // 只注入接收页本身。zcube7.github.io 整个 origin 和 cozy-desk-3d / smoking-tracker 等其他 Pages 项目共用（它们还从 jsdelivr / unpkg 拉脚本），
      // 同源页面能 window.open 我们的页面再直接操纵它，路径隔不开：网站上线时换专用域名再加回来
      matches: ['http://127.0.0.1:8766/receiver.html*'],
      js: ['site-bridge.js'], run_at: 'document_idle',
    }],
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const config = { dev: v.dev, targets: v.targets, siteOrigins: SITE_ORIGINS, receiverUrl: 'http://127.0.0.1:8766/receiver.html' + (v.dev ? '?test=1' : '') };
  writeFileSync(join(out, 'config.js'), `// 由 build.mjs 生成，不要手改\nexport const CONFIG = ${JSON.stringify(config, null, 2)};\n`);
  for (const f of ['background.js', 'popup.html', 'popup.js', 'site-bridge.js']) writeFileSync(join(out, f), extSrc(f));
  for (const p of probes) {
    // 和书签同一份源码；DFP_MODE='ext' 时结果作为返回值交给扩展。出错也返回对象，不弹窗
    const code = `(async () => {\nconst DFP_MODE = 'ext';\n${common}\n${src(p.file)}\n})().catch(e => { window.__DFP_RUNNING = false; return { error: String(e && e.message || e) }; });\n`;
    writeFileSync(join(out, `probe-${p.id}.js`), code);
  }
}

const built = probes.map(p => {
  // 整段包进一个 async 函数：源码里顶层的 return / await 都在这个函数里
  const code = `(async () => {\nconst DFP_MODE = 'bookmarklet';\n${common}\n${src(p.file)}\n})().catch(e => { window.__DFP_RUNNING = false; alert('M0 验证出错：' + (e && e.message || e)); });\n`;
  writeFileSync(join(dist, `bookmarklet-${p.id}.js`), code);
  const href = 'javascript:' + encodeURIComponent(code);
  const sha = createHash('sha256').update(code).digest('hex');
  const version = (src(p.file).match(/DFP_VERSION = '([^']+)'/) || [])[1];
  return { ...p, href, sha, version, bytes: Buffer.byteLength(code), hrefLen: href.length };
});

const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>M0 验证工具 · 安装</title>
<style>
body{font:15px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:860px;margin:28px auto;padding:0 16px;color:#111827}
h1{font-size:22px} h2{font-size:17px;margin-top:28px} h3{font-size:15px;margin-top:18px}
a.bm{display:inline-block;padding:8px 14px;margin:6px 8px 6px 0;border-radius:8px;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:600}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px} .dim{color:#6b7280;font-size:13px}
ol li{margin:6px 0} .box{border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:10px 0}
</style></head><body>
<h1>M0 验证工具 · 安装与使用</h1>
<p>这个工具（扩展或书签，取数代码是同一份）只做一件事：在<strong>官方页面里</strong>查一遍你自己的烽火数据，把「数据长什么样」
（字段名、类型、条数、错误码）整理成报告。报告里<strong>没有</strong>你的 ID、昵称、战绩数值，也没有任何登录凭据；
脚本不读、不发任何 Cookie 值或 token。复制或下载的报告发给我就行。</p>

<h2>推荐：用 SolLedger 扩展（不用拖书签）</h2>
<ol>
<li>把整个 <code>m0/dist/ext</code> 文件夹放到一个<strong>以后不会删、不会挪</strong>的位置。收到的是 zip 的话先右键「全部解压缩」，不要直接在压缩包窗口里打开：浏览器每次启动都从这个文件夹读扩展，文件夹没了扩展就失效。</li>
<li>Chrome 打开 <code>chrome://extensions</code>，Edge 打开 <code>edge://extensions</code>，打开「开发者模式」（Edge 叫「开发人员模式」）开关。</li>
<li>点「加载已解压的扩展程序」（Edge 叫「加载解压缩的扩展」），选上面那个文件夹：要选到<strong>里面直接就有 manifest.json</strong> 的那一层，多套一层会提示「清单文件缺失」。</li>
<li>点地址栏右边的拼图图标（扩展），把「SolLedger 数据助手」固定到工具栏：Chrome 点它旁边的图钉，Edge 点它旁边的眼睛图标。</li>
<li>点这个图标，先「跑验证 A」、再「跑验证 B」。扩展会自己打开对应的官方页面：没登录的话先在那里用 <strong>QQ 号</strong>登录，再点一次。各自跑完后点「复制报告」发给我。</li>
<li>（可选）W6、W7：在本项目目录运行 <code>node m0/serve.mjs</code>，在扩展弹窗里点「打开本机接收页」，接收页会自动从扩展读到两份报告。看完点「清空本页数据」。</li>
</ol>
<p class="dim">浏览器启动时可能提示关闭开发者模式下的扩展：所有不从应用商店装的扩展都会这样提示，关掉这个提示就行，不要选关闭扩展（选了的话回扩展页把它的开关重新打开）。不用了随时在扩展页里关掉或移除。</p>

<h2>备用：书签（不想装扩展时用）</h2>
<h3>1. 安装</h3>
<p>用 <strong>Chrome 或 Edge</strong> 打开本页，先按 <code>Ctrl+Shift+B</code> 显示书签栏，再把下面两个按钮<strong>拖</strong>到书签栏上（不要点）：</p>
${built.map(b => `<a class="bm" href="${esc(b.href)}">${b.title}</a>`).join('\n')}
<div class="box dim">
${built.map(b => `${b.title}：版本 ${b.version}，${b.bytes} 字节，SHA-256 <code>${b.sha.slice(0, 16)}…</code>（完整源码见 dist/bookmarklet-${b.id}.js）`).join('<br>\n')}
</div>

<h3>2. 跑书签 A（WeGame 助手）</h3>
<ol>
<li>打开 <a href="${built[0].page}" target="_blank" rel="noopener">${built[0].page}</a>，用你的 <strong>QQ 号</strong>登录，确认能看到自己的烽火战绩。</li>
<li>点书签栏上的 <strong>${built[0].title}</strong>。右上角会出现面板，大约 40 秒跑完（最多约 25 次请求，每次间隔 1~1.5 秒）。<strong>只点一次</strong>，跑完之前不要刷新页面。</li>
<li>面板显示「完成」后点<strong>复制报告</strong>，粘贴给我（或点下载报告，把文件发给我）。</li>
</ol>

<h3>3. 跑书签 B（官方周报页）</h3>
<ol>
<li>打开 <a href="${built[1].page}" target="_blank" rel="noopener">${built[1].page}</a>，用同一个 <strong>QQ 号</strong>登录，确认能看到周报。</li>
<li>点书签栏上的 <strong>${built[1].title}</strong>，等面板显示「完成」（大约 10 秒），同样复制报告发给我。</li>
<li>如果页面弹出「选择大区 / 角色」之类的窗口，<strong>直接关掉，不要点提交</strong>：书签只读数据，不需要绑定任何东西。</li>
</ol>

<h3>4.（可选）W6、W7：交接给本机接收页</h3>
<ol>
<li>在本项目目录运行 <code>node m0/serve.mjs</code>（只在 127.0.0.1 上监听）。</li>
<li>分别在书签 A、书签 B 的面板里点 <strong>测试交接（W7）</strong>，浏览器会打开本机接收页。</li>
<li>接收页会显示 A、B 两份结果，以及「好友 ID 和对局队友 ID 有没有重合」（W6，只在你电脑上比对哈希）。</li>
<li>看完后在接收页点「清空本页数据」。</li>
</ol>

<h2>遇到这些情况（扩展、书签都适用）</h2>
<ul>
<li>面板说「未登录」：先在官方页面登录 QQ，再点书签。</li>
<li>面板说「人机校验（8000022）」：脚本已经停了，不会重试。按 <code>F5</code> 刷新 WeGame 助手页面，如果弹出验证码就按提示完成，能正常看到自己的战绩后再点书签。</li>
<li>书签 B 说「15 秒没有回应」：多半是官方弹了验证码或登录框。脚本已经停了；在页面上完成验证 / 登录，刷新后再点一次书签。</li>
<li>书签 B 说「NoOapI 这组方法返回 101」：这是我们要验证的结果之一，不用重新登录，直接把报告发给我。</li>
<li>书签 B 说「没有可用的 Milo」：确认打开的是上面那个周报页地址。</li>
</ul>
<p class="dim">非官方工具，只读不写。官方接口随时可能变化。</p>
</body></html>
`;
writeFileSync(join(dist, 'install.html'), html);
for (const b of built) console.log(`bookmarklet ${b.id}: ${b.bytes} bytes, href ${b.hrefLen} chars, sha256 ${b.sha.slice(0, 16)}`);
console.log('wrote', join(dist, 'install.html'));
