require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const nodemailer = require('nodemailer');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const ENV_PATH = path.join(__dirname, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_TYPES = ['particulier', 'professionnel'];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ACTIVATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_PATH)) fs.writeFileSync(HISTORY_PATH, '[]');
if (!fs.existsSync(CONTACTS_PATH)) fs.writeFileSync(CONTACTS_PATH, '[]');

function persistEnvValue(key, value) {
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n').filter((line) => !line.startsWith(`${key}=`));
  }
  lines.push(`${key}=${value}`);
  fs.writeFileSync(ENV_PATH, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  process.env[key] = value;
}

function deleteEnvValue(key) {
  if (fs.existsSync(ENV_PATH)) {
    const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n').filter((line) => !line.startsWith(`${key}=`));
    fs.writeFileSync(ENV_PATH, lines.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  }
  delete process.env[key];
}

// A session secret is required to sign session cookies; generate one on first
// run rather than forcing the user to invent and paste a random string.
if (!process.env.SESSION_SECRET) {
  persistEnvValue('SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
}

function seedDefaultTemplate() {
  const seedPath = path.join(TEMPLATES_DIR, 'cerience.json');
  if (fs.existsSync(seedPath)) return;
  const cerienceHtmlPath = path.join(__dirname, 'cerience.html');
  if (!fs.existsSync(cerienceHtmlPath)) return;
  fs.writeFileSync(
    seedPath,
    JSON.stringify(
      {
        id: 'cerience',
        name: 'Arrêt de travail — Cérience',
        to: ['cbouldet@cerience.fr', 'lrobreau@cerience.fr'],
        subject: 'Arrêt de travail - Kéwin Adams',
        html: fs.readFileSync(cerienceHtmlPath, 'utf8'),
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}
seedDefaultTemplate();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(compression());
app.use(morgan(isProd ? 'combined' : 'dev'));

// Reject only genuinely cross-origin requests — compare against the origin the
// request itself was made to (protocol + Host, honoring X-Forwarded-* since
// trust proxy is enabled) rather than a hand-configured value that has to be
// kept in lockstep with wherever the app is actually deployed.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) {
    return res.status(403).json({ error: 'Origine non autorisée.' });
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, logFn: () => {} }),
  secret: process.env.SESSION_SECRET,
  name: 'mailer.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // 'auto' asks express-session to require HTTPS only when the request
    // (including via X-Forwarded-Proto, since trust proxy is set) is
    // actually HTTPS — a fixed `true` would silently drop the cookie and
    // loop the login forever whenever the app is reached over plain HTTP.
    secure: 'auto',
    maxAge: THIRTY_DAYS_MS,
  },
}));

function hasAccount() {
  return Boolean(process.env.APP_USERNAME && process.env.APP_PASSWORD_HASH);
}

function isActivated() {
  return process.env.APP_ACTIVATED === 'true';
}

function issueActivationToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + ACTIVATION_TOKEN_TTL_MS;
  persistEnvValue('APP_ACTIVATION_TOKEN_HASH', hash);
  persistEnvValue('APP_ACTIVATION_TOKEN_EXPIRES', String(expiresAt));
  return token;
}

