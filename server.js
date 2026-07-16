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
const crypto = require('crypto');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;
const ENV_PATH = path.join(__dirname, '.env');
const DATA_DIR = path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_TYPES = ['particulier', 'professionnel'];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ENCRYPTION_ALGO = 'aes-256-gcm';

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

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

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL et SUPABASE_ANON_KEY sont requis dans .env — arrêt.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Secrets at rest — Gmail app passwords are encrypted before being    */
/* written to the profiles table, never stored in plaintext.           */
/* ------------------------------------------------------------------ */

function getEncryptionKey() {
  if (!process.env.APP_ENCRYPTION_KEY) {
    persistEnvValue('APP_ENCRYPTION_KEY', crypto.randomBytes(32).toString('hex'));
  }
  return Buffer.from(process.env.APP_ENCRYPTION_KEY, 'hex');
}

function encryptSecret(plain) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptSecret(payload) {
  if (!payload) return '';
  const [ivHex, tagHex, dataHex] = payload.split(':');
  if (!ivHex || !tagHex || !dataHex) return '';
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* Supabase — auth + data live in Postgres behind RLS. The server only */
/* ever holds the anon key; every data request is made with the       */
/* signed-in user's own access token so RLS scopes it to their rows.   */
/* ------------------------------------------------------------------ */

// Node 20 has no native WebSocket; supabase-js always spins up a realtime
// client even though this app never subscribes to anything, so it needs a
// transport injected or client construction throws.
const supabaseClientOptions = {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
};

const supabaseAnon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, supabaseClientOptions);

function supabaseForUser(accessToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    ...supabaseClientOptions,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function decodeJwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return (payload.exp || 0) * 1000;
  } catch {
    return 0;
  }
}

// Returns a Supabase client authenticated as the session's user, refreshing
// the access token first if it's expired or about to expire. Returns null
// (and clears the session) if there's no valid session to refresh from.
async function getUserSupabase(req) {
  const { accessToken, refreshToken } = req.session;
  if (!accessToken || !refreshToken) return null;

  if (decodeJwtExpiryMs(accessToken) > Date.now() + 30_000) {
    return supabaseForUser(accessToken);
  }

  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) {
    req.session.destroy(() => {});
    return null;
  }
  req.session.accessToken = data.session.access_token;
  req.session.refreshToken = data.session.refresh_token;
  return supabaseForUser(data.session.access_token);
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
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto', // requires trust proxy — set above
    maxAge: THIRTY_DAYS_MS,
  },
}));

function requireAuthPage(req, res, next) {
  if (!req.session.accessToken) return res.redirect('/login.html');
  next();
}

function requireAuthApi(req, res, next) {
  getUserSupabase(req)
    .then((client) => {
      if (!client) return res.status(401).json({ error: 'Non authentifié.' });
      req.supabase = client;
      req.userId = req.session.userId;
      next();
    })
    .catch(next);
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

function asyncRoute(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function splitAddresses(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);
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

// Supabase/PostgREST error messages are useful for debugging but shouldn't
// leak verbatim to the client in production.
function dbErrorMessage(error, fallback) {
  console.error(error);
  return !isProd && error && error.message ? error.message : fallback;
}

/* ------------------------------------------------------------------ */
/* Auth                                                                 */
/* ------------------------------------------------------------------ */

app.get('/api/bootstrap-status', asyncRoute(async (req, res) => {
  const { data, error } = await supabaseAnon.rpc('has_super_admin');
  // Fail closed: if we can't tell, don't advertise an open admin slot.
  res.json({ superAdminExists: error ? true : Boolean(data) });
}));

app.get('/api/me', asyncRoute(async (req, res) => {
  const client = await getUserSupabase(req);
  if (!client) return res.json({ authenticated: false });

  const { data: profile, error } = await client
    .from('profiles')
    .select('email, role')
    .eq('id', req.session.userId)
    .single();
  if (error || !profile) return res.json({ authenticated: false });

  res.json({ authenticated: true, email: profile.email, role: profile.role });
}));

app.post('/api/register', authLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const trimmedEmail = (email || '').trim().toLowerCase();

  if (!EMAIL_RE.test(trimmedEmail)) {
    return res.status(400).json({ error: 'Adresse email invalide.' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  const { data, error } = await supabaseAnon.auth.signUp({ email: trimmedEmail, password });
  if (error) return res.status(error.status === 422 ? 409 : 400).json({ error: error.message });

  if (data.session) {
    // Instance configured to auto-confirm — log the user in right away.
    req.session.accessToken = data.session.access_token;
    req.session.refreshToken = data.session.refresh_token;
    req.session.userId = data.user.id;
    return res.status(201).json({
      ok: true,
      autoLogin: true,
      message: 'Compte créé et connecté. Configure ton adresse Gmail dans Réglages avant de pouvoir envoyer un email.',
    });
  }

  res.status(201).json({
    ok: true,
    autoLogin: false,
    message: 'Compte créé. Vérifie ta boîte mail pour confirmer ton adresse avant de te connecter.',
  });
}));

app.post('/api/resend-activation', authLimiter, asyncRoute(async (req, res) => {
  const { email } = req.body || {};
  const trimmedEmail = (email || '').trim().toLowerCase();
  if (EMAIL_RE.test(trimmedEmail)) {
    await supabaseAnon.auth.resend({ type: 'signup', email: trimmedEmail }).catch((err) => {
      console.error("Échec du renvoi de l'email de confirmation :", err.message);
    });
  }
  // Same response regardless of outcome, to avoid leaking who's registered.
  res.json({ ok: true, message: "Si un compte existe avec cette adresse, un email de confirmation vient d'être envoyé." });
}));

app.post('/api/login', authLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const trimmedEmail = (email || '').trim().toLowerCase();

  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email: trimmedEmail, password: password || '' });
  if (error || !data.session) {
    return res.status(401).json({ error: 'Email ou mot de passe incorrect, ou compte non confirmé.' });
  }

  req.session.accessToken = data.session.access_token;
  req.session.refreshToken = data.session.refresh_token;
  req.session.userId = data.user.id;
  res.json({ ok: true, email: data.user.email });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('mailer.sid');
    res.json({ ok: true });
  });
});

