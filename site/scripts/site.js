/* ============================================================
   Switchboard landing page — progressive enhancement only.
   Without JS the page still reads: English copy, dark theme,
   download buttons pointing at the latest release page.
   ============================================================ */
(function () {
  'use strict';

  var REPO = 'lfkdsk/Switchboard';
  var PKG = '@switch-board/cli';
  var root = document.documentElement;

  /* — Language ————————————————————————————————————— */

  var META = {
    en: {
      title: 'Switchboard — a shell on any of your machines',
      desc: 'Run one command on a machine and it shows up in your browser dashboard as a real interactive terminal — even behind NAT. No SSH config, no inbound ports, no VPN.',
      lang: 'Switch to Chinese'
    },
    zh: {
      title: 'Switchboard —— 任意一台机器的终端，就在浏览器里',
      desc: '在一台机器上跑一条命令，它就出现在你的浏览器面板里，点开就是一个真正的交互式终端 —— 哪怕它在 NAT 后面。不配 SSH，不开入站端口，不用 VPN。',
      lang: 'Switch to English'
    }
  };

  function applyLang(lang) {
    var m = META[lang] || META.en;
    root.dataset.lang = lang;
    root.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    document.title = m.title;
    var d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute('content', m.desc);
    var btn = document.getElementById('lang-toggle');
    if (btn) btn.setAttribute('aria-label', m.lang);
  }

  applyLang(root.dataset.lang === 'zh' ? 'zh' : 'en');

  var langBtn = document.getElementById('lang-toggle');
  if (langBtn) {
    langBtn.addEventListener('click', function () {
      var next = root.dataset.lang === 'zh' ? 'en' : 'zh';
      applyLang(next);
      try { localStorage.setItem('sb-lang', next); } catch (e) {}
    });
  }

  /* — Theme ———————————————————————————————————————— */

  var themeBtn = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    root.dataset.theme = theme;
    if (themeBtn) {
      themeBtn.setAttribute('aria-label',
        theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme');
    }
  }
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark');

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var next = root.dataset.theme === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('sb-theme', next); } catch (e) {}
    });
  }

  /* — Copy buttons ————————————————————————————————— */

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject();
      } catch (e) {
        reject(e);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('.copy-btn'), function (btn) {
    var timer;
    btn.addEventListener('click', function () {
      copyText(btn.dataset.copy || '').then(function () {
        btn.classList.add('is-copied');
        clearTimeout(timer);
        timer = setTimeout(function () { btn.classList.remove('is-copied'); }, 1800);
      }).catch(function () { /* clipboard denied — the text is on screen anyway */ });
    });
  });

  /* — Nav hairline once the page scrolls ——————————— */

  var nav = document.querySelector('.nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('is-stuck', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* — Latest release: point the DMG buttons at the real assets ——
     Static hrefs already resolve to the releases page, so a rate-limited
     or offline GitHub API just leaves the page as-authored. */

  function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
    headers: { Accept: 'application/vnd.github+json' }
  }).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (rel) {
    var assets = rel.assets || [];
    var found = [];

    Array.prototype.forEach.call(document.querySelectorAll('[data-dl-asset]'), function (a) {
      var arch = a.dataset.dlAsset;
      var asset = assets.filter(function (x) {
        return /\.dmg$/i.test(x.name) && x.name.indexOf('-' + arch + '.') !== -1;
      })[0];
      if (!asset) return;
      a.href = asset.browser_download_url;
      a.setAttribute('download', '');
      found.push(arch + ' ' + mb(asset.size));
    });

    var note = document.querySelector('[data-release-note]');
    if (note && found.length) {
      var tag = rel.tag_name || '';
      note.textContent = (root.dataset.lang === 'zh')
        ? '最新版本 ' + tag + ' · ' + found.join(' · ') + '。首次打开若被 Gatekeeper 拦下，右键选「打开」。'
        : 'Latest release ' + tag + ' · ' + found.join(' · ') + '. If Gatekeeper objects on first launch, right-click → Open.';
      note.dataset.releaseNoteEn = 'Latest release ' + tag + ' · ' + found.join(' · ') + '. If Gatekeeper objects on first launch, right-click → Open.';
      note.dataset.releaseNoteZh = '最新版本 ' + tag + ' · ' + found.join(' · ') + '。首次打开若被 Gatekeeper 拦下，右键选「打开」。';
      if (langBtn) {
        langBtn.addEventListener('click', function () {
          note.textContent = root.dataset.lang === 'zh'
            ? note.dataset.releaseNoteZh : note.dataset.releaseNoteEn;
        });
      }
    }
  }).catch(function () { /* leave the authored fallback in place */ });

  /* — Current CLI version from npm ——————————————— */

  fetch('https://registry.npmjs.org/' + encodeURIComponent(PKG) + '/latest')
    .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    .then(function (p) {
      if (!p.version) return;
      Array.prototype.forEach.call(
        document.querySelectorAll('#cli-version, #foot-version'),
        function (el) { el.textContent = PKG + ' v' + p.version; }
      );
    })
    .catch(function () { /* the package name alone is still true */ });
})();