function consumeActivationToken(token) {
  const storedHash = process.env.APP_ACTIVATION_TOKEN_HASH;
  const expiresAt = Number(process.env.APP_ACTIVATION_TOKEN_EXPIRES || 0);
  if (!storedHash || !token || Date.now() > expiresAt) return false;

  const providedHash = crypto.createHash('sha256').update(token).digest('hex');
  const a = Buffer.from(providedHash);
  const b = Buffer.from(storedHash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  persistEnvValue('APP_ACTIVATED', 'true');
  deleteEnvValue('APP_ACTIVATION_TOKEN_HASH');
  deleteEnvValue('APP_ACTIVATION_TOKEN_EXPIRES');
  return true;
}

function getNotificationTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("Configuration SMTP manquante (SMTP_HOST/SMTP_USER/SMTP_PASS) pour l'envoi des emails de compte.");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function activationEmailHtml({ username, link, expiresAt }) {
  const expiryLabel = new Date(expiresAt).toLocaleString('fr-FR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Activation du compte — Mailer</title>
</head>
<body style="margin:0;padding:0;background:#eef1f4;-webkit-text-size-adjust:100%;font-family:Arial,Helvetica,sans-serif;color:#20272e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef1f4;border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:36px 16px;">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:480px;max-width:480px;background:#ffffff;border:1px solid #dde3e9;border-collapse:separate;border-spacing:0;border-radius:16px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,32,0.05);">
          <tr>
            <td style="height:5px;line-height:5px;font-size:0;background:#12232e;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:36px 36px 8px 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                <tr>
                  <td style="width:44px;height:44px;background:#12232e;border-radius:12px;">
                    <table role="presentation" width="100%" height="44" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle">
                      <span style="color:#4fd0c4;font-size:20px;line-height:1;">&#9993;</span>
                    </td></tr></table>
                  </td>
                  <td style="padding-left:12px;">
                    <p style="margin:0;font-size:14px;line-height:1.3;font-weight:800;color:#12232e;">Mailer</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 36px 0 36px;">
              <h1 style="margin:0 0 14px 0;font-size:21px;line-height:1.3;font-weight:800;color:#12232e;">
                Bienvenue, ${username} 👋
              </h1>
              <p style="margin:0 0 20px 0;font-size:15px;line-height:1.7;color:#2b3947;">
                Ton compte administrateur vient d'être créé. Il ne reste qu'une étape avant de pouvoir t'y connecter : confirmer que cette adresse email t'appartient bien.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 28px 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
                <tr>
                  <td style="border-radius:999px;background:#1c7c74;">
                    <a href="${link}" style="display:inline-block;padding:14px 28px;font-size:15px;line-height:1;font-weight:800;color:#ffffff;text-decoration:none;">
                      Activer mon compte
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0 0;font-size:12.5px;line-height:1.6;color:#7a8492;">
                Ce lien est valable jusqu'au ${expiryLabel}. Si le bouton ne fonctionne pas, copie-colle cette adresse dans ton navigateur :<br>
                <a href="${link}" style="color:#1c7c74;word-break:break-all;">${link}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 36px 30px 36px;border-top:1px solid #e5e9ed;">
              <p style="margin:0;font-size:12.5px;line-height:1.6;color:#7a8492;">
                Si tu n'es pas à l'origine de cette création de compte, ignore simplement cet email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function requireAuthPage(req, res, next) {
  if (!hasAccount()) return res.redirect('/register.html');
  if (!req.session.authenticated) return res.redirect('/login.html');
  next();
}

function requireAuthApi(req, res, next) {
  if (!hasAccount() || !req.session.authenticated) {
    return res.status(401).json({ error: 'Non authentifié.' });
  }
  next();
}

const publicDir = path.join(__dirname, 'public');

app.get(['/', '/index.html'], requireAuthPage, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use(express.static(publicDir, { maxAge: isProd ? '1h' : 0, index: false }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: isProd ? '1d' : 0 }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 30 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie dans quelques minutes.' },
});
app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, réessaie dans quelques minutes.' },
});

app.get('/api/auth/status', (req, res) => {
  res.json({ hasAccount: hasAccount(), authenticated: Boolean(hasAccount() && req.session.authenticated) });
});

app.post('/api/auth/setup', authLimiter, asyncRoute(async (req, res) => {
  if (hasAccount()) return res.status(409).json({ error: 'Un compte existe déjà.' });

  const { username, email, password } = req.body || {};
  const trimmedUser = (username || '').trim();
  const trimmedEmail = (email || '').trim();
  if (!trimmedUser || !password || password.length < 8) {
    return res.status(400).json({ error: "Identifiant requis et mot de passe d'au moins 8 caractères." });
  }
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    return res.status(400).json({ error: "Une adresse email valide est requise pour l'activation du compte." });
  }

  const hash = await bcrypt.hash(password, 12);
  persistEnvValue('APP_USERNAME', trimmedUser);
  persistEnvValue('APP_EMAIL', trimmedEmail);
  persistEnvValue('APP_PASSWORD_HASH', hash);
  persistEnvValue('APP_ACTIVATED', 'false');

  const token = issueActivationToken();
  const link = `${req.protocol}://${req.get('host')}/api/auth/activate?token=${token}`;
  let emailSent = true;
  try {
    const transporter = getNotificationTransporter();
    await transporter.sendMail({
      from: `"Mailer" <${process.env.SMTP_USER}>`,
      to: trimmedEmail,
      subject: 'Active ton compte Mailer',
      html: activationEmailHtml({ username: trimmedUser, link, expiresAt: Date.now() + ACTIVATION_TOKEN_TTL_MS }),
    });
  } catch (err) {
    console.error("Échec de l'envoi de l'email d'activation :", err.message);
    emailSent = false;
  }

  res.json({ ok: true, emailSent });
}));

app.get('/api/auth/activate', (req, res) => {
  const success = consumeActivationToken(req.query.token);
  res.redirect(`/login.html?activated=${success ? '1' : '0'}`);
});

