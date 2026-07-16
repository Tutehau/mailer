const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DRAFT_KEY = 'mailer.draft.v1';

/* ---------------------------------------------------------------- */
/* Session                                                            */
/* ---------------------------------------------------------------- */

fetch('/api/me')
  .then((res) => res.json())
  .then((data) => {
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    document.getElementById('account-email').textContent = data.email;
  })
  .catch(() => {});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

/* ---------------------------------------------------------------- */
/* Tabs                                                              */
/* ---------------------------------------------------------------- */

const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('.view');

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabs.forEach((t) => t.classList.toggle('active', t === btn));
    views.forEach((v) => v.classList.toggle('active', v.id === `panel-${target}`));
    if (target === 'templates') loadTemplates();
    if (target === 'history') loadHistory();
    if (target === 'contacts') loadContacts();
  });
});

/* ---------------------------------------------------------------- */
/* Mobile Éditer / Aperçu segmented control                          */
/* ---------------------------------------------------------------- */

const segBtns = document.querySelectorAll('.seg-btn');
const editorCol = document.querySelector('.composer-editor');
const previewCol = document.querySelector('.composer-preview');

segBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    segBtns.forEach((b) => b.classList.toggle('active', b === btn));
    const showPreview = btn.dataset.view === 'preview';
    editorCol.classList.toggle('mobile-hidden', showPreview);
    previewCol.classList.toggle('mobile-active', showPreview);
    if (showPreview) renderPreview();
  });
});

/* ---------------------------------------------------------------- */
/* Live preview                                                      */
/* ---------------------------------------------------------------- */

const previewFrame = document.getElementById('preview-frame');
const messageInput = document.getElementById('message');
const htmlModeToggle = document.getElementById('html-mode');

