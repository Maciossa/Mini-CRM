const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// --- DB setup -----------------------------------------------------------
// DB_PATH can point at a Render Disk (e.g. /data/db.json) so data
// survives redeploys. Defaults to a local ./data/db.json for local dev.
const DB_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, 'data');
const DB_FILE = process.env.DB_PATH || path.join(DB_DIR, 'db.json');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const adapter = new FileSync(DB_FILE);
const db = low(adapter);

const STAGES = [
  'Nowy Lead',
  'Do oddzwonienia',
  'Spotkanie Umówione',
  'Follow up (Po prezentacji)',
  'Rezerwacja Ustna',
  'Rezerwacja Wstępna (1%)',
  'Sprzedaż',
  'Stary Lead'
];

const RYNKI = ['pierwotny', 'wtorny'];

db.defaults({ clients: [], activities: [], accounts: [], profiles: [], meta: {} }).write();

// Persistent JWT secret: generated once and stored in the DB so sessions
// survive server restarts (as long as the DB file itself persists).
if (!db.get('meta.jwtSecret').value()) {
  db.set('meta.jwtSecret', crypto.randomBytes(48).toString('hex')).write();
}
const JWT_SECRET = db.get('meta.jwtSecret').value();
const COOKIE_NAME = 'crm_token';
const TOKEN_TTL = '30d';

// --- App setup ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---------------------------------------------------------------
function now() {
  return new Date().toISOString();
}

function publicAccount(a) {
  return { id: a.id, mail: a.mail };
}

function publicProfile(p) {
  return {
    id: p.id,
    imie_nazwisko: p.imie_nazwisko,
    pseudonim: p.pseudonim,
    rynek: p.rynek,
    prowizja_agenta: p.prowizja_agenta || 50
  };
}

