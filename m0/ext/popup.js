// 弹窗：发起取数、显示状态、复制报告。取数本身在后台跑，弹窗关掉也不影响。
import { CONFIG } from './config.js';

const STOP_TEXT = {
  captcha: '官方要求人机校验，已停止：按 F5 刷新 WeGame 助手页面，完成验证码后再点一次',
  not_login: '官方说未登录或登录已过期：到 www.wegame.com.cn 右上角退出后用 QQ 重新登录，再点一次',
  no_role: '没取到角色信息：确认登录的是玩三角洲的那个号',
};

document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version + (CONFIG.dev ? ' 开发版' : '');

function fmt(ts) { return ts ? new Date(ts).toLocaleString() : ''; }

// 后台被浏览器停掉后存储里可能残留「正在跑」。后台最多等官方页面加载 30 秒、取数 4 分钟，
// 「正在跑」超过 5 分钟的一定是残留，按钮不能一直灰着（留出余量：太短会把还在跑的任务显示成中断，再点只会得到 busy）
const STALE_MS = 300000;
const ERROR_TEXT = {
  interrupted: '上次没跑完就中断了（浏览器或扩展被重启过），再点一次就行',
  already_running: '官方页面里上一次还在跑：等它结束或刷新那个页面后，再点一次',
  no_result: '官方页面没交回结果（跑的过程中页面被刷新或跳走了）：再点一次，跑完之前别动那个页面',
  bad_result: '官方页面交回的结果不对：刷新那个页面后再点一次',
};
// 顺手叫醒后台：它启动时会把残留的「正在跑」改成「中断」（不需要回复）
chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {});

// 验证项以页面上的卡片为准（现在只有 A；验证 B 暂缓）
const PROBES = [...document.querySelectorAll('.card[data-probe]')].map(c => c.getAttribute('data-probe'));

async function render() {
  const s = await chrome.storage.local.get(PROBES.flatMap(p => [`status_${p}`, `result_${p}`]));
  for (const probe of PROBES) {
    const card = document.querySelector(`.card[data-probe="${probe}"]`);
    const st = s[`status_${probe}`];
    const res = s[`result_${probe}`];
    const el = card.querySelector('.status');
    const running = !!(st && st.state === 'running' && Date.now() - st.at < STALE_MS);
    let text = '还没跑过', cls = 'dim';
    if (running) { text = '正在跑……（' + fmt(st.at) + ' 开始）'; cls = 'warn'; }
    else if (st && st.state === 'running') { text = '出错：' + ERROR_TEXT.interrupted; cls = 'err'; }
    else if (st && st.state === 'error') { text = '出错：' + (ERROR_TEXT[st.error] || st.error); cls = 'err'; }
    else if (st && st.state === 'done') {
      text = '完成（' + fmt(st.at) + '）' + (st.stop ? '：' + (STOP_TEXT[st.stop] || st.stop) : '');
      cls = st.stop ? 'warn' : 'ok';
    }
    el.textContent = text;
    el.className = 'status ' + cls;
    card.querySelector('[data-act="run"]').disabled = running;
    card.querySelector('[data-act="copy"]').disabled = !res;
  }
}

document.body.addEventListener('click', async e => {
  const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
  if (!act) return;
  const card = e.target.closest('.card');
  const probe = card && card.getAttribute('data-probe');
  if (act === 'run') {
    // 结果从存储里读（弹窗可能被关掉）；只有「上一次还在跑」这种立刻就回的拒绝，要在这里告诉用户
    chrome.runtime.sendMessage({ type: 'run', probe }).then(r => {
      if (r && r.error === 'busy') {
        const el = card.querySelector('.status');
        el.textContent = '上一次还在后台跑，等它结束再点（最多 4 分钟）';
        el.className = 'status warn';
      }
    }).catch(() => {});
    setTimeout(render, 300);
  } else if (act === 'copy') {
    const res = (await chrome.storage.local.get(`result_${probe}`))[`result_${probe}`];
    if (!res) return;
    await navigator.clipboard.writeText(JSON.stringify(res.report, null, 2));   // 只复制结构报告，不含哈希
    e.target.textContent = '已复制';
    setTimeout(() => { e.target.textContent = '复制报告'; }, 1500);
  } else if (act === 'receiver') {
    chrome.tabs.create({ url: CONFIG.receiverUrl });
  } else if (act === 'clear') {
    await chrome.runtime.sendMessage({ type: 'clear' });
    render();
  }
});

chrome.storage.onChanged.addListener(render);
render();
