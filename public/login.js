const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');
const emailInput = document.getElementById('login-email');

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `inline-status ${type || ''}`;
}

(async function init() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.authenticated) window.location.href = '/';
  } catch {
    /* API injoignable : on laisse le formulaire de connexion, l'erreur remontera à la soumission */
  }
})();

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  const password = document.getElementById('login-password').value;

  setStatus(loginStatus, 'Connexion…', 'pending');
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Identifiant ou mot de passe incorrect.');

    window.location.href = '/';
  } catch (err) {
    setStatus(loginStatus, err.message, 'error');
  }
});

document.getElementById('resend-activation').addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) {
    setStatus(loginStatus, 'Renseigne ton email ci-dessus avant de demander le renvoi.', 'error');
    return;
  }

  setStatus(loginStatus, 'Envoi…', 'pending');
  try {
    const res = await fetch('/api/resend-activation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    setStatus(loginStatus, data.message || 'Si un compte existe, un email a été renvoyé.', 'success');
  } catch {
    setStatus(loginStatus, 'Impossible de contacter le serveur.', 'error');
  }
});
