const loginForm = document.getElementById('login-form');
const loginStatus = document.getElementById('login-status');

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `inline-status ${type || ''}`;
}

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
    if (!res.ok) throw new Error(data.error || 'Identifiant ou mot de passe incorrect.');

    window.location.href = '/';
  } catch (err) {
    setStatus(loginStatus, err.message, 'error');
  }
});
