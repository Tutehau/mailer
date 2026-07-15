const setupForm = document.getElementById('setup-form');
const setupStatus = document.getElementById('setup-status');

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
    if (data.hasAccount) {
      window.location.href = '/login.html';
    }
  } catch {
    /* API injoignable : on laisse le formulaire de création, l'erreur remontera à la soumission */
  }
})();

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = document.getElementById('setup-username').value.trim();
  const password = document.getElementById('setup-password').value;
  const confirm = document.getElementById('setup-password-confirm').value;

  if (password !== confirm) {
    setStatus(setupStatus, 'Les mots de passe ne correspondent pas.', 'error');
    return;
  }

  setStatus(setupStatus, 'Création du compte…', 'pending');
  try {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec de la création du compte.');

    window.location.href = '/';
  } catch (err) {
    setStatus(setupStatus, err.message, 'error');
  }
});