app.use('/api', (req, res, next) => {
  const openExact = ['/register', '/login', '/logout', '/me', '/resend-activation', '/bootstrap-status'];
  if (openExact.includes(req.path)) return next();
  return requireAuthApi(req, res, next);
});

/* ------------------------------------------------------------------ */
/* App routes — everything below runs as the signed-in user via RLS.   */
/* ------------------------------------------------------------------ */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
});

async function loadProfile(client, userId) {
  const { data, error } = await client
    .from('profiles')
    .select('email, role, gmail_user, gmail_app_password_enc')
    .eq('id', userId)
    .single();
  if (error) throw Object.assign(new Error(dbErrorMessage(error, 'Profil introuvable.')), { status: 404 });
  return data;
}

function getTransporterForUser(profile, overrides) {
  const user = (overrides && overrides.user) || profile.gmail_user;
  const pass = (overrides && overrides.pass) || decryptSecret(profile.gmail_app_password_enc);
  if (!user || !pass) {
    throw new Error("Identifiants manquants. Renseigne-les dans la section Paramètres de l'application.");
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

app.get('/api/whoami', asyncRoute(async (req, res) => {
  const profile = await loadProfile(req.supabase, req.userId);
  res.json({
    email: profile.gmail_user || null,
    accountEmail: profile.email,
    role: profile.role,
    configured: Boolean(profile.gmail_user && profile.gmail_app_password_enc),
    env: isProd ? 'production' : 'development',
  });
}));

app.post('/api/settings', asyncRoute(async (req, res) => {
  const { gmailUser, gmailAppPassword } = req.body || {};
  const user = (gmailUser || '').trim();
  const pass = (gmailAppPassword || '').trim();

  if (!user || !pass) {
    return res.status(400).json({ error: "Adresse Gmail et mot de passe d'application requis." });
  }
  if (!EMAIL_RE.test(user)) {
    return res.status(400).json({ error: 'Adresse Gmail invalide.' });
  }

  const { error } = await req.supabase
    .from('profiles')
    .update({ gmail_user: user, gmail_app_password_enc: encryptSecret(pass) })
    .eq('id', req.userId);
  if (error) return res.status(500).json({ error: dbErrorMessage(error, "Impossible d'enregistrer les identifiants.") });

  res.json({ ok: true, email: user });
}));

app.post('/api/test-connection', asyncRoute(async (req, res) => {
  const { gmailUser, gmailAppPassword } = req.body || {};
  const profile = await loadProfile(req.supabase, req.userId);
  const transporter = getTransporterForUser(
    profile,
    gmailUser && gmailAppPassword ? { user: gmailUser.trim(), pass: gmailAppPassword.trim() } : undefined
  );
  await transporter.verify();
  res.json({ ok: true });
}));

app.get('/api/templates', asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase.from('templates').select('*').order('name');
  if (error) return res.status(500).json({ error: dbErrorMessage(error, 'Impossible de charger les modèles.') });
  res.json(data.map((t) => ({ id: t.id, name: t.name, to: t.to_addresses, subject: t.subject, html: t.html, createdAt: t.created_at })));
}));

app.get('/api/templates/:id', asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase.from('templates').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return res.status(500).json({ error: dbErrorMessage(error, 'Impossible de charger le modèle.') });
  if (!data) return res.status(404).json({ error: 'Modèle introuvable.' });
  res.json({ id: data.id, name: data.name, to: data.to_addresses, subject: data.subject, html: data.html, createdAt: data.created_at });
}));

