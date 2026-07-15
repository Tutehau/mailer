const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `inline-status ${type || ''}`;
}

function showResendPrompt(username, password) {
  const wrap = document.createElement('div');
  wrap.style.marginTop = '4px';
  wrap.innerHTML = `<button type="button" class="btn btn-outline" style="width:100%;" id="resend-activation-btn">Renvoyer l'email d'activation</button>`;
  loginStatus.after(wrap);

  document.getElementById('resend-activation-btn').addEventListener('click', async () => {
    setStatus(loginStatus, 'Envoi en cours…', 'pending');
    wrap.remove();
    try {
      const res = await fetch('/api/auth/resend-activation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Échec de l'envoi.");
      setStatus(loginStatus, 'Email renvoyé — vérifie ta boîte de réception.', 'success');
    } catch (err) {
      setStatus(loginStatus, err.message, 'error');
    }
  });
}

(function initFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const activated = params.get('activated');
  if (activated === '1') {
    setStatus(loginStatus, 'Compte activé avec succès — tu peux te connecter.', 'success');
  } else if (activated === '0') {
    setStatus(loginStatus, "Lien d'activation invalide ou expiré. Reconnecte-toi pour en demander un nouveau.", 'error');
  }
})();

(async function init() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();

    if (data.authenticated) {
      window.location.href = '/';
      return;
    }
    if (!data.hasAccount) {
      window.location.href = '/register.html';
    }
  } catch {
    /* API injoignable : on laisse le formulaire de connexion, l'erreur remontera à la soumission */
  }
})();

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  setStatus(loginStatus, 'Connexion…', 'pending');
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.code === 'NOT_ACTIVATED') {
        setStatus(loginStatus, data.error, 'error');
        showResendPrompt(username, password);
        return;
      }
      throw new Error(data.error || 'Identifiant ou mot de passe incorrect.');
    }

    window.location.href = '/';
  } catch (err) {
    setStatus(loginStatus, err.message, 'error');
  }
});