app.post('/api/auth/resend-activation', authLimiter, asyncRoute(async (req, res) => {
  if (!hasAccount()) return res.status(409).json({ error: 'Aucun compte configuré.' });
  if (isActivated()) return res.status(409).json({ error: 'Ce compte est déjà activé.' });

  const { username, password } = req.body || {};
  const valid =
    (username || '').trim() === process.env.APP_USERNAME &&
    (await bcrypt.compare(password || '', process.env.APP_PASSWORD_HASH));
  if (!valid) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });

  const token = issueActivationToken();
  const link = `${req.protocol}://${req.get('host')}/api/auth/activate?token=${token}`;
  try {
    const transporter = getNotificationTransporter();
    await transporter.sendMail({
      from: `"Mailer" <${process.env.SMTP_USER}>`,
      to: process.env.APP_EMAIL,
      subject: 'Active ton compte Mailer',
      html: activationEmailHtml({ username: process.env.APP_USERNAME, link, expiresAt: Date.now() + ACTIVATION_TOKEN_TTL_MS }),
    });
  } catch (err) {
    return res.status(502).json({ error: "Échec de l'envoi : " + err.message });
  }

  res.json({ ok: true });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  if (!hasAccount()) return res.status(409).json({ error: "Aucun compte configuré, crée-en un d'abord." });

  const { username, password } = req.body || {};
  const trimmedUser = (username || '').trim();
  const valid =
    trimmedUser === process.env.APP_USERNAME &&
    (await bcrypt.compare(password || '', process.env.APP_PASSWORD_HASH));

  if (!valid) return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });

  if (!isActivated()) {
    return res.status(403).json({ error: 'Compte non activé. Vérifie tes emails.', code: 'NOT_ACTIVATED' });
  }

  req.session.authenticated = true;
  req.session.username = trimmedUser;
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mailer.sid');
    res.json({ ok: true });
  });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  return requireAuthApi(req, res, next);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
});

function getTransporter(overrides) {
  const user = (overrides && overrides.user) || process.env.GMAIL_USER;
  const pass = (overrides && overrides.pass) || process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error("Identifiants manquants. Renseigne-les dans la section Paramètres de l'application.");
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

function persistCredentials(user, pass) {
  persistEnvValue('GMAIL_USER', user);
  persistEnvValue('GMAIL_APP_PASSWORD', pass);
}

function splitAddresses(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
}

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function slugify(value) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'modele';
}

function listTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function templatePath(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) {
    throw Object.assign(new Error('Identifiant de modèle invalide.'), { status: 400 });
  }
  const resolved = path.resolve(TEMPLATES_DIR, `${id}.json`);
  if (path.dirname(resolved) !== path.resolve(TEMPLATES_DIR)) {
    throw Object.assign(new Error('Identifiant de modèle invalide.'), { status: 400 });
  }
  return resolved;
}

function readHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function appendHistory(entry) {
  const entries = readHistory();
  entries.unshift(entry);
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries.slice(0, 200), null, 2));
}