app.post('/api/templates', asyncRoute(async (req, res) => {
  const { name, to, subject, html } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Le nom du modèle est requis.' });
  if (!subject || !html) return res.status(400).json({ error: 'Objet et message requis pour enregistrer un modèle.' });

  const toList = splitAddresses(Array.isArray(to) ? to.join(',') : to || '');
  const id = slugify(name.trim());

  const { data, error } = await req.supabase
    .from('templates')
    .upsert({ id, name: name.trim(), to_addresses: toList, subject, html }, { onConflict: 'user_id,id' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: dbErrorMessage(error, "Impossible d'enregistrer le modèle.") });

  res.json({ id: data.id, name: data.name, to: data.to_addresses, subject: data.subject, html: data.html, createdAt: data.created_at });
}));

app.delete('/api/templates/:id', asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase.from('templates').delete().eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: dbErrorMessage(error, 'Impossible de supprimer le modèle.') });
  if (!data.length) return res.status(404).json({ error: 'Modèle introuvable.' });
  res.json({ ok: true });
}));

app.get('/api/contacts', asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase.from('contacts').select('*').order('name');
  if (error) return res.status(500).json({ error: dbErrorMessage(error, 'Impossible de charger les contacts.') });
  res.json(data);
}));

function validateContactPayload(body) {
  const { name, email, phone, type, company, notes } = body || {};
  const trimmedName = (name || '').trim();
  const trimmedEmail = (email || '').trim();

  if (!trimmedName) return { error: 'Le nom du contact est requis.' };
  if (!trimmedEmail || !EMAIL_RE.test(trimmedEmail)) return { error: 'Adresse email invalide.' };
  if (!CONTACT_TYPES.includes(type)) return { error: 'Type de contact invalide (particulier ou professionnel).' };

  return {
    value: {
      name: trimmedName,
      email: trimmedEmail,
      phone: (phone || '').trim(),
      type,
      company: (company || '').trim(),
      notes: (notes || '').trim(),
    },
  };
}

app.post('/api/contacts', asyncRoute(async (req, res) => {
  const { error: validationError, value } = validateContactPayload(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await req.supabase.from('contacts').insert(value).select().single();
  if (error) return res.status(500).json({ error: dbErrorMessage(error, "Impossible d'enregistrer le contact.") });
  res.json(data);
}));

app.put('/api/contacts/:id', asyncRoute(async (req, res) => {
  const { error: validationError, value } = validateContactPayload(req.body);
  if (validationError) return res.status(400).json({ error: validationError });

  const { data, error } = await req.supabase
    .from('contacts')
    .update({ ...value, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: dbErrorMessage(error, "Impossible de modifier le contact.") });
  if (!data) return res.status(404).json({ error: 'Contact introuvable.' });
  res.json(data);
}));

app.delete('/api/contacts/:id', asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase.from('contacts').delete().eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: dbErrorMessage(error, 'Impossible de supprimer le contact.') });
  if (!data.length) return res.status(404).json({ error: 'Contact introuvable.' });
  res.json({ ok: true });
}));

app.get('/api/history', asyncRoute(async (req, res) => {
  const { data, error } = await req.supabase
    .from('send_history')
    .select('*')
    .order('date', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ error: dbErrorMessage(error, "Impossible de charger l'historique.") });
  res.json(data.map((h) => ({
    id: h.id,
    date: h.date,
    to: h.to_addresses,
    cc: h.cc_addresses,
    subject: h.subject,
    attachments: h.attachments,
    status: h.status,
  })));
}));

app.delete('/api/history', asyncRoute(async (req, res) => {
  const { error } = await req.supabase.from('send_history').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) return res.status(500).json({ error: dbErrorMessage(error, "Impossible de vider l'historique.") });
  res.json({ ok: true });
}));

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

  const profile = await loadProfile(req.supabase, req.userId);
  const transporter = getTransporterForUser(profile);
  const info = await transporter.sendMail({
    from: profile.gmail_user,
    to: toList,
    cc: ccList.length ? ccList : undefined,
    subject: subject.trim(),
    text: text || undefined,
    html: html || undefined,
    attachments,
  });

  const { error: historyError } = await req.supabase.from('send_history').insert({
    message_id: info.messageId || null,
    to_addresses: toList,
    cc_addresses: ccList,
    subject: subject.trim(),
    attachments: attachments.map((a) => a.filename),
    status: 'sent',
  });
  if (historyError) console.error("Échec de l'enregistrement dans l'historique :", historyError);

  res.json({ ok: true, messageId: info.messageId });
}));

// 404 for unknown API routes
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue.' }));

// Centralized error handler — never leak stack traces in production
app.use((err, req, res, next) => {
  console.error(err);
  const message = err.message && !isProd ? err.message : 'Une erreur est survenue.';
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
