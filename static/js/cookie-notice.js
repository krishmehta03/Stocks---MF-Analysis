/* WealthLenz browser-storage notice.
   Informational only: the site uses essential browser storage (sign-in, theme,
   preferences) and no advertising or third-party tracking. If analytics or ad
   tools are ever added, replace this with a real consent banner first. */
(function () {
  var KEY = 'wl_storage_notice_ack';
  try { if (localStorage.getItem(KEY) === '1') return; } catch (e) { }
  if (document.getElementById('wl-notice')) return;

  var css = document.createElement('style');
  css.textContent =
    '#wl-notice{position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;max-width:560px;margin:0 auto;' +
    'background:#0f172a;color:#f1f5f9;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:14px 16px;' +
    'box-shadow:0 10px 30px rgba(0,0,0,.35);font:14px/1.5 "Plus Jakarta Sans",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
    'display:flex;gap:14px;align-items:center;flex-wrap:wrap}' +
    '#wl-notice p{margin:0;flex:1 1 260px}' +
    '#wl-notice a{color:#34d399;text-decoration:underline}' +
    '#wl-notice button{background:#10b981;color:#fff;border:0;border-radius:8px;padding:8px 18px;font:inherit;font-weight:600;cursor:pointer}' +
    '#wl-notice button:hover{background:#059669}' +
    '#wl-notice button:focus-visible,#wl-notice a:focus-visible{outline:2px solid #fff;outline-offset:2px}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.id = 'wl-notice';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'Browser storage notice');
  box.innerHTML =
    '<p>WealthLenz uses essential browser storage to keep you signed in and remember your display settings. ' +
    'We do not use advertising or third-party tracking cookies. ' +
    '<a href="/privacy#cookies">Learn more</a></p>' +
    '<button type="button">Got it</button>';
  box.querySelector('button').addEventListener('click', function () {
    try { localStorage.setItem(KEY, '1'); } catch (e) { }
    box.remove();
  });
  document.body.appendChild(box);
})();