// Single JWT cookie carries { accountId, profileId? }. profileId is only
// present once the person has entered a specific profile/CRM workspace.
function issueSession(res, { accountId, profileId }) {
  const token = jwt.sign({ accountId, profileId: profileId || null }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function readToken(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

// Account-level auth: person is logged in, but may not have picked a
// profile (CRM workspace) yet.
function requireAccount(req, res, next) {
  const payload = readToken(req);
  if (!payload) return res.status(401).json({ error: 'Musisz się zalogować.' });
  const account = db.get('accounts').find({ id: payload.accountId }).value();
  if (!account) return res.status(401).json({ error: 'Konto nie istnieje. Zaloguj się ponownie.' });
  req.accountId = account.id;
  next();
}

// Profile-level auth: person is logged in AND has an active profile
// (CRM workspace) selected. All client/activity data is scoped to this.
function requireProfile(req, res, next) {
  const payload = readToken(req);
  if (!payload) return res.status(401).json({ error: 'Musisz się zalogować.' });
  const account = db.get('accounts').find({ id: payload.accountId }).value();
  if (!account) return res.status(401).json({ error: 'Konto nie istnieje. Zaloguj się ponownie.' });
  if (!payload.profileId) return res.status(401).json({ error: 'Wybierz profil.' });
  const profile = db.get('profiles').find({ id: payload.profileId, account_id: account.id }).value();
  if (!profile) return res.status(401).json({ error: 'Nie znaleziono profilu.' });
  req.accountId = account.id;
  req.profileId = profile.id;
  next();
}

// --- ACCOUNT (mail + password) --------------------------------------------

app.post('/api/account/register', async (req, res) => {
  const { mail, password } = req.body;
  if (!mail || !password) {
    return res.status(400).json({ error: 'Mail i hasło są wymagane.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Hasło musi mieć co najmniej 6 znaków.' });
  }
  const mailNorm = String(mail).trim().toLowerCase();
  const taken = db.get('accounts').find(a => a.mail.toLowerCase() === mailNorm).value();
  if (taken) return res.status(409).json({ error: 'Konto z tym adresem mail już istnieje.' });

  const password_hash = await bcrypt.hash(String(password), 10);
  const account = { id: uuidv4(), mail: mailNorm, password_hash, created_at: now() };
  db.get('accounts').push(account).write();
  issueSession(res, { accountId: account.id });
  res.status(201).json(publicAccount(account));
});

app.post('/api/account/login', async (req, res) => {
  const { mail, password } = req.body;
  if (!mail || !password) {
    return res.status(400).json({ error: 'Mail i hasło są wymagane.' });
  }
  const mailNorm = String(mail).trim().toLowerCase();
  const account = db.get('accounts').find(a => a.mail.toLowerCase() === mailNorm).value();
  if (!account) return res.status(401).json({ error: 'Nieprawidłowy mail lub hasło.' });

  const ok = await bcrypt.compare(String(password), account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Nieprawidłowy mail lub hasło.' });

  issueSession(res, { accountId: account.id });
  res.json(publicAccount(account));
});

app.post('/api/account/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
});

// Returns the logged-in account plus the currently active profile (if any
// is selected and still valid), in one call for a simple frontend bootstrap.
app.get('/api/session', requireAccount, (req, res) => {
  const account = db.get('accounts').find({ id: req.accountId }).value();
  const payload = readToken(req);
  let profile = null;
  if (payload.profileId) {
    const p = db.get('profiles').find({ id: payload.profileId, account_id: account.id }).value();
    if (p) profile = publicProfile(p);
  }
  res.json({ account: publicAccount(account), profile });
});

// --- PROFILES (CRM workspaces belonging to an account) ---------------------

app.get('/api/profiles/markets', (req, res) => {
  res.json(RYNKI);
});

// List profiles for the LOGGED-IN account only — never visible to others.
app.get('/api/profiles', requireAccount, (req, res) => {
  const list = db.get('profiles')
    .filter({ account_id: req.accountId })
    .map(publicProfile)
    .value()
    .sort((a, b) => a.pseudonim.localeCompare(b.pseudonim, 'pl'));
  res.json(list);
});

app.post('/api/profiles', requireAccount, (req, res) => {
  const { imie_nazwisko, pseudonim, rynek } = req.body;
  if (!imie_nazwisko || !pseudonim || !rynek) {
    return res.status(400).json({ error: 'Imię i nazwisko, pseudonim oraz rynek są wymagane.' });
  }
  if (!RYNKI.includes(rynek)) {
    return res.status(400).json({ error: 'Nieprawidłowy rynek.' });
  }
  const pseudonimNorm = String(pseudonim).trim();
  const taken = db.get('profiles')
    .find(p => p.account_id === req.accountId && p.pseudonim.toLowerCase() === pseudonimNorm.toLowerCase())
    .value();
  if (taken) return res.status(409).json({ error: 'Masz już profil z tym pseudonimem.' });

  const profile = {
    id: uuidv4(),
    account_id: req.accountId,
    imie_nazwisko: String(imie_nazwisko).trim(),
    pseudonim: pseudonimNorm,
    rynek,
    prowizja_agenta: 50,
    created_at: now()
  };
  db.get('profiles').push(profile).write();
  issueSession(res, { accountId: req.accountId, profileId: profile.id });
  res.status(201).json(publicProfile(profile));
});

// Enter an existing profile (no password needed — the account is already
// authenticated; this just switches the active CRM workspace).
app.post('/api/profiles/:id/select', requireAccount, (req, res) => {
  const profile = db.get('profiles').find({ id: req.params.id, account_id: req.accountId }).value();
  if (!profile) return res.status(404).json({ error: 'Nie znaleziono profilu.' });
  issueSession(res, { accountId: req.accountId, profileId: profile.id });
  res.json(publicProfile(profile));
});

app.get('/api/profiles/me', requireProfile, (req, res) => {
  const profile = db.get('profiles').find({ id: req.profileId }).value();
  res.json(publicProfile(profile));
});

const ALLOWED_SPLITS = [45, 50, 55, 60];
app.put('/api/profiles/me/settings', requireProfile, (req, res) => {
  const { prowizja_agenta } = req.body;
  const val = Number(prowizja_agenta);
  if (!ALLOWED_SPLITS.includes(val)) {
    return res.status(400).json({ error: 'Podział prowizji musi wynosić 45%, 50%, 55% lub 60%.' });
  }
  db.get('profiles').find({ id: req.profileId }).assign({ prowizja_agenta: val }).write();
  res.json(publicProfile(db.get('profiles').find({ id: req.profileId }).value()));
});

// Lets the frontend warn the user if the database file is NOT on a
// persistent disk (i.e. it will be wiped on the next redeploy).
app.get('/api/system/status', (req, res) => {
  res.json({ persistent: Boolean(process.env.DB_PATH) });
});

// --- STAGES (public, static) ------------------------------------------------

app.get('/api/stages', (req, res) => {
  res.json(STAGES);
});

// Every route below requires an active profile (CRM workspace) and is
// scoped to that profile only.
app.use('/api/clients', requireProfile);
app.use('/api/activities', requireProfile);
app.use('/api/backup', requireProfile);

// --- CLIENTS (used for both Deals board and Contacts list) ----------------

app.get('/api/clients', (req, res) => {
  res.json(db.get('clients').filter({ profile_id: req.profileId }).value());
});

app.post('/api/clients', (req, res) => {
  const { imie, nazwisko, mail, telefon, preferencje, stage, inwestycja, cena_nieruchomosci, prowizja_procent } = req.body;
  if (!imie || !nazwisko) {
    return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });
  }
  const client = {
    id: uuidv4(),
    profile_id: req.profileId,
    imie,
    nazwisko,
    mail: mail || '',
    telefon: telefon || '',
    preferencje: preferencje || '',
    inwestycja: inwestycja || '',
    cena_nieruchomosci: cena_nieruchomosci !== undefined && cena_nieruchomosci !== '' ? Number(cena_nieruchomosci) : null,
    prowizja_procent: prowizja_procent !== undefined && prowizja_procent !== '' ? Number(prowizja_procent) : null,
    stage: STAGES.includes(stage) ? stage : STAGES[0],
    created_at: now(),
    updated_at: now()
  };
  db.get('clients').push(client).write();
  res.status(201).json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const client = db.get('clients').find({ id: req.params.id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const allowed = ['imie', 'nazwisko', 'mail', 'telefon', 'preferencje', 'stage', 'inwestycja', 'cena_nieruchomosci', 'prowizja_procent'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.stage && !STAGES.includes(updates.stage)) {
    return res.status(400).json({ error: 'Nieprawidłowy etap.' });
  }
  if (updates.cena_nieruchomosci !== undefined) {
    updates.cena_nieruchomosci = updates.cena_nieruchomosci === '' ? null : Number(updates.cena_nieruchomosci);
  }
  if (updates.prowizja_procent !== undefined) {
    updates.prowizja_procent = updates.prowizja_procent === '' ? null : Number(updates.prowizja_procent);
  }
  updates.updated_at = now();

  db.get('clients').find({ id: req.params.id, profile_id: req.profileId }).assign(updates).write();
  res.json(db.get('clients').find({ id: req.params.id, profile_id: req.profileId }).value());
});

app.delete('/api/clients/:id', (req, res) => {
  db.get('clients').remove({ id: req.params.id, profile_id: req.profileId }).write();
  db.get('activities').remove({ client_id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

// --- ACTIVITIES -------------------------------------------------------------

app.get('/api/activities', (req, res) => {
  const clients = db.get('clients').filter({ profile_id: req.profileId }).value();
  const activities = db.get('activities').filter({ profile_id: req.profileId }).value().map(a => {
    const client = clients.find(c => c.id === a.client_id);
    return {
      ...a,
      client_name: client ? `${client.imie} ${client.nazwisko}` : '(usunięty klient)',
      client_phone: client ? client.telefon : '',
      client_mail: client ? client.mail : '',
      client_preferencje: client ? client.preferencje : ''
    };
  });
  res.json(activities);
});

app.post('/api/activities', (req, res) => {
  const { client_id, action_name, date, notes, time } = req.body;
  if (!client_id || !action_name || !date) {
    return res.status(400).json({ error: 'client_id, action_name i date są wymagane.' });
  }
  const client = db.get('clients').find({ id: client_id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const activity = {
    id: uuidv4(),
    profile_id: req.profileId,
    client_id,
    action_name,
    date,
    time: time || '',
    notes: notes || '',
    done: false,
    created_at: now()
  };
  db.get('activities').push(activity).write();
  res.status(201).json(activity);
});

app.put('/api/activities/:id', (req, res) => {
  const activity = db.get('activities').find({ id: req.params.id, profile_id: req.profileId }).value();
  if (!activity) return res.status(404).json({ error: 'Nie znaleziono akcji.' });

  const allowed = ['action_name', 'date', 'time', 'notes', 'done', 'client_id'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.client_id && !db.get('clients').find({ id: updates.client_id, profile_id: req.profileId }).value()) {
    return res.status(404).json({ error: 'Nie znaleziono klienta.' });
  }
  db.get('activities').find({ id: req.params.id, profile_id: req.profileId }).assign(updates).write();
  res.json(db.get('activities').find({ id: req.params.id, profile_id: req.profileId }).value());
});

app.delete('/api/activities/:id', (req, res) => {
  db.get('activities').remove({ id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

// --- BACKUP / RESTORE (safety net independent of Render Disks) -----------

app.get('/api/backup/export', (req, res) => {
  res.json({
    exported_at: now(),
    clients: db.get('clients').filter({ profile_id: req.profileId }).value(),
    activities: db.get('activities').filter({ profile_id: req.profileId }).value()
  });
});

app.post('/api/backup/import', (req, res) => {
  const { clients: importedClients, activities: importedActivities } = req.body;
  if (!Array.isArray(importedClients) || !Array.isArray(importedActivities)) {
    return res.status(400).json({ error: 'Nieprawidłowy plik kopii zapasowej.' });
  }

  const idMap = {};
  const newClients = importedClients.map(c => {
    const newId = uuidv4();
    idMap[c.id] = newId;
    return { ...c, id: newId, profile_id: req.profileId };
  });
  const newActivities = importedActivities.map(a => ({
    ...a,
    id: uuidv4(),
    profile_id: req.profileId,
    client_id: idMap[a.client_id] || a.client_id
  })).filter(a => newClients.some(c => c.id === a.client_id));

  db.get('clients').push(...newClients).write();
  db.get('activities').push(...newActivities).write();

  res.json({ imported_clients: newClients.length, imported_activities: newActivities.length });
});

// --- Fallback: serve the SPA for any other route --------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mini CRM listening on port ${PORT}`);
});
