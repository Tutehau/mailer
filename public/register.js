const registerForm = document.getElementById('register-form');
const registerStatus = document.getElementById('register-status');
const bootstrapNotice = document.getElementById('bootstrap-notice');

function setStatus(el, message, type) {
  el.textContent = message;
  el.className = `inline-status ${type || ''}`;
}

(async function init() {
  try {
    const meRes = await fetch('/api/me');
    const me = await meRes.json();
    if (me.authenticated) {
      window.location.href = '/';
      return;
    }
  } catch {
    /* API injoignable : on laisse le formulaire de création, l'erreur remontera à la soumission */
  }

  try {
    const bootstrapRes = await fetch('/api/bootstrap-status');
    const bootstrap = await bootstrapRes.json();
    if (!bootstrap.superAdminExists) {
      bootstrapNotice.hidden = false;
      setStatus(bootstrapNotice, "Aucun administrateur configuré pour le moment. L'adresse désignée comme super admin le deviendra automatiquement en s'inscrivant.", '');
    }
  } catch {
    /* pas bloquant */
  }
})();

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const confirm = document.getElementById('register-password-confirm').value;

  if (password !== confirm) {
    setStatus(registerStatus, 'Les mots de passe ne correspondent pas.', 'error');
    return;
  }

  setStatus(registerStatus, 'Création du compte…', 'pending');
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Échec de la création du compte.");

    setStatus(registerStatus, data.message, 'success');
    if (data.autoLogin) {
      window.location.href = '/';
    } else {
      registerForm.reset();
    }
  } catch (err) {
    setStatus(registerStatus, err.message, 'error');
  }
});
