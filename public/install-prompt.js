(function () {
  const DISMISS_KEY = 'mailer.installDismissedAt';
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    });
  }

  function dismissedRecently() {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    return Date.now() - Number(raw) < SEVEN_DAYS_MS;
  }

  let deferredPrompt = null;
  let banner = null;

  function injectBanner() {
    const style = document.createElement('style');
    style.textContent = `
      .install-banner-x {
        position: fixed;
        left: 16px;
        right: 16px;
        bottom: 16px;
        z-index: 65;
        max-width: 480px;
        margin: 0 auto;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 16px;
        border-radius: 18px;
        background: color-mix(in srgb, var(--surface, #fff) 82%, transparent);
        backdrop-filter: blur(18px) saturate(160%);
        -webkit-backdrop-filter: blur(18px) saturate(160%);
        border: 1px solid var(--border, #dfe4ea);
        box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 24px 48px -20px rgba(0,0,0,0.5);
        opacity: 0;
        transform: translateY(16px) scale(0.98);
        transition: opacity 0.35s ease, transform 0.35s cubic-bezier(.2,.8,.2,1);
      }
      .install-banner-x.show { opacity: 1; transform: translateY(0) scale(1); }
      @media (max-width: 780px) {
        .install-banner-x { bottom: calc(var(--bottomnav-h, 64px) + 24px + env(safe-area-inset-bottom, 0px)); }
      }
      .install-banner-x-icon {
        flex-shrink: 0;
        width: 38px;
        height: 38px;
        border-radius: 11px;
        background: linear-gradient(155deg, var(--teal, #1c7c74), var(--navy, #12232e));
        display: flex;
        align-items: center;
        justify-content: center;
        color: #fff;
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.14);
      }
      .install-banner-x-body { flex: 1; min-width: 0; }
      .install-banner-x-title { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--text, #16202a); }
      .install-banner-x-actions { display: flex; gap: 8px; flex-shrink: 0; }
      .install-banner-x-btn {
        border: 1px solid transparent;
        font-family: inherit;
        font-weight: 700;
        font-size: 12.5px;
        padding: 8px 13px;
        border-radius: 999px;
        cursor: pointer;
      }
      .install-banner-x-btn.primary { background: var(--navy, #12232e); color: var(--surface, #fff); }
      .install-banner-x-btn.primary:hover { opacity: 0.9; }
      .install-banner-x-btn.ghost { background: transparent; border-color: var(--border, #dfe4ea); color: var(--text, #16202a); }
    `;
    document.head.appendChild(style);

    banner = document.createElement('div');
    banner.className = 'install-banner-x';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', "Installer l'application");
    banner.innerHTML = `
      <span class="install-banner-x-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="2" width="16" height="20" rx="2.5" stroke="currentColor" stroke-width="1.7"/>
          <path d="M12 7v7m0 0-3-3m3 3 3-3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <div class="install-banner-x-body">
        <p class="install-banner-x-title">Installer Mailer sur cet appareil ?</p>
      </div>
      <div class="install-banner-x-actions">
        <button type="button" class="install-banner-x-btn ghost" id="install-banner-x-dismiss">Plus tard</button>
        <button type="button" class="install-banner-x-btn primary" id="install-banner-x-accept">Installer</button>
      </div>
    `;
    document.body.appendChild(banner);
    requestAnimationFrame(() => banner.classList.add('show'));

    document.getElementById('install-banner-x-dismiss').addEventListener('click', hideBanner);
    document.getElementById('install-banner-x-dismiss').addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    });

    document.getElementById('install-banner-x-accept').addEventListener('click', async () => {
      hideBanner();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    });
  }

  function hideBanner() {
    if (!banner) return;
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 350);
    banner = null;
  }

  function maybeShow() {
    if (!deferredPrompt || dismissedRecently() || banner) return;
    // Ne jamais superposer la bannière d'installation à celle des cookies —
    // on attend que l'utilisateur ait fermé cette dernière.
    if (window.mailerCookieConsentResolved && !window.mailerCookieConsentResolved()) return;
    injectBanner();
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    maybeShow();
  });

  window.addEventListener('mailer:cookie-consent-resolved', maybeShow);

  window.addEventListener('appinstalled', hideBanner);
})();
