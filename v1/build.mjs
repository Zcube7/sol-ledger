// 构建 v1 扩展「SolLedger · 烽火战绩助手」：
//   v1/dist/ext/       正式版（Chrome / Edge「加载解压缩的扩展」选这个目录）
//   v1/dist/ext-dev/   开发版：多了本地模拟环境 127.0.0.1:8771，间隔调短，只给自动化测试用，不进仓库
// 用法：node v1/build.mjs
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.3.0';
const FILES = ['background.js', 'page-sync.js', 'db.js', 'aggregate.js', 'labels.js', 'dashboard.html', 'dashboard.js'];
const OFFICIAL = { url: 'https://www.wegame.com.cn/helper/df/score/', match: 'https://www.wegame.com.cn/helper/df/score/*' };
const MOCK_ORIGIN = 'http://127.0.0.1:8771';

const variants = [
  { dir: 'ext', dev: false, name: 'SolLedger · 烽火战绩助手', target: OFFICIAL, hosts: ['https://www.wegame.com.cn/helper/df/*'] },
  {
    dir: 'ext-dev', dev: true, name: 'SolLedger · 烽火战绩助手（开发版）',
    target: { url: MOCK_ORIGIN + '/helper/df/score/', match: MOCK_ORIGIN + '/helper/df/score/*' },
    hosts: ['https://www.wegame.com.cn/helper/df/*', MOCK_ORIGIN + '/*'],
  },
];

for (const v of variants) {
  const out = join(here, 'dist', v.dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: v.name,
    version: VERSION,
    description: '在你登录着的 WeGame 三角洲助手页面里同步你自己的烽火地带战绩，按天汇总和好友一起玩的数据。数据只存在这个浏览器里。非官方工具。',
    minimum_chrome_version: '110',
    permissions: ['scripting', 'storage'],
    host_permissions: v.hosts,
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_title: '打开当天好友战绩' },   // 没有弹窗：点图标直接打开汇总页
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const config = { dev: v.dev, target: v.target, mockOrigin: v.dev ? MOCK_ORIGIN : null };
  writeFileSync(join(out, 'config.js'), `// 由 v1/build.mjs 生成，不要手改\nexport const CONFIG = ${JSON.stringify(config, null, 2)};\n`);
  for (const f of FILES) writeFileSync(join(out, f), readFileSync(join(here, 'src', f), 'utf8'));
}
console.log('built', variants.map(v => 'v1/dist/' + v.dir).join(', '));