function renderPreview() {
  const value = messageInput.value;
  const doc = htmlModeToggle.checked
    ? value
    : `<pre style="font-family:-apple-system,sans-serif;white-space:pre-wrap;padding:20px;margin:0;">${escapeHtml(value)}</pre>`;
  previewFrame.srcdoc = doc || '<p style="font-family:-apple-system,sans-serif;color:#888;padding:20px;">Aucun contenu pour le moment…</p>';
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let previewDebounce;
messageInput.addEventListener('input', () => {
  clearTimeout(previewDebounce);
  previewDebounce = setTimeout(renderPreview, 250);
});
htmlModeToggle.addEventListener('change', renderPreview);

/* ---------------------------------------------------------------- */
/* Real-time address validation                                      */
/* ---------------------------------------------------------------- */

function validateAddressField(inputId, errorId) {
  const input = document.getElementById(inputId);
  const error = document.getElementById(errorId);

  function check() {
    const raw = input.value.trim();
    if (!raw) {
      input.classList.remove('invalid');
      error.textContent = '';
      return;
    }
    const addresses = raw.split(',').map((a) => a.trim()).filter(Boolean);
    const bad = addresses.filter((a) => !EMAIL_RE.test(a));
    if (bad.length) {
      input.classList.add('invalid');
      error.textContent = `Adresse invalide : ${bad.join(', ')}`;
    } else {
      input.classList.remove('invalid');
      error.textContent = '';
    }
  }

  input.addEventListener('input', check);
  input.addEventListener('blur', check);
}

validateAddressField('to', 'to-error');
validateAddressField('cc', 'cc-error');

/* ---------------------------------------------------------------- */
/* Draft autosave                                                    */
/* ---------------------------------------------------------------- */

const draftStatus = document.getElementById('draft-status');
const draftFields = ['to', 'cc', 'subject', 'message'];

function saveDraft() {
  const draft = {};
  draftFields.forEach((id) => { draft[id] = document.getElementById(id).value; });
  draft.htmlMode = htmlModeToggle.checked;
  draft.savedAt = new Date().toISOString();
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  draftStatus.textContent = `Brouillon enregistré à ${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
}

function restoreDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return;
  try {
    const draft = JSON.parse(raw);
    draftFields.forEach((id) => {
      if (draft[id]) document.getElementById(id).value = draft[id];
    });
    if (typeof draft.htmlMode === 'boolean') htmlModeToggle.checked = draft.htmlMode;
    draftStatus.textContent = 'Brouillon restauré.';
    renderPreview();
  } catch {
    /* brouillon corrompu, ignoré */
  }
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  draftStatus.textContent = '';
}

let draftDebounce;
document.getElementById('send-form').addEventListener('input', () => {
  clearTimeout(draftDebounce);
  draftDebounce = setTimeout(saveDraft, 600);
});

document.getElementById('new-message').addEventListener('click', () => {
  document.getElementById('send-form').reset();
  htmlModeToggle.checked = true;
  clearDraft();
  renderPreview();
  setStatus('', '');
});

restoreDraft();

/* ---------------------------------------------------------------- */
/* Settings                                                           */
/* ---------------------------------------------------------------- */

const connBadge = document.getElementById('conn-badge');
const envBadge = document.getElementById('env-badge');
const settingsStatus = document.getElementById('settings-status');
const gmailUserInput = document.getElementById('gmail-user');
const gmailPassInput = document.getElementById('gmail-app-password');

function setSettingsStatus(message, type) {
  settingsStatus.textContent = message;
  settingsStatus.className = `inline-status ${type || ''}`;
}

function refreshWhoami() {
  return fetch('/api/whoami')
    .then((res) => res.json())
    .then((data) => {
      if (data.email) gmailUserInput.value = data.email;
      connBadge.textContent = data.configured ? 'Configuré' : 'Non configuré';
      connBadge.className = `status-pill ${data.configured ? 'ok' : ''}`;
      envBadge.textContent = data.env === 'production' ? 'Production' : 'Développement';
      envBadge.className = `env-badge ${data.env === 'production' ? 'prod' : ''}`;
      return data;
    })
    .catch(() => {
      connBadge.textContent = 'Serveur injoignable';
      connBadge.className = 'status-pill bad';
    });
}

refreshWhoami();

document.getElementById('save-settings').addEventListener('click', async () => {
  const gmailUser = gmailUserInput.value.trim();
  const gmailAppPassword = gmailPassInput.value.trim();

  if (!gmailUser || !gmailAppPassword) {
    setSettingsStatus("Renseigne l'adresse Gmail et le mot de passe d'application.", 'error');
    return;
  }

  setSettingsStatus('Enregistrement…', 'pending');
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gmailUser, gmailAppPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Échec de l'enregistrement.");

    setSettingsStatus('Identifiants enregistrés.', 'success');
    gmailPassInput.value = '';
    await refreshWhoami();
  } catch (err) {
    setSettingsStatus(err.message, 'error');
  }
});

document.getElementById('test-connection').addEventListener('click', async () => {
  const gmailUser = gmailUserInput.value.trim();
  const gmailAppPassword = gmailPassInput.value.trim();

  setSettingsStatus('Test de connexion…', 'pending');
  try {
    const res = await fetch('/api/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gmailUser && gmailAppPassword ? { gmailUser, gmailAppPassword } : {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Connexion échouée.');

    setSettingsStatus('Connexion réussie : les identifiants sont valides.', 'success');
  } catch (err) {
    setSettingsStatus(err.message, 'error');
  }
});

/* ---------------------------------------------------------------- */
/* Templates                                                          */
/* ---------------------------------------------------------------- */

const templatesList = document.getElementById('templates-list');
const templateSaveStatus = document.getElementById('template-save-status');

async function loadTemplates() {
  templatesList.innerHTML = '<p class="list-empty">Chargement…</p>';
  try {
    const res = await fetch('/api/templates');
    const templates = await res.json();
    if (!templates.length) {
      templatesList.innerHTML = '<p class="list-empty">Aucun modèle enregistré pour le moment.</p>';
      return;
    }
    templatesList.innerHTML = '';
    templates.forEach((tpl) => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item-main">
          <p class="list-item-title">${escapeHtml(tpl.name)}</p>
          <p class="list-item-meta">${escapeHtml(tpl.subject)}</p>
        </div>
        <div class="list-item-actions">
          <button type="button" class="btn btn-outline btn-sm" data-load="${tpl.id}">Charger</button>
          <button type="button" class="btn btn-danger-outline btn-sm" data-delete="${tpl.id}">Supprimer</button>
        </div>
      `;
      templatesList.appendChild(item);
    });

    templatesList.querySelectorAll('[data-load]').forEach((btn) => {
      btn.addEventListener('click', () => applyTemplate(btn.dataset.load));
    });
    templatesList.querySelectorAll('[data-delete]').forEach((btn) => {
      btn.addEventListener('click', () => deleteTemplate(btn.dataset.delete));
    });
  } catch {
    templatesList.innerHTML = '<p class="list-empty">Impossible de charger les modèles.</p>';
  }
}

async function applyTemplate(id) {
  const res = await fetch(`/api/templates/${id}`);
  if (!res.ok) return;
  const tpl = await res.json();
  document.getElementById('to').value = (tpl.to || []).join(', ');
  document.getElementById('subject').value = tpl.subject || '';
  document.getElementById('message').value = tpl.html || '';
  htmlModeToggle.checked = true;
  renderPreview();
  saveDraft();

  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'composer'));
  views.forEach((v) => v.classList.toggle('active', v.id === 'panel-composer'));
  setStatus('Modèle chargé. Vérifie les champs avant d\'envoyer.', 'success');
}

