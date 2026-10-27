// 把 src/ 里的源码拼成书签、两个扩展包，并生成安装页 dist/install.html。
//   dist/bookmarklet-A.js          书签（备用）
//   dist/ext/                      扩展正式版：只能在官方页面上跑（在 Chrome / Edge 里「加载解压缩的扩展」选这个目录）
//   dist/ext-dev/                  扩展开发版：多了本地模拟环境 127.0.0.1:8770，只给自动化测试用，不进仓库
// 验证 B（官方周报页）2026-10-27 起暂缓：周报页是手机竖屏页面，电脑上要把窗口调成竖长才能登录。
// 它的代码在提交 16a04da 里（m0/src/probe-ams.js 等），要恢复从那里取。
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
];

/* ---------- 扩展：正式版 + 开发版 ---------- */
const EXT_VERSION = '0.2.0';
// 只有本机接收页。zcube7.github.io 和其他 Pages 项目共用一个 origin，网站上线时要换专用域名再加进来（同时改 content_scripts 的 matches）
const SITE_ORIGINS = ['http://127.0.0.1:8766'];
const variants = [
  {
    dir: 'ext', dev: false, name: 'SolLedger 数据助手（M0 验证）',
    targets: { A: { url: probes[0].page, match: 'https://www.wegame.com.cn/helper/df/score/*' } },
    hosts: ['https://www.wegame.com.cn/helper/df/*'],
  },
  {
    dir: 'ext-dev', dev: true, name: 'SolLedger 数据助手（开发版）',
    targets: { A: { url: 'http://127.0.0.1:8770/helper/df/score/', match: 'http://127.0.0.1:8770/helper/df/score/*' } },
    hosts: ['https://www.wegame.com.cn/helper/df/*', 'http://127.0.0.1:8770/*'],
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

// 上一版的书签 B 构建产物不要留在 dist/ 里
rmSync(join(dist, 'bookmarklet-B.js'), { force: true });

const built = probes.map(p => {
  // 整段包进一个 async 函数：源码里顶层的 return / await 都在这个函数里
  const code = `(async () => {\nconst DFP_MODE = 'bookmarklet';\n${common}\n${src(p.file)}\n})().catch(e => { window.__DFP_RUNNING = false; alert('M0 验证出错：' + (e && e.message || e)); });\n`;
  writeFileSync(join(dist, `bookmarklet-${p.id}.js`), code);
  const href = 'javascript:' + encodeURIComponent(code);
  const sha = createHash('sha256').update(code).digest('hex');
  const version = (src(p.file).match(/DFP_VERSION = '([^']+)'/) || [])[1];
  return { ...p, href, sha, version, bytes: Buffer.byteLength(code), hrefLen: href.length };
});
const A = built[0];

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
<p>这个工具（扩展或书签，取数代码是同一份）只做一件事：在 <strong>WeGame 助手页面里</strong>查一遍你自己的烽火数据，把「数据长什么样」
（字段名、类型、条数、错误码）整理成报告。报告里<strong>没有</strong>你的 ID、昵称、战绩数值，也没有任何登录凭据；
脚本不读、不发任何 Cookie 值或 token。复制或下载的报告发给我就行。</p>

<h2>推荐：用 SolLedger 扩展（不用拖书签）</h2>
<ol>
<li>把整个 <code>m0/dist/ext</code> 文件夹放到一个<strong>以后不会删、不会挪</strong>的位置。收到的是 zip 的话先右键「全部解压缩」，不要直接在压缩包窗口里打开：浏览器每次启动都从这个文件夹读扩展，文件夹没了扩展就失效。</li>
<li>Chrome 打开 <code>chrome://extensions</code>，Edge 打开 <code>edge://extensions</code>，打开「开发者模式」（Edge 叫「开发人员模式」）开关。</li>
<li>点「加载已解压的扩展程序」（Edge 叫「加载解压缩的扩展」），选上面那个文件夹：要选到<strong>里面直接就有 manifest.json</strong> 的那一层，多套一层会提示「清单文件缺失」。</li>
<li>点地址栏右边的拼图图标（扩展），把「SolLedger 数据助手」固定到工具栏：Chrome 点它旁边的图钉，Edge 点它旁边的眼睛图标。</li>
<li>点这个图标，再点「跑验证 A」。扩展会自己打开 WeGame 助手页面：没登录的话先在那里用 <strong>QQ 号</strong>登录，再点一次。跑完后点「复制报告」发给我。</li>
<li>（可选）W7：在本项目目录运行 <code>node m0/serve.mjs</code>，在扩展弹窗里点「打开本机接收页」，接收页会自动从扩展读到报告。看完点「清空本页数据」。</li>
</ol>
<p class="dim">浏览器启动时可能提示关闭开发者模式下的扩展：所有不从应用商店装的扩展都会这样提示，关掉这个提示就行，不要选关闭扩展（选了的话回扩展页把它的开关重新打开）。不用了随时在扩展页里关掉或移除。</p>

<h2>备用：书签（不想装扩展时用）</h2>
<h3>1. 安装</h3>
<p>用 <strong>Chrome 或 Edge</strong> 打开本页，先按 <code>Ctrl+Shift+B</code> 显示书签栏，再把下面的按钮<strong>拖</strong>到书签栏上（不要点）：</p>
<a class="bm" href="${esc(A.href)}">${A.title}</a>
<div class="box dim">
${A.title}：版本 ${A.version}，${A.bytes} 字节，SHA-256 <code>${A.sha.slice(0, 16)}…</code>（完整源码见 dist/bookmarklet-A.js）
</div>

<h3>2. 跑书签（WeGame 助手）</h3>
<ol>
<li>打开 <a href="${A.page}" target="_blank" rel="noopener">${A.page}</a>，用你的 <strong>QQ 号</strong>登录，确认能看到自己的烽火战绩。</li>
<li>点书签栏上的 <strong>${A.title}</strong>。右上角会出现面板，大约 40 秒跑完（最多约 25 次请求，每次间隔 1~1.5 秒）。<strong>只点一次</strong>，跑完之前不要刷新页面。</li>
<li>面板显示「完成」后点<strong>复制报告</strong>，粘贴给我（或点下载报告，把文件发给我）。</li>
<li>（可选）W7：先运行 <code>node m0/serve.mjs</code>，再在面板里点 <strong>测试交接（W7）</strong>，浏览器会打开本机接收页。看完后在接收页点「清空本页数据」。</li>
</ol>

<h2>遇到这些情况（扩展、书签都适用）</h2>
<ul>
<li>面板说「未登录或登录已过期」，或者生涯页只显示「无角色信息」：打开 <a href="https://www.wegame.com.cn/" target="_blank" rel="noopener">www.wegame.com.cn</a>，在右上角退出后用 QQ 重新登录，回到生涯页刷新、能看到自己的战绩后再跑。</li>
<li>面板说「人机校验（8000022）」：脚本已经停了，不会重试。按 <code>F5</code> 刷新 WeGame 助手页面，如果弹出验证码就按提示完成，能正常看到自己的战绩后再跑。</li>
</ul>
<p class="dim">验证 B（官方周报页：大红收藏进度、周报、好友周报）暂缓，以后要做时会让扩展自己开竖长小窗口。非官方工具，只读不写。官方接口随时可能变化。</p>
</body></html>
`;
writeFileSync(join(dist, 'install.html'), html);
for (const b of built) console.log(`bookmarklet ${b.id}: ${b.bytes} bytes, href ${b.hrefLen} chars, sha256 ${b.sha.slice(0, 16)}`);
console.log('wrote', join(dist, 'install.html'));
