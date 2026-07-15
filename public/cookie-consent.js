(function () {
  const KEY = 'mailer.cookieConsent';

  function resolved() {
    return Boolean(localStorage.getItem(KEY));
  }
  window.mailerCookieConsentResolved = resolved;

  if (resolved()) return;

  function inject() {
    const style = document.createElement('style');
    style.textContent = `
      .cookie-banner {
        position: fixed;
        left: 16px;
        right: 16px;
        bottom: 16px;
        z-index: 70;
        max-width: 480px;
        margin: 0 auto;
        display: flex;
        align-items: flex-start;
        gap: 14px;
        padding: 18px;
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
      .cookie-banner.show { opacity: 1; transform: translateY(0) scale(1); }
      @media (max-width: 780px) {
        .cookie-banner { bottom: calc(var(--bottomnav-h, 64px) + 24px + env(safe-area-inset-bottom, 0px)); }
      }
      .cookie-banner-icon {
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
      .cookie-banner-body { flex: 1; min-width: 0; }
      .cookie-banner-title {
        margin: 0 0 4px 0;
        font-size: 13.5px;
        font-weight: 800;
        color: var(--text, #16202a);
      }
      .cookie-banner-desc {
        margin: 0 0 12px 0;
        font-size: 12.5px;
        line-height: 1.55;
        color: var(--muted, #66707c);
      }
      .cookie-banner-btn {
        border: none;
        background: var(--navy, #12232e);
        color: var(--surface, #fff);
        font-family: inherit;
        font-weight: 700;
        font-size: 13px;
        padding: 9px 16px;
        border-radius: 999px;
        cursor: pointer;
      }
      .cookie-banner-btn:hover { opacity: 0.9; }
    `;
    document.head.appendChild(style);

    const banner = document.createElement('div');
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Information sur les cookies');
    banner.innerHTML = `
      <span class="cookie-banner-icon" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20.5 12.5c0 4.7-3.8 8.5-8.5 8.5S3.5 17.2 3.5 12.5 7.3 4 12 4c.3 0 .5.2.5.5 0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5c0-.2.2-.4.4-.4 1.7.9 2.6 3.1 2.6 5v3.4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
          <circle cx="9.5" cy="12.5" r="1.1" fill="currentColor"/>
          <circle cx="13" cy="16" r="1.1" fill="currentColor"/>
          <circle cx="15.5" cy="11" r="1.1" fill="currentColor"/>
        </svg>
      </span>
      <div class="cookie-banner-body">
        <p class="cookie-banner-title">Cookies essentiels uniquement</p>
        <p class="cookie-banner-desc">Un seul cookie de session, strictement nécessaire pour te garder connecté. Aucun traqueur, aucune publicité, rien de vendu à personne.</p>
        <button type="button" class="cookie-banner-btn" id="cookie-banner-ack">Compris</button>
      </div>
    `;
    document.body.appendChild(banner);

    requestAnimationFrame(() => banner.classList.add('show'));

    document.getElementById('cookie-banner-ack').addEventListener('click', () => {
      localStorage.setItem(KEY, String(Date.now()));
      banner.classList.remove('show');
      setTimeout(() => banner.remove(), 350);
      window.dispatchEvent(new Event('mailer:cookie-consent-resolved'));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject);
  } else {
    inject();
  }
})();