async function deleteTemplate(id) {
  await fetch(`/api/templates/${id}`, { method: 'DELETE' });
  loadTemplates();
}

document.getElementById('save-template').addEventListener('click', async () => {
  const name = document.getElementById('template-name').value.trim();
  const to = document.getElementById('to').value;
  const subject = document.getElementById('subject').value;
  const html = document.getElementById('message').value;

  if (!name) {
    templateSaveStatus.textContent = 'Donne un nom au modèle.';
    templateSaveStatus.className = 'inline-status error';
    return;
  }
  if (!subject || !html) {
    templateSaveStatus.textContent = "Remplis l'objet et le message dans l'onglet Composer avant d'enregistrer.";
    templateSaveStatus.className = 'inline-status error';
    return;
  }

  templateSaveStatus.textContent = 'Enregistrement…';
  templateSaveStatus.className = 'inline-status pending';
  try {
    const res = await fetch('/api/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, to, subject, html }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec.');

    templateSaveStatus.textContent = 'Modèle enregistré.';
    templateSaveStatus.className = 'inline-status success';
    document.getElementById('template-name').value = '';
    loadTemplates();
  } catch (err) {
    templateSaveStatus.textContent = err.message;
    templateSaveStatus.className = 'inline-status error';
  }
});

/* ---------------------------------------------------------------- */
/* Contacts                                                            */
/* ---------------------------------------------------------------- */

const contactsList = document.getElementById('contacts-list');
const contactStatus = document.getElementById('contact-status');
const contactFormTitle = document.getElementById('contact-form-title');
const contactCancelBtn = document.getElementById('contact-cancel');
let currentContactFilter = 'tous';
let selectedContactType = 'particulier';

document.getElementById('contact-type-picker').querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('contact-type-picker').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    selectedContactType = btn.dataset.contactType;
  });
});

document.getElementById('contact-filter').querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('contact-filter').querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    currentContactFilter = btn.dataset.filter;
    renderContacts(lastContacts);
  });
});

let lastContacts = [];

async function loadContacts() {
  contactsList.innerHTML = '<p class="list-empty">Chargement…</p>';
  try {
    const res = await fetch('/api/contacts');
    lastContacts = await res.json();
    renderContacts(lastContacts);
  } catch {
    contactsList.innerHTML = '<p class="list-empty">Impossible de charger les contacts.</p>';
  }
}

function renderContacts(contacts) {
  const filtered = currentContactFilter === 'tous' ? contacts : contacts.filter((c) => c.type === currentContactFilter);

  if (!filtered.length) {
    contactsList.innerHTML = '<p class="list-empty">Aucun contact pour le moment.</p>';
    return;
  }

  contactsList.innerHTML = '';
  filtered.forEach((c) => {
    const badge = c.type === 'professionnel' ? 'Pro' : 'Particulier';
    const meta = [c.email, c.phone, c.company].filter(Boolean).join(' · ');
    const item = document.createElement('div');
    item.className = 'list-item';
    item.innerHTML = `
      <div class="list-item-main">
        <p class="list-item-title">${escapeHtml(c.name)} <span class="status-pill" style="margin-left:6px;">${badge}</span></p>
        <p class="list-item-meta">${escapeHtml(meta)}</p>
      </div>
      <div class="list-item-actions">
        <button type="button" class="btn btn-outline btn-sm" data-insert="${c.id}">Insérer</button>
        <button type="button" class="btn btn-outline btn-sm" data-edit="${c.id}">Modifier</button>
        <button type="button" class="btn btn-danger-outline btn-sm" data-remove="${c.id}">Supprimer</button>
      </div>
    `;
    contactsList.appendChild(item);
  });

  contactsList.querySelectorAll('[data-insert]').forEach((btn) => {
    btn.addEventListener('click', () => insertContactEmail(btn.dataset.insert));
  });
  contactsList.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => editContact(btn.dataset.edit));
  });
  contactsList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeContact(btn.dataset.remove));
  });
}

function insertContactEmail(id) {
  const contact = lastContacts.find((c) => c.id === id);
  if (!contact) return;
  const toField = document.getElementById('to');
  const existing = toField.value.split(',').map((a) => a.trim()).filter(Boolean);
  if (!existing.includes(contact.email)) existing.push(contact.email);
  toField.value = existing.join(', ');
  toField.dispatchEvent(new Event('input'));

  tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'composer'));
  views.forEach((v) => v.classList.toggle('active', v.id === 'panel-composer'));
}

