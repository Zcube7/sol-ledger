// 把 src/ 里的源码拼成两个书签，并生成安装页 dist/install.html。
// 用法：node m0/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = f => readFileSync(join(here, 'src', f), 'utf8');
const dist = join(here, 'dist');
mkdirSync(dist, { recursive: true });

const common = src('common.js');
const probes = [
  { id: 'A', file: 'probe-wegame.js', title: 'M0-A WeGame', page: 'https://www.wegame.com.cn/helper/df/score/' },
  { id: 'B', file: 'probe-ams.js', title: 'M0-B 周报页', page: 'https://df.qq.com/cp/weekly20250821/index.html' },
];

const built = probes.map(p => {
  // 整段包进一个 async 函数：源码里顶层的 return / await 都在这个函数里
  const code = `(async () => {\n${common}\n${src(p.file)}\n})().catch(e => { window.__DFP_RUNNING = false; alert('M0 验证出错：' + (e && e.message || e)); });\n`;
  writeFileSync(join(dist, `bookmarklet-${p.id}.js`), code);
  const href = 'javascript:' + encodeURIComponent(code);
  const sha = createHash('sha256').update(code).digest('hex');
  const version = (src(p.file).match(/DFP_VERSION = '([^']+)'/) || [])[1];
  return { ...p, href, sha, version, bytes: Buffer.byteLength(code), hrefLen: href.length };
});

const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>M0 验证书签 · 安装</title>
<style>
body{font:15px/1.7 system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:860px;margin:28px auto;padding:0 16px;color:#111827}
h1{font-size:22px} h2{font-size:17px;margin-top:28px}
a.bm{display:inline-block;padding:8px 14px;margin:6px 8px 6px 0;border-radius:8px;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:600}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px} .dim{color:#6b7280;font-size:13px}
ol li{margin:6px 0} .box{border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;margin:10px 0}
</style></head><body>
<h1>M0 验证书签 · 安装与使用</h1>
<p>这两个书签只做一件事：在<strong>官方页面里</strong>查一遍你自己的烽火数据，把「数据长什么样」
（字段名、类型、条数、错误码）整理成报告。报告里<strong>没有</strong>你的 ID、昵称、战绩数值，也没有任何登录凭据；
脚本不读、不发任何 Cookie 值或 token。复制或下载的报告发给我就行。</p>

<h2>1. 安装</h2>
<p>用 <strong>Chrome 或 Edge</strong> 打开本页，先按 <code>Ctrl+Shift+B</code> 显示书签栏，再把下面两个按钮<strong>拖</strong>到书签栏上（不要点）：</p>
${built.map(b => `<a class="bm" href="${esc(b.href)}">${b.title}</a>`).join('\n')}
<div class="box dim">
${built.map(b => `${b.title}：版本 ${b.version}，${b.bytes} 字节，SHA-256 <code>${b.sha.slice(0, 16)}…</code>（完整源码见 dist/bookmarklet-${b.id}.js）`).join('<br>\n')}
</div>

<h2>2. 跑书签 A（WeGame 助手）</h2>
<ol>
<li>打开 <a href="${built[0].page}" target="_blank" rel="noopener">${built[0].page}</a>，用你的 <strong>QQ 号</strong>登录，确认能看到自己的烽火战绩。</li>
<li>点书签栏上的 <strong>${built[0].title}</strong>。右上角会出现面板，大约 40 秒跑完（最多约 25 次请求，每次间隔 1~1.5 秒）。<strong>只点一次</strong>，跑完之前不要刷新页面。</li>
<li>面板显示「完成」后点<strong>复制报告</strong>，粘贴给我（或点下载报告，把文件发给我）。</li>
</ol>

<h2>3. 跑书签 B（官方周报页）</h2>
<ol>
<li>打开 <a href="${built[1].page}" target="_blank" rel="noopener">${built[1].page}</a>，用同一个 <strong>QQ 号</strong>登录，确认能看到周报。</li>
<li>点书签栏上的 <strong>${built[1].title}</strong>，等面板显示「完成」（大约 10 秒），同样复制报告发给我。</li>
<li>如果页面弹出「选择大区 / 角色」之类的窗口，<strong>直接关掉，不要点提交</strong>：书签只读数据，不需要绑定任何东西。</li>
</ol>

<h2>4.（可选）W6、W7：交接给本机接收页</h2>
<ol>
<li>在本项目目录运行 <code>node m0/serve.mjs</code>（只在 127.0.0.1 上监听）。</li>
<li>分别在书签 A、书签 B 的面板里点 <strong>测试交接（W7）</strong>，浏览器会打开本机接收页。</li>
<li>接收页会显示 A、B 两份结果，以及「好友 ID 和对局队友 ID 有没有重合」（W6，只在你电脑上比对哈希）。</li>
<li>看完后在接收页点「清空本页数据」。</li>
</ol>

<h2>遇到这些情况</h2>
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
