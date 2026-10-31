/* UI behaviour: live clock, mobile menu, entrance animation. */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  /* Live clock in Central European Time ("9:45 AM, CET" / "CEST" in summer) */
  var clock = document.getElementById('clock');
  var TZ = 'Europe/Berlin';

  function tzLabel(date) {
    try {
      var parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(date);
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === 'timeZoneName') return parts[i].value === 'GMT+2' ? 'CEST' : 'CET';
      }
    } catch (e) {
      /* older browsers: fall through */
    }
    return 'CET';
  }

  function tick() {
    if (!clock) return;
    var now = new Date();
    var time;
    try {
      time = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(now);
    } catch (e) {
      time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    clock.textContent = time + ', ' + tzLabel(now);
  }
  tick();
  setInterval(tick, 15000);

  /* Mobile menu */
  var toggle = document.querySelector('.menu-toggle');
  var menu = document.getElementById('mobile-menu');
  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Close' : 'Menu';
      menu.hidden = !open;
    };
    toggle.addEventListener('click', function () {
      setOpen(menu.hidden);
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) setOpen(false);
    });
  }

  /* Entrance animation once fonts are ready (with a safety timeout) */
  var started = false;
  function reveal() {
    if (started) return;
    started = true;
    requestAnimationFrame(function () {
      root.classList.add('is-ready');
      setTimeout(function () {
        root.classList.add('is-settled');
      }, 2200);
    });
  }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      setTimeout(reveal, 250);
    });
  }
  setTimeout(reveal, 1200);
})();