function editContact(id) {
  const contact = lastContacts.find((c) => c.id === id);
  if (!contact) return;

  document.getElementById('contact-id').value = contact.id;
  document.getElementById('contact-name').value = contact.name;
  document.getElementById('contact-email').value = contact.email;
  document.getElementById('contact-phone').value = contact.phone || '';
  document.getElementById('contact-company').value = contact.company || '';
  document.getElementById('contact-notes').value = contact.notes || '';

  selectedContactType = contact.type;
  document.getElementById('contact-type-picker').querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.contactType === contact.type);
  });

  contactFormTitle.textContent = 'Modifier le contact';
  contactCancelBtn.hidden = false;
  contactStatus.textContent = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetContactForm() {
  document.getElementById('contact-id').value = '';
  document.getElementById('contact-name').value = '';
  document.getElementById('contact-email').value = '';
  document.getElementById('contact-phone').value = '';
  document.getElementById('contact-company').value = '';
  document.getElementById('contact-notes').value = '';
  selectedContactType = 'particulier';
  document.getElementById('contact-type-picker').querySelectorAll('.seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.contactType === 'particulier');
  });
  contactFormTitle.textContent = 'Ajouter un contact';
  contactCancelBtn.hidden = true;
  contactStatus.textContent = '';
}

contactCancelBtn.addEventListener('click', resetContactForm);

async function removeContact(id) {
  await fetch(`/api/contacts/${id}`, { method: 'DELETE' });
  loadContacts();
}

document.getElementById('contact-save').addEventListener('click', async () => {
  const id = document.getElementById('contact-id').value;
  const payload = {
    name: document.getElementById('contact-name').value.trim(),
    email: document.getElementById('contact-email').value.trim(),
    phone: document.getElementById('contact-phone').value.trim(),
    company: document.getElementById('contact-company').value.trim(),
    notes: document.getElementById('contact-notes').value.trim(),
    type: selectedContactType,
  };

  if (!payload.name || !payload.email) {
    contactStatus.textContent = 'Nom et email sont requis.';
    contactStatus.className = 'inline-status error';
    return;
  }

  contactStatus.textContent = 'Enregistrement…';
  contactStatus.className = 'inline-status pending';

  try {
    const res = await fetch(id ? `/api/contacts/${id}` : '/api/contacts', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Échec de l\'enregistrement.');

    contactStatus.textContent = 'Contact enregistré.';
    contactStatus.className = 'inline-status success';
    resetContactForm();
    loadContacts();
  } catch (err) {
    contactStatus.textContent = err.message;
    contactStatus.className = 'inline-status error';
  }
});

/* ---------------------------------------------------------------- */
/* History                                                             */
/* ---------------------------------------------------------------- */

const historyList = document.getElementById('history-list');

async function loadHistory() {
  historyList.innerHTML = '<p class="list-empty">Chargement…</p>';
  try {
    const res = await fetch('/api/history');
    const entries = await res.json();
    if (!entries.length) {
      historyList.innerHTML = '<p class="list-empty">Aucun email envoyé pour le moment.</p>';
      return;
    }
    historyList.innerHTML = '';
    entries.forEach((entry) => {
      const date = new Date(entry.date).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = `
        <div class="list-item-main">
          <p class="list-item-title">${escapeHtml(entry.subject)}</p>
          <p class="list-item-meta">${date} · à ${escapeHtml((entry.to || []).join(', '))}</p>
        </div>
      `;
      historyList.appendChild(item);
    });
  } catch {
    historyList.innerHTML = '<p class="list-empty">Impossible de charger l\'historique.</p>';
  }
}

document.getElementById('clear-history').addEventListener('click', async () => {
  await fetch('/api/history', { method: 'DELETE' });
  loadHistory();
});

/* ---------------------------------------------------------------- */
/* Send                                                                */
/* ---------------------------------------------------------------- */

const form = document.getElementById('send-form');
const statusEl = document.getElementById('status');
const sendBtn = document.getElementById('send-btn');

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `inline-status ${type || ''}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const toValid = !document.getElementById('to').classList.contains('invalid');
  const ccValid = !document.getElementById('cc').classList.contains('invalid');
  if (!toValid || !ccValid) {
    setStatus('Corrige les adresses invalides avant d\'envoyer.', 'error');
    return;
  }

  setStatus('Envoi en cours…', 'pending');
  sendBtn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('to', document.getElementById('to').value);
    formData.append('cc', document.getElementById('cc').value);
    formData.append('subject', document.getElementById('subject').value);

    const message = document.getElementById('message').value;
    if (htmlModeToggle.checked) {
      formData.append('html', message);
    } else {
      formData.append('text', message);
    }

    const files = document.getElementById('attachments').files;
    for (const file of files) {
      formData.append('attachments', file);
    }

    const res = await fetch('/api/send', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Échec de l'envoi.");

    setStatus('Email envoyé avec succès !', 'success');
    form.reset();
    htmlModeToggle.checked = true;
    clearDraft();
    renderPreview();
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

renderPreview();

// PWA install prompt + service worker registration : voir install-prompt.js
