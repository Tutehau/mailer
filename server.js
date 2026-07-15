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

// --- Fail fast in production if the app isn't safely configured ---
if (isProd && !process.env.APP_ORIGIN) {
  console.error('APP_ORIGIN manquant dans .env : requis en production pour restreindre les appels API.');
  process.exit(1);
}

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

if (isProd) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== process.env.APP_ORIGIN) {
      return res.status(403).json({ error: 'Origine non autorisée.' });
    }
    next();
  });
}

app.use(express.json({ limit: '256kb' }));

app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, logFn: () => {} }),
  secret: process.env.SESSION_SECRET,
  name: 'mailer.sid',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    // Only require HTTPS-only cookies when actually served over HTTPS —
    // otherwise the browser silently drops the cookie and login loops forever.
    secure: (process.env.APP_ORIGIN || '').startsWith('https'),
    maxAge: THIRTY_DAYS_MS,
  },
}));

function hasAccount() {
  return Boolean(process.env.APP_USERNAME && process.env.APP_PASSWORD_HASH);
}

function requireAuthPage(req, res, next) {
  if (!hasAccount() || !req.session.authenticated) {
    return res.redirect('/login.html');
  }
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

  const { username, password } = req.body || {};
  const trimmedUser = (username || '').trim();
  if (!trimmedUser || !password || password.length < 8) {
    return res.status(400).json({ error: "Identifiant requis et mot de passe d'au moins 8 caractères." });
  }

  const hash = await bcrypt.hash(password, 12);
  persistEnvValue('APP_USERNAME', trimmedUser);
  persistEnvValue('APP_PASSWORD_HASH', hash);

  req.session.authenticated = true;
  req.session.username = trimmedUser;
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
  return path.join(TEMPLATES_DIR, `${id}.json`);
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