function readContacts() {
  try {
    return JSON.parse(fs.readFileSync(CONTACTS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeContacts(contacts) {
  fs.writeFileSync(CONTACTS_PATH, JSON.stringify(contacts, null, 2));
}

app.get('/api/whoami', (req, res) => {
  res.json({
    email: process.env.GMAIL_USER || null,
    configured: Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    env: isProd ? 'production' : 'development',
  });
});

app.post('/api/settings', (req, res) => {
  const { gmailUser, gmailAppPassword } = req.body || {};
  const user = (gmailUser || '').trim();
  const pass = (gmailAppPassword || '').trim();

  if (!user || !pass) {
    return res.status(400).json({ error: "Adresse Gmail et mot de passe d'application requis." });
  }
  if (!EMAIL_RE.test(user)) {
    return res.status(400).json({ error: 'Adresse Gmail invalide.' });
  }

  try {
    persistCredentials(user, pass);
    res.json({ ok: true, email: process.env.GMAIL_USER });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Impossible d'enregistrer les identifiants." });
  }
});

app.post('/api/test-connection', asyncRoute(async (req, res) => {
  const { gmailUser, gmailAppPassword } = req.body || {};
  const transporter = getTransporter(
    gmailUser && gmailAppPassword ? { user: gmailUser.trim(), pass: gmailAppPassword.trim() } : undefined
  );
  await transporter.verify();
  res.json({ ok: true });
}));

app.get('/api/templates', (req, res) => {
  res.json(listTemplates());
});

app.get('/api/templates/:id', (req, res) => {
  const file = templatePath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Modèle introuvable.' });
  res.json(JSON.parse(fs.readFileSync(file, 'utf8')));
});

app.post('/api/templates', (req, res) => {
  const { name, to, subject, html } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du modèle est requis.' });
  if (!subject || !html) return res.status(400).json({ error: 'Objet et message requis pour enregistrer un modèle.' });

  const toList = splitAddresses(Array.isArray(to) ? to.join(',') : to || '');
  const id = slugify(name.trim());
  const template = {
    id,
    name: name.trim(),
    to: toList,
    subject,
    html,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(templatePath(id), JSON.stringify(template, null, 2));
  res.json(template);
});

app.delete('/api/templates/:id', (req, res) => {
  const file = templatePath(req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Modèle introuvable.' });
  fs.unlinkSync(file);
  res.json({ ok: true });
});

app.get('/api/contacts', (req, res) => {
  const contacts = readContacts().sort((a, b) => a.name.localeCompare(b.name));
  res.json(contacts);
});

app.post('/api/contacts', (req, res) => {
  const { name, email, phone, type, company, notes } = req.body || {};
  const trimmedName = (name || '').trim();
  const trimmedEmail = (email || '').trim();

  if (!trimmedName) return res.status(400).json({ error: 'Le nom du contact est requis.' });
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!CONTACT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Type de contact invalide (particulier ou professionnel).' });
  }

  const contact = {
    id: crypto.randomUUID(),
    name: trimmedName,
    email: trimmedEmail,
    phone: (phone || '').trim(),
    type,
    company: (company || '').trim(),
    notes: (notes || '').trim(),
    createdAt: new Date().toISOString(),
  };

  const contacts = readContacts();
  contacts.push(contact);
  writeContacts(contacts);
  res.json(contact);
});

app.put('/api/contacts/:id', (req, res) => {
  const contacts = readContacts();
  const index = contacts.findIndex((c) => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Contact introuvable.' });

  const { name, email, phone, type, company, notes } = req.body || {};
  const trimmedName = (name || '').trim();
  const trimmedEmail = (email || '').trim();

  if (!trimmedName) return res.status(400).json({ error: 'Le nom du contact est requis.' });
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!CONTACT_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Type de contact invalide (particulier ou professionnel).' });
  }

  contacts[index] = {
    ...contacts[index],
    name: trimmedName,
    email: trimmedEmail,
    phone: (phone || '').trim(),
    type,
    company: (company || '').trim(),
    notes: (notes || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  writeContacts(contacts);
  res.json(contacts[index]);
});

app.delete('/api/contacts/:id', (req, res) => {
  const contacts = readContacts();
  const next = contacts.filter((c) => c.id !== req.params.id);
  if (next.length === contacts.length) return res.status(404).json({ error: 'Contact introuvable.' });
  writeContacts(next);
  res.json({ ok: true });
});

app.get('/api/history', (req, res) => {
  res.json(readHistory());
});

app.delete('/api/history', (req, res) => {
  fs.writeFileSync(HISTORY_PATH, '[]');
  res.json({ ok: true });
});

app.post('/api/send', upload.array('attachments'), asyncRoute(async (req, res) => {
  const { to, cc, subject, html, text } = req.body;
  const toList = splitAddresses(to);
  const ccList = splitAddresses(cc);

  if (toList.length === 0 || !toList.every((a) => EMAIL_RE.test(a))) {
    return res.status(400).json({ error: 'Le champ "Destinataire" contient une adresse invalide ou est vide.' });
  }
  if (ccList.length && !ccList.every((a) => EMAIL_RE.test(a))) {
    return res.status(400).json({ error: 'Le champ "Cc" contient une adresse invalide.' });
  }
  if (!subject || !subject.trim()) {
    return res.status(400).json({ error: 'Le champ "Objet" est requis.' });
  }
  if (!html && !text) {
    return res.status(400).json({ error: 'Le message est vide.' });
  }

  const attachments = (req.files || []).map((f) => ({
    filename: f.originalname,
    content: f.buffer,
    contentType: f.mimetype,
  }));

  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: toList,
    cc: ccList.length ? ccList : undefined,
    subject: subject.trim(),
    text: text || undefined,
    html: html || undefined,
    attachments,
  });

  appendHistory({
    id: info.messageId || `${Date.now()}`,
    date: new Date().toISOString(),
    to: toList,
    cc: ccList,
    subject: subject.trim(),
    attachments: attachments.map((a) => a.filename),
    status: 'sent',
  });

  res.json({ ok: true, messageId: info.messageId });
}));

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// Centralized error handler — never leak stack traces in production
app.use((err, req, res, next) => {
  console.error(err);
  const message = err.message && !isProd ? err.message : "Une erreur est survenue.";
  res.status(err.status || 500).json({ error: message });
});

const server = app.listen(PORT, () => {
  console.log(`[${isProd ? 'production' : 'development'}] Application disponible sur http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`\n${signal} reçu, arrêt du serveur...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
