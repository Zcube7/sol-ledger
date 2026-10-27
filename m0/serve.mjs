// 本机接收页的静态服务：只监听 127.0.0.1，只提供 m0/ 下的两个页面。
// 用法：node m0/serve.mjs   然后打开 http://127.0.0.1:8766/receiver.html
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8766);
const routes = {
  '/receiver.html': join(here, 'receiver.html'),
  '/install.html': join(here, 'dist', 'install.html'),
};

createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = routes[path === '/' ? '/install.html' : path];
  if (!file) { res.writeHead(404).end('not found'); return; }
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  } catch (e) {
    res.writeHead(500).end(String(e.message));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`M0 接收页：http://127.0.0.1:${PORT}/receiver.html`));
