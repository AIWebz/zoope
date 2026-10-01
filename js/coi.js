/* Registers coi-sw.js and reloads once, so zoope runs cross-origin isolated (multi-threaded AI and voice). */
(function () {
  'use strict';
  if (window.crossOriginIsolated || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  var KEY = 'zoope-coi-reload';
  navigator.serviceWorker.register('coi-sw.js').then(function () {
    var reload = function () {
      try { if (sessionStorage.getItem(KEY)) return; sessionStorage.setItem(KEY, '1'); } catch (e) { return; }
      location.reload();
    };
    if (navigator.serviceWorker.controller) reload();
    else navigator.serviceWorker.addEventListener('controllerchange', reload);
  }).catch(function () { /* single-threaded is fine, just slower */ });
})();
