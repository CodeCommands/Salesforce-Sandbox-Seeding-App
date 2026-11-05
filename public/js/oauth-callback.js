// OAuth redirect target. Reads the token (hash) or code (query), removes it from the address bar
// immediately, and hands it to the app window. Classic script (no modules) to keep it tiny.
(function () {
  'use strict';
  var CHANNEL = 'sfseed-oauth';
  var params = {};
  function collect(str) {
    if (!str) return;
    str.replace(/^[#?]/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = decodeURIComponent((i < 0 ? pair : pair.slice(0, i)).replace(/\+/g, ' '));
      var v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      params[k] = v;
    });
  }
  collect(window.location.search);
  collect(window.location.hash);
  // Strip secrets from the visible URL and history right away.
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }

  var title = document.getElementById('cb-title');
  var message = document.getElementById('cb-message');
  var msg = { type: CHANNEL, params: params };

  var pending = null;
  try { pending = JSON.parse(window.sessionStorage.getItem('sfseed.oauth.pending') || 'null'); } catch (e) { pending = null; }

  if (pending && pending.mode === 'redirect' && pending.state === params.state) {
    // Same-tab redirect fallback: park the result for the app and go back.
    try { window.sessionStorage.setItem('sfseed.oauth.result', JSON.stringify(params)); } catch (e) { /* ignore */ }
    window.location.replace('/');
    return;
  }

  var delivered = false;
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, window.location.origin);
      delivered = true;
    }
  } catch (e) { /* opener may be severed by cross-origin isolation */ }
  try {
    var bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(msg);
    bc.close();
    delivered = true;
  } catch (e) { /* older browser */ }

  if (params.error) {
    title.textContent = 'Sign-in failed';
    message.textContent = (params.error_description || params.error) + ' — return to the Seeder window for details.';
  } else if (delivered) {
    title.textContent = 'Signed in';
    message.textContent = 'Returning to the Seeder…';
  } else {
    title.textContent = 'Could not reach the Seeder window';
    message.textContent = 'Close this window and click Connect again. If it keeps happening, allow pop-ups for this site.';
  }
  setTimeout(function () { try { window.close(); } catch (e) { /* ignore */ } }, delivered ? 400 : 4000);
})();
