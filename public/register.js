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
  const email = document.getElementById('setup-email').value.trim();
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
      body: JSON.stringify({ username, email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec de la création du compte.');

    Array.from(setupForm.elements).forEach((el) => { el.disabled = true; });
    if (data.emailSent) {
      setStatus(setupStatus, `Compte créé ! Un email d'activation a été envoyé à ${email} — clique sur le lien qu'il contient pour te connecter.`, 'success');
    } else {
      setStatus(setupStatus, "Compte créé, mais l'email d'activation n'a pas pu être envoyé (configuration SMTP manquante ou invalide). Contacte l'administrateur du serveur.", 'error');
    }
  } catch (err) {
    setStatus(setupStatus, err.message, 'error');
  }
});
