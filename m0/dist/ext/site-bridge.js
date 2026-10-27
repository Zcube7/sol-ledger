// 只注入在我们自己的网页上（M0 只有本机接收页 receiver.html），在网页和扩展之间传话。网页只能读报告、清空，不能发起取数。
// 网页用 window.postMessage 发 { type: 'dfp-ext-request', id, action, probe }，这里转给扩展后台，
// 再把回复用 { type: 'dfp-ext-response', id, resp } 发回本页。只认本页自己发的消息。
(function () {
  'use strict';
  const ACTIONS = ['get-reports', 'clear'];   // 不转 run：取数只能在扩展弹窗里由用户亲手发起（后台也会拒）
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== 'dfp-ext-request' || typeof d.id !== 'string' || !ACTIONS.includes(d.action)) return;
    const reply = (resp, error) => window.postMessage({ type: 'dfp-ext-response', id: d.id, resp: resp || null, error }, location.origin);
    try {
      chrome.runtime.sendMessage({ type: d.action, probe: d.probe }, resp => reply(resp, chrome.runtime.lastError ? chrome.runtime.lastError.message : undefined));
    } catch (err) {
      // 扩展被重新加载 / 更新后，旧页面里的这段脚本就和扩展断开了（Extension context invalidated），刷新本页才能重新连上
      reply(null, '扩展刚重新加载过，请刷新本页');
    }
  });
  // 告诉网页「扩展在」：网页收到后再来要数据
  window.postMessage({ type: 'dfp-ext-hello', version: chrome.runtime.getManifest().version }, location.origin);
})();
