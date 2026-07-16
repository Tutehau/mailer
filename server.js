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
const crypto = require('crypto');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const ENV_PATH = path.join(__dirname, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates');
const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const CONTACTS_PATH = path.join(DATA_DIR, 'contacts.json');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_TYPES = ['particulier', 'professionnel'];

fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
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

const publicDir = path.join(__dirname, 'public');

app.use(express.static(publicDir, { maxAge: isProd ? '1h' : 0 }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: isProd ? '1d' : 0 }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProd ? 30 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, réessaie dans quelques minutes.' },
});
app.use('/api/', apiLimiter);

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
