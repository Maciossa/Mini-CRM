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
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const PDFDocument = require('pdfkit');

async function extractPdfText(buffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('') + '\n';
  }
  return text;
}

const DB_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, 'data');
const DB_FILE = process.env.DB_PATH || path.join(DB_DIR, 'db.json');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const adapter = new FileSync(DB_FILE);
const db = low(adapter);

const BACKUP_DIR = path.join(DB_DIR, 'backups');
const MAX_BACKUPS = 30;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

let lastBackupSignature = null;

function writeSnapshot(reason) {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    if (!raw || raw.length < 2) return;
    const signature = crypto.createHash('sha1').update(raw).digest('hex');
    if (signature === lastBackupSignature) return;
    JSON.parse(raw);
    lastBackupSignature = signature;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(BACKUP_DIR, 'db-' + stamp + '-' + reason + '.json'), raw);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-')).sort();
    while (files.length > MAX_BACKUPS) {
      const oldest = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, oldest)); } catch (e) { }
    }
  } catch (e) {
    console.error('Backup snapshot failed:', e.message);
  }
}

setInterval(() => writeSnapshot('auto'), BACKUP_INTERVAL_MS).unref();
['SIGTERM', 'SIGINT'].forEach(sig => process.on(sig, () => {
  writeSnapshot('shutdown');
  process.exit(0);
}));

const STAGES = [
  'Nowy Lead',
  'Do oddzwonienia',
  'Spotkanie Umowione',
  'Follow up (Po prezentacji)',
  'Rezerwacja Ustna',
  'Rezerwacja Wstepna (1%)',
  'Sprzedaz',
  'Stary Lead'
  ];

const RYNKI = ['pierwotny', 'wtorny'];

const ADMIN_EMAILS = [
  'cezary5522@gmail.com',
  'maciekmalicki060503@gmail.com',
  'm.malicki@freedom.pl',
  'c.pelak@freedom.pl'
  ];

db.defaults({
  clients: [],
  researchPdfs: [],
  activities: [],
  accounts: [],
  profiles: [],
  researchReports: [],
  meta: {}
}).write();

if (!db.get('meta.jwtSecret').value()) {
  db.set('meta.jwtSecret', crypto.randomBytes(48).toString('hex')).write();
}
const JWT_SECRET = db.get('meta.jwtSecret').value();
writeSnapshot('boot');
const COOKIE_NAME = 'crm_token';
const TOKEN_TTL = '30d';

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

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
    prowizja_agenta: p.prowizja_agenta || 50,
    stages: (Array.isArray(p.stages) && p.stages.length === STAGES.length) ? p.stages : STAGES,
    theme: p.theme === 'dark' ? 'dark' : 'light'
  };
}

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

function requireAccount(req, res, next) {
  const payload = readToken(req);
  if (!payload) return res.status(401).json({ error: 'Musisz sie zalogowac.' });
  const account = db.get('accounts').find({ id: payload.accountId }).value();
  if (!account) return res.status(401).json({ error: 'Konto nie istnieje. Zaloguj sie ponownie.' });
  req.accountId = account.id;
  next();
}

function requireProfile(req, res, next) {
  const payload = readToken(req);
  if (!payload) return res.status(401).json({ error: 'Musisz sie zalogowac.' });
  const account = db.get('accounts').find({ id: payload.accountId }).value();
  if (!account) return res.status(401).json({ error: 'Konto nie istnieje. Zaloguj sie ponownie.' });
  if (!payload.profileId) return res.status(401).json({ error: 'Wybierz profil.' });
  const profile = db.get('profiles').find({ id: payload.profileId, account_id: account.id }).value();
  if (!profile) return res.status(401).json({ error: 'Nie znaleziono profilu.' });
  req.accountId = account.id;
  req.profileId = profile.id;
  next();
}

function requireAdmin(req, res, next) {
  const account = db.get('accounts').find({ id: req.accountId }).value();
  if (!account || !ADMIN_EMAILS.includes(account.mail)) {
    return res.status(403).json({ error: 'Brak dostepu do Admin Panelu.' });
  }
  next();
}

app.post('/api/account/register', async (req, res) => {
  const { mail, password } = req.body;
  if (!mail || !password) {
    return res.status(400).json({ error: 'Mail i haslo sa wymagane.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Haslo musi miec co najmniej 6 znakow.' });
  }
  const mailNorm = String(mail).trim().toLowerCase();
  const taken = db.get('accounts').find(a => a.mail.toLowerCase() === mailNorm).value();
  if (taken) return res.status(409).json({ error: 'Konto z tym adresem mail juz istnieje.' });
  const password_hash = await bcrypt.hash(String(password), 10);
  const account = { id: uuidv4(), mail: mailNorm, password_hash, created_at: now() };
  db.get('accounts').push(account).write();
  issueSession(res, { accountId: account.id });
  res.status(201).json(publicAccount(account));
});

app.post('/api/account/login', async (req, res) => {
  const { mail, password } = req.body;
  if (!mail || !password) {
    return res.status(400).json({ error: 'Mail i haslo sa wymagane.' });
  }
  const mailNorm = String(mail).trim().toLowerCase();
  const account = db.get('accounts').find(a => a.mail.toLowerCase() === mailNorm).value();
  if (!account) return res.status(401).json({ error: 'Nieprawidlowy mail lub haslo.' });
  const ok = await bcrypt.compare(String(password), account.password_hash);
  if (!ok) return res.status(401).json({ error: 'Nieprawidlowy mail lub haslo.' });
  issueSession(res, { accountId: account.id });
  res.json(publicAccount(account));
});

app.post('/api/account/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
});

app.get('/api/session', requireAccount, (req, res) => {
  const account = db.get('accounts').find({ id: req.accountId }).value();
  const payload = readToken(req);
  let profile = null;
  if (payload.profileId) {
    const p = db.get('profiles').find({ id: payload.profileId, account_id: account.id }).value();
    if (p) profile = publicProfile(p);
  }
  res.json({ account: publicAccount(account), profile, isAdmin: ADMIN_EMAILS.includes(account.mail) });
});

app.get('/api/profiles/markets', (req, res) => {
  res.json(RYNKI);
});

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
    return res.status(400).json({ error: 'Imie i nazwisko, pseudonim oraz rynek sa wymagane.' });
  }
  if (!RYNKI.includes(rynek)) {
    return res.status(400).json({ error: 'Nieprawidlowy rynek.' });
  }
  const pseudonimNorm = String(pseudonim).trim();
  const taken = db.get('profiles')
  .find(p => p.account_id === req.accountId && p.pseudonim.toLowerCase() === pseudonimNorm.toLowerCase())
  .value();
  if (taken) return res.status(409).json({ error: 'Masz juz profil z tym pseudonimem.' });
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
  const { prowizja_agenta, stages, theme } = req.body;
  const updates = {};
  if (prowizja_agenta !== undefined) {
    const val = Number(prowizja_agenta);
    if (!ALLOWED_SPLITS.includes(val)) {
      return res.status(400).json({ error: 'Podzial prowizji musi wynosic 45%, 50%, 55% lub 60%.' });
    }
    updates.prowizja_agenta = val;
  }
  if (stages !== undefined) {
    if (!Array.isArray(stages) || stages.length !== STAGES.length) {
      return res.status(400).json({ error: 'Lista etapow musi zawierac dokladnie ' + STAGES.length + ' pozycji.' });
    }
    const cleaned = stages.map(s => String(s || '').trim());
    if (cleaned.some(s => !s)) {
      return res.status(400).json({ error: 'Nazwy etapow nie moga byc puste.' });
    }
    if (new Set(cleaned.map(s => s.toLowerCase())).size !== cleaned.length) {
      return res.status(400).json({ error: 'Nazwy etapow musza byc unikalne.' });
    }
    const profile = db.get('profiles').find({ id: req.profileId }).value();
    const oldStages = (Array.isArray(profile.stages) && profile.stages.length === STAGES.length) ? profile.stages : STAGES;
    oldStages.forEach((oldName, i) => {
      if (oldName !== cleaned[i]) {
        db.get('clients')
        .filter({ profile_id: req.profileId, stage: oldName })
        .each(c => { c.stage = cleaned[i]; })
        .write();
      }
    });
    updates.stages = cleaned;
  }
  if (theme !== undefined) {
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Nieprawidlowy motyw.' });
    }
    updates.theme = theme;
  }
  db.get('profiles').find({ id: req.profileId }).assign(updates).write();
  res.json(publicProfile(db.get('profiles').find({ id: req.profileId }).value()));
});

app.get('/api/system/status', (req, res) => {
  res.json({ persistent: Boolean(process.env.DB_PATH) });
});

app.get('/api/stages', (req, res) => {
  const payload = readToken(req);
  if (payload && payload.profileId) {
    const p = db.get('profiles').find({ id: payload.profileId }).value();
    if (p && Array.isArray(p.stages) && p.stages.length === STAGES.length) {
      return res.json(p.stages);
    }
  }
  res.json(STAGES);
});

app.use('/api/clients', requireProfile);
app.use('/api/activities', requireProfile);
app.use('/api/backup', requireProfile);

app.get('/api/clients', (req, res) => {
  res.json(db.get('clients').filter({ profile_id: req.profileId }).value());
});

app.post('/api/clients', (req, res) => {
  const { imie, nazwisko, mail, telefon, preferencje, stage, inwestycja, cena_nieruchomosci, prowizja_procent } = req.body;
  if (!imie || !nazwisko) {
    return res.status(400).json({ error: 'Imie i nazwisko sa wymagane.' });
  }
  const prof = db.get('profiles').find({ id: req.profileId }).value();
  const activeStages = (prof && Array.isArray(prof.stages) && prof.stages.length === STAGES.length) ? prof.stages : STAGES;
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
    stage: activeStages.includes(stage) ? stage : activeStages[0],
    budget_min: null,
    budget_max: null,
    pref_locations: '',
    max_transit_min: null,
    rooms_min: null,
    rooms_max: null,
    area_min: null,
    area_max: null,
    floor_min: null,
    floor_max: null,
    needs_balcony: false,
    needs_parking: false,
    needs_elevator: false,
    ready_by: '',
    pref_notes: '',
    pref_weights: null,
    deal_status: null,
    deal_month: null,
    deal_split: null,
    closed_at: null,
    created_at: now(),
    updated_at: now()
  };
  db.get('clients').push(client).write();
  res.status(201).json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const client = db.get('clients').find({ id: req.params.id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });
  const allowed = ['imie', 'nazwisko', 'mail', 'telefon', 'preferencje', 'stage', 'inwestycja', 'cena_nieruchomosci', 'prowizja_procent', 'deal_status', 'deal_month', 'deal_split', 'budget_min', 'budget_max', 'pref_locations', 'max_transit_min', 'rooms_min', 'rooms_max', 'area_min', 'area_max', 'floor_min', 'floor_max', 'needs_balcony', 'needs_parking', 'needs_elevator', 'ready_by', 'pref_notes', 'pref_weights'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const profileForStages = db.get('profiles').find({ id: req.profileId }).value();
  const activeStages = (profileForStages && Array.isArray(profileForStages.stages) && profileForStages.stages.length === STAGES.length) ? profileForStages.stages : STAGES;
  if (updates.stage && !activeStages.includes(updates.stage)) {
    return res.status(400).json({ error: 'Nieprawidlowy etap.' });
  }
  if (updates.deal_status !== undefined && ![null, 'won', 'lost'].includes(updates.deal_status)) {
    return res.status(400).json({ error: 'Nieprawidlowy status transakcji.' });
  }
  if (updates.deal_month !== undefined) {
    if (updates.deal_month === '' || updates.deal_month === null) updates.deal_month = null;
    else {
      const m = Number(updates.deal_month);
      if (!Number.isInteger(m) || m < 1 || m > 12) {
        return res.status(400).json({ error: 'Miesiac transakcji musi byc liczba 1-12.' });
      }
      updates.deal_month = m;
    }
  }
  if (updates.deal_split !== undefined) {
    if (updates.deal_split === '' || updates.deal_split === null) updates.deal_split = null;
    else {
      const s = Number(updates.deal_split);
      if (!ALLOWED_SPLITS.includes(s)) {
        return res.status(400).json({ error: 'Podzial prowizji musi wynosic 45%, 50%, 55% lub 60%.' });
      }
      updates.deal_split = s;
    }
  }
  if (updates.deal_status !== undefined) {
    if (updates.deal_status && !client.closed_at) {
      updates.closed_at = now();
      if (updates.deal_month === undefined && !client.deal_month) {
        updates.deal_month = new Date().getMonth() + 1;
      }
    }
    if (updates.deal_status === null) {
      updates.closed_at = null;
    }
  }
  ['budget_min','budget_max','max_transit_min','rooms_min','rooms_max','area_min','area_max','floor_min','floor_max'].forEach(function (k) {
    if (updates[k] !== undefined) updates[k] = (updates[k] === '' || updates[k] === null) ? null : Number(updates[k]);
  });
  ['needs_balcony','needs_parking','needs_elevator'].forEach(function (k) {
    if (updates[k] !== undefined) updates[k] = Boolean(updates[k]);
  });
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
  writeSnapshot('pre-delete');
  db.get('clients').remove({ id: req.params.id, profile_id: req.profileId }).write();
  db.get('activities').remove({ client_id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

app.get('/api/activities', (req, res) => {
  const clients = db.get('clients').filter({ profile_id: req.profileId }).value();
  const activities = db.get('activities').filter({ profile_id: req.profileId }).value().map(a => {
    const client = clients.find(c => c.id === a.client_id);
    return {
      ...a,
      client_name: client ? client.imie + ' ' + client.nazwisko : '(usuniety klient)',
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
    return res.status(400).json({ error: 'client_id, action_name i date sa wymagane.' });
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
    return res.status(400).json({ error: 'Nieprawidlowy plik kopii zapasowej.' });
  }
  writeSnapshot('pre-import');
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

app.get('/api/backup/snapshots', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('db-')).sort().reverse();
    res.json(files.slice(0, MAX_BACKUPS).map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, created_at: stat.mtime.toISOString() };
    }));
  } catch (e) {
    res.json([]);
  }
});

app.post('/api/backup/snapshots/:file/restore', (req, res) => {
  const file = path.basename(String(req.params.file));
  if (!file.startsWith('db-') || !file.endsWith('.json')) {
    return res.status(400).json({ error: 'Nieprawidlowa nazwa kopii.' });
  }
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Nie znaleziono kopii.' });
  try {
    const raw = fs.readFileSync(full, 'utf8');
    const parsed = JSON.parse(raw);
    const mine = (parsed.clients || []).filter(c => c.profile_id === req.profileId);
    const myActs = (parsed.activities || []).filter(a => a.profile_id === req.profileId);
    writeSnapshot('pre-restore');
    db.get('clients').remove({ profile_id: req.profileId }).write();
    db.get('activities').remove({ profile_id: req.profileId }).write();
    if (mine.length) db.get('clients').push(...mine).write();
    if (myActs.length) db.get('activities').push(...myActs).write();
    res.json({ restored_clients: mine.length, restored_activities: myActs.length });
  } catch (e) {
    res.status(500).json({ error: 'Nie udalo sie przywrocic kopii: ' + e.message });
  }
});

// ===========================================================================
// FAST RESEARCH v2 — 3 etapy: PDF -> selekcja inwestycji -> research -> raport
// Zasada nadrzędna: nigdy nie wychodzimy poza listę inwestycji z PDF.
// ===========================================================================

app.use('/api/research', requireProfile);

// --- Parser PDF ------------------------------------------------------------
// PDF-y deweloperskie nie mają jednego formatu, więc tniemy tekst na bloki
// wokół nazw inwestycji i z każdego bloku wyciągamy tyle, ile się da.
// Czego nie da się odczytać, zostaje null — nigdy nie zgadujemy.

function parseMoney(str) {
  if (!str) return null;
  const n = Number(String(str).replace(/[^\d]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseInvestmentsFromPdfText(text) {
  const clean = String(text || '').replace(/\r/g, '');
  if (!clean.trim()) return [];

  // Blok = fragment zaczynający się od linii wyglądającej na nazwę inwestycji
  // (Wielka litera, nie kończy się kropką, rozsądna długość).
  const lines = clean.split('\n').map(l => l.trim());
  const blocks = [];
  let current = null;

  // Linia "Etykieta: wartosc" to pole rekordu, nigdy nazwa inwestycji.
  const isFieldLine = (l) => /^[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż ]{3,24}\s*:/.test(l);

  const looksLikeName = (l) =>
    l.length >= 3 && l.length <= 80 &&
    /^[A-ZĄĆĘŁŃÓŚŹŻ]/.test(l) &&
    !/^\d/.test(l) &&
    !/[.;:]$/.test(l) &&
    !isFieldLine(l) &&
    !/^(https?:|www\.)/i.test(l) &&
    !/^(lista|oferta|spis|zestawienie|strona)\b/i.test(l);

  lines.forEach(function (l) {
    if (!l) return;
    if (looksLikeName(l)) {
      if (current) blocks.push(current);
      current = { name: l, body: [] };
    } else if (current) {
      current.body.push(l);
    }
  });
  if (current) blocks.push(current);

  // Pola czytamy w obrebie POJEDYNCZEJ linii - inaczej regex laczy sasiednie
  // etykiety i "Deweloper" wchlania cala reszte rekordu.
  const fieldValue = function (lines, labelRe) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(labelRe);
      if (m) return (m[1] || '').trim();
    }
    return null;
  };
  const findInLines = function (lines, re) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m) return m;
    }
    return null;
  };

  return blocks.map(function (b, i) {
    const lines = b.body;
    const all = b.name + ' ' + lines.join(' ');

    const urlM = findInLines(lines, /https?:\/\/[^\s,;)]+/i) || findInLines(lines, /\bwww\.[a-z0-9-]+\.[a-z.]{2,}/i);
    const dev = fieldValue(lines, /^(?:deweloper|inwestor)\s*[:\-]\s*(.+)$/i);
    const loc = fieldValue(lines, /^(?:lokalizacja|adres|dzielnica)\s*[:\-]\s*(.+)$/i)
             || fieldValue(lines, /^(ul\..+)$/i);
    const priceRange = findInLines(lines, /([\d][\d\s]{4,})\s*(?:-|–|do)\s*([\d][\d\s]{4,})\s*(?:zł|zl|PLN)/i);
    const pricePerM2 = findInLines(lines, /([\d][\d\s]{3,})\s*(?:zł|zl|PLN)\s*\/\s*m/i);
    const areaRange = findInLines(lines, /(\d{1,3}(?:[.,]\d)?)\s*(?:-|–|do)\s*(\d{1,3}(?:[.,]\d)?)\s*m\s*2?\b/i);
    const roomsRange = findInLines(lines, /pok\w*\s*[:\-]?\s*(\d)\s*(?:-|–|do)\s*(\d)/i)
                    || findInLines(lines, /(\d)\s*(?:-|–|do)\s*(\d)\s*pok/i);
    const readyM = findInLines(lines, /(?:termin|oddanie|realizacja|gotowe)\D{0,15}((?:I{1,4}|[1-4])\s*(?:kw|kwarta[łl])\w*\.?\s*)?(20\d{2})/i);
    const transitM = findInLines(lines, /(\d{1,2})\s*min\D{0,25}(?:metro|tramwaj|autobus|przystan|przystań|komunikacj|SKM|kolej)/i)
                  || findInLines(lines, /(?:metro|tramwaj|autobus|przystan|komunikacj)\D{0,25}(\d{1,2})\s*min/i);

    return {
      id: 'inv-' + (i + 1),
      name: b.name,
      developer: dev,
      location: loc,
      price_min: priceRange ? parseMoney(priceRange[1]) : null,
      price_max: priceRange ? parseMoney(priceRange[2]) : null,
      price_per_m2: pricePerM2 ? parseMoney(pricePerM2[1]) : null,
      area_min: areaRange ? Number(areaRange[1].replace(',', '.')) : null,
      area_max: areaRange ? Number(areaRange[2].replace(',', '.')) : null,
      rooms_min: roomsRange ? Number(roomsRange[1]) : null,
      rooms_max: roomsRange ? Number(roomsRange[2]) : null,
      ready: readyM ? (readyM[1] ? (readyM[1].trim() + ' ' + readyM[2]) : readyM[2]) : null,
      transit_min: transitM ? Number(transitM[1]) : null,
      url: urlM ? (urlM[0].startsWith('http') ? urlM[0] : 'https://' + urlM[0]) : null,
      raw: (b.name + '\n' + lines.join('\n')).slice(0, 1200)
    };
  }).filter(function (inv) {
    return inv.developer || inv.location || inv.price_min || inv.price_per_m2 || inv.area_min || inv.rooms_min || inv.url;
  });
}

app.post('/api/research/pdf', async (req, res) => {
  const { filename, base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'Plik PDF jest wymagany.' });
  try {
    const buffer = Buffer.from(base64, 'base64');
    const text = await extractPdfText(buffer);
    const investments = parseInvestmentsFromPdfText(text);
    if (!investments.length) {
      return res.status(422).json({ error: 'Nie udało się odczytać żadnej inwestycji z tego PDF. Upewnij się, że plik zawiera tekst (nie skan).' });
    }
    const record = {
      id: uuidv4(),
      profile_id: req.profileId,
      filename: filename || 'inwestycje.pdf',
      text: text.slice(0, 400000),
      investments: investments,
      created_at: now()
    };
    db.get('researchPdfs').push(record).write();
    const slim = investments.map(function (i) { const o = Object.assign({}, i); delete o.raw; return o; });
    res.status(201).json({ id: record.id, filename: record.filename, created_at: record.created_at, count: slim.length, investments: slim });
  } catch (e) {
    res.status(400).json({ error: 'Nie udało się odczytać PDF-a: ' + e.message });
  }
});

app.get('/api/research/pdfs', (req, res) => {
  const list = db.get('researchPdfs').filter({ profile_id: req.profileId })
    .map(function (p) { return { id: p.id, filename: p.filename, created_at: p.created_at, count: (p.investments || []).length }; })
    .value();
  res.json(list);
});

app.delete('/api/research/pdfs/:id', (req, res) => {
  db.get('researchPdfs').remove({ id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

// --- ETAP 1: selekcja inwestycji z listy PDF -------------------------------
// Twarde odrzucenie tylko wtedy, gdy dane z PDF JEDNOZNACZNIE wykluczają
// inwestycję. Brak danych nigdy nie jest powodem odrzucenia — jest adnotacją.

function clientCriteria(c) {
  return {
    budgetMin: Number(c.budget_min) || null,
    budgetMax: Number(c.budget_max) || null,
    locations: String(c.pref_locations || '').split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean),
    maxTransit: Number(c.max_transit_min) || null,
    roomsMin: Number(c.rooms_min) || null,
    roomsMax: Number(c.rooms_max) || null,
    areaMin: Number(c.area_min) || null,
    areaMax: Number(c.area_max) || null,
    floorMin: c.floor_min === null || c.floor_min === undefined ? null : Number(c.floor_min),
    floorMax: c.floor_max === null || c.floor_max === undefined ? null : Number(c.floor_max),
    balcony: Boolean(c.needs_balcony),
    parking: Boolean(c.needs_parking),
    elevator: Boolean(c.needs_elevator),
    readyBy: String(c.ready_by || '').trim(),
    notes: String(c.pref_notes || c.preferencje || '').toLowerCase(),
    weights: c.pref_weights || null
  };
}

function scoreInvestment(inv, cr) {
  let score = 0, max = 0;
  const reasons = [];
  const gaps = [];

  max += 40;
  if (cr.budgetMax && (inv.price_min || inv.price_max)) {
    const lo = inv.price_min || inv.price_max;
    if (lo > cr.budgetMax) {
      return { score: 0, reject: true, reasons: [], gaps: ['Najtańszy lokal (' + lo.toLocaleString('pl-PL') + ' zł) przekracza budżet klienta.'] };
    }
    if (cr.budgetMin && inv.price_max && inv.price_max < cr.budgetMin) {
      return { score: 0, reject: true, reasons: [], gaps: ['Cały zakres cen jest poniżej dolnej granicy budżetu.'] };
    }
    score += 40;
    reasons.push('Ceny mieszczą się w budżecie klienta.');
  } else if (cr.budgetMax && inv.price_per_m2 && cr.areaMin) {
    const est = inv.price_per_m2 * cr.areaMin;
    if (est > cr.budgetMax * 1.1) {
      return { score: 0, reject: true, reasons: [], gaps: ['Szacunek z ceny za m² (' + Math.round(est).toLocaleString('pl-PL') + ' zł) przekracza budżet.'] };
    }
    score += 30;
    reasons.push('Cena za m² mieści się w budżecie (szacunek dla ' + cr.areaMin + ' m²).');
  } else {
    score += 18;
    gaps.push('PDF nie podaje cen — budżetu nie dało się zweryfikować na tym etapie.');
  }

  max += 35;
  if (cr.locations.length) {
    const hay = ((inv.location || '') + ' ' + inv.name + ' ' + (inv.raw || '')).toLowerCase();
    const hit = cr.locations.find(function (loc) { return hay.includes(loc); });
    if (hit) {
      score += 35;
      reasons.push('Lokalizacja zgodna z preferencją: ' + hit + '.');
    } else if (inv.location) {
      return { score: 0, reject: true, reasons: [], gaps: ['Lokalizacja (' + inv.location + ') poza preferowanymi dzielnicami.'] };
    } else {
      score += 12;
      gaps.push('PDF nie podaje lokalizacji — nie dało się jej zweryfikować.');
    }
  } else {
    score += 20;
    gaps.push('Klient nie ma zdefiniowanej preferowanej lokalizacji.');
  }

  max += 25;
  if (cr.maxTransit && inv.transit_min !== null && inv.transit_min !== undefined) {
    if (inv.transit_min > cr.maxTransit) {
      return { score: 0, reject: true, reasons: [], gaps: ['Do komunikacji ' + inv.transit_min + ' min, klient chce max ' + cr.maxTransit + ' min.'] };
    }
    score += 25;
    reasons.push('Do komunikacji ' + inv.transit_min + ' min (limit ' + cr.maxTransit + ' min).');
  } else if (cr.maxTransit) {
    score += 10;
    gaps.push('PDF nie podaje odległości do komunikacji — do sprawdzenia w etapie 2.');
  } else {
    score += 15;
  }

  return { score: Math.round((score / max) * 100), reject: false, reasons: reasons, gaps: gaps };
}

app.post('/api/research/stage1', (req, res) => {
  const { client_id, pdf_id } = req.body;
  const client = db.get('clients').find({ id: client_id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });
  const pdf = db.get('researchPdfs').find({ id: pdf_id, profile_id: req.profileId }).value();
  if (!pdf) return res.status(404).json({ error: 'Nie znaleziono listy inwestycji (PDF).' });

  const cr = clientCriteria(client);
  const matched = [];
  const rejected = [];

  (pdf.investments || []).forEach(function (inv) {
    const r = scoreInvestment(inv, cr);
    const row = Object.assign({}, inv, { score: r.score, reasons: r.reasons, gaps: r.gaps });
    delete row.raw;
    if (r.reject) { const rr = Object.assign({}, inv, { reason: r.gaps[0] || 'Nie spełnia kryteriów.' }); delete rr.raw; rejected.push(rr); }
    else matched.push(row);
  });

  matched.sort(function (a, b) { return b.score - a.score; });
  res.json({
    client: { id: client.id, name: client.imie + ' ' + client.nazwisko },
    pdf: { id: pdf.id, filename: pdf.filename },
    total: (pdf.investments || []).length,
    matched: matched,
    rejected: rejected
  });
});

// --- ETAP 2: research konkretnych lokali na stronach deweloperow ------------
// Z kluczem ANTHROPIC_API_KEY korzystamy z modelu z wyszukiwaniem webowym.
// Bez klucza probujemy pobrac strone z PDF-a zwyklym fetch i uczciwie
// raportujemy, czego nie dalo sie odczytac. Nigdy nie zmyslamy lokali.

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchPageText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(function () { controller.abort(); }, 12000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RealEstateCRM/2.0)' }
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    return stripHtml(await resp.text()).slice(0, 30000);
  } catch (e) {
    return null;
  }
}

function prefsSummary(cr) {
  const p = [];
  if (cr.budgetMin || cr.budgetMax) p.push('budzet ' + (cr.budgetMin || 0).toLocaleString('pl-PL') + '-' + (cr.budgetMax || 0).toLocaleString('pl-PL') + ' zl');
  if (cr.roomsMin || cr.roomsMax) p.push('pokoje ' + (cr.roomsMin || '?') + '-' + (cr.roomsMax || '?'));
  if (cr.areaMin || cr.areaMax) p.push('metraz ' + (cr.areaMin || '?') + '-' + (cr.areaMax || '?') + ' m2');
  if (cr.floorMin !== null || cr.floorMax !== null) p.push('pietro ' + (cr.floorMin === null ? '?' : cr.floorMin) + '-' + (cr.floorMax === null ? '?' : cr.floorMax));
  if (cr.balcony) p.push('wymagany balkon/taras/ogrodek');
  if (cr.parking) p.push('wymagane miejsce parkingowe');
  if (cr.elevator) p.push('wymagana winda');
  if (cr.readyBy) p.push('termin oddania do ' + cr.readyBy);
  if (cr.maxTransit) p.push('max ' + cr.maxTransit + ' min do komunikacji');
  if (cr.notes) p.push('uwagi klienta: ' + cr.notes.slice(0, 300));
  return p.join('; ');
}

async function aiFindUnits(inv, cr) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const prompt =
      'Jestes asystentem agenta nieruchomosci. Znajdz AKTUALNIE DOSTEPNE mieszkania w konkretnej inwestycji.\n\n' +
      'INWESTYCJA: ' + inv.name + '\n' +
      'DEWELOPER: ' + (inv.developer || 'nieznany - ustal') + '\n' +
      'LOKALIZACJA: ' + (inv.location || 'nieznana') + '\n' +
      'STRONA: ' + (inv.url || 'nieznana - znajdz oficjalna strone tej inwestycji') + '\n\n' +
      'PREFERENCJE KLIENTA: ' + prefsSummary(cr) + '\n\n' +
      'ZASADY (krytyczne):\n' +
      '1. Szukaj WYLACZNIE na oficjalnej stronie tego dewelopera/inwestycji.\n' +
      '2. NIE WYMYSLAJ mieszkan. Jesli nie znajdziesz konkretnych lokali, zwroc pusta liste units i wyjasnij dlaczego w polu note.\n' +
      '3. Dla kazdego lokalu podaj link do konkretnej oferty w polu source.\n' +
      '4. Pola, ktorych nie znalazles, ustaw na null - nie zgaduj.\n\n' +
      'Zwroc WYLACZNIE JSON:\n' +
      '{\"official_url\":\"...\",\"note\":\"...\",\"investment\":{\"pros\":[\"...\"],\"cons\":[\"...\"],\"transit\":\"...\",\"ready\":\"...\",\"price_range\":\"...\"},' +
      '\"units\":[{\"rooms\":3,\"area\":62.5,\"floor\":2,\"price\":890000,\"layout\":\"...\",\"balcony\":true,\"parking\":true,\"storage\":false,\"available_from\":\"...\",\"source\":\"https://...\",\"unclear\":[\"czego brakowalo na stronie\"]}]}';

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content || []).filter(function (c) { return c.type === 'text'; }).map(function (c) { return c.text || ''; }).join('');
    const m = text.replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed.units)) parsed.units = [];
    return parsed;
  } catch (e) {
    return null;
  }
}

function scoreUnit(u, cr) {
  const w = cr.weights || {};
  const parts = [];
  const missing = [];
  const add = function (name, weight, value, note) {
    parts.push({ name: name, weight: weight, value: value });
    if (value < 1 && note) missing.push(note);
  };

  if (cr.roomsMin || cr.roomsMax) {
    let v = 0.5;
    if (u.rooms === null || u.rooms === undefined) { v = 0.5; missing.push('brak danych o liczbie pokoi'); }
    else if ((!cr.roomsMin || u.rooms >= cr.roomsMin) && (!cr.roomsMax || u.rooms <= cr.roomsMax)) v = 1;
    else { v = 0; missing.push('liczba pokoi (' + u.rooms + ') poza zakresem'); }
    add('pokoje', Number(w.rooms) || 25, v);
  }
  if (cr.areaMin || cr.areaMax) {
    let v = 0.5;
    if (u.area === null || u.area === undefined) { v = 0.5; missing.push('brak danych o metrazu'); }
    else if ((!cr.areaMin || u.area >= cr.areaMin) && (!cr.areaMax || u.area <= cr.areaMax)) v = 1;
    else {
      const dist = u.area < (cr.areaMin || 0) ? (cr.areaMin - u.area) : (u.area - cr.areaMax);
      v = dist <= 5 ? 0.6 : 0;
      missing.push('metraz ' + u.area + ' m2 poza zakresem');
    }
    add('metraz', Number(w.area) || 25, v);
  }
  if (cr.budgetMax) {
    let v = 0.5;
    if (u.price === null || u.price === undefined) { v = 0.5; missing.push('brak ceny lokalu'); }
    else if (u.price <= cr.budgetMax && (!cr.budgetMin || u.price >= cr.budgetMin * 0.7)) v = 1;
    else if (u.price <= cr.budgetMax * 1.05) { v = 0.6; missing.push('cena lekko ponad budzet'); }
    else { v = 0; missing.push('cena ' + Number(u.price).toLocaleString('pl-PL') + ' zl przekracza budzet'); }
    add('cena', Number(w.price) || 30, v);
  }
  if (cr.floorMin !== null || cr.floorMax !== null) {
    let v = 0.5;
    if (u.floor === null || u.floor === undefined) { v = 0.5; missing.push('brak danych o pietrze'); }
    else if ((cr.floorMin === null || u.floor >= cr.floorMin) && (cr.floorMax === null || u.floor <= cr.floorMax)) v = 1;
    else { v = 0; missing.push('pietro ' + u.floor + ' poza preferencja'); }
    add('pietro', Number(w.floor) || 10, v);
  }
  if (cr.balcony) add('balkon', Number(w.balcony) || 10, u.balcony === true ? 1 : (u.balcony === false ? 0 : 0.5), u.balcony === false ? 'brak balkonu/tarasu' : 'brak informacji o balkonie');
  if (cr.parking) add('parking', Number(w.parking) || 10, u.parking === true ? 1 : (u.parking === false ? 0 : 0.5), u.parking === false ? 'brak miejsca parkingowego' : 'brak informacji o parkingu');

  if (!parts.length) return { score: 50, missing: ['Klient nie ma zdefiniowanych kryteriow lokalu.'] };
  const totalW = parts.reduce(function (a, p) { return a + p.weight; }, 0);
  const sum = parts.reduce(function (a, p) { return a + p.weight * p.value; }, 0);
  return { score: Math.round((sum / totalW) * 100), missing: missing };
}

// --- ETAP 2 + 3: research i raport koncowy ---------------------------------

app.post('/api/research/run', async (req, res) => {
  const { client_id, pdf_id, investment_ids } = req.body;
  const client = db.get('clients').find({ id: client_id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });
  const pdf = db.get('researchPdfs').find({ id: pdf_id, profile_id: req.profileId }).value();
  if (!pdf) return res.status(404).json({ error: 'Nie znaleziono listy inwestycji (PDF).' });
  if (!Array.isArray(investment_ids) || !investment_ids.length) {
    return res.status(400).json({ error: 'Zaznacz przynajmniej jedna inwestycje do researchu.' });
  }

  const cr = clientCriteria(client);
  // Kluczowe: bierzemy WYLACZNIE inwestycje z tego PDF-a.
  const chosen = (pdf.investments || []).filter(function (i) { return investment_ids.includes(i.id); });
  if (!chosen.length) return res.status(400).json({ error: 'Zaznaczone inwestycje nie naleza do tej listy PDF.' });

  const aiAvailable = Boolean(process.env.ANTHROPIC_API_KEY);
  const perInvestment = [];
  const allUnits = [];

  for (const inv of chosen) {
    const entry = {
      investment: inv.name,
      developer: inv.developer,
      location: inv.location,
      url: inv.url,
      official_url: inv.url,
      note: null,
      source_mode: aiAvailable ? 'ai-web-search' : 'html-fetch',
      pros: [],
      cons: [],
      units_found: 0
    };

    const ai = await aiFindUnits(inv, cr);
    if (ai) {
      entry.official_url = ai.official_url || inv.url;
      entry.note = ai.note || null;
      if (ai.investment) {
        entry.pros = Array.isArray(ai.investment.pros) ? ai.investment.pros : [];
        entry.cons = Array.isArray(ai.investment.cons) ? ai.investment.cons : [];
        entry.transit = ai.investment.transit || (inv.transit_min ? inv.transit_min + ' min' : null);
        entry.ready = ai.investment.ready || inv.ready;
        entry.price_range = ai.investment.price_range || null;
      }
      (ai.units || []).forEach(function (u) {
        const sc = scoreUnit(u, cr);
        allUnits.push({
          investment: inv,
          entry_pros: entry.pros,
          entry_cons: entry.cons,
          transit: entry.transit || null,
          ready: entry.ready || inv.ready,
          price_range: entry.price_range || null,
          unit: u,
          score: sc.score,
          missing: sc.missing,
          unclear: Array.isArray(u.unclear) ? u.unclear : [],
          source: u.source || entry.official_url || null
        });
      });
      entry.units_found = (ai.units || []).length;
    } else {
      const page = inv.url ? await fetchPageText(inv.url) : null;
      entry.note = inv.url
        ? (page
            ? 'Nie udalo sie automatycznie odczytac listy dostepnych lokali ze strony (oferty ladowane skryptem). Sprawdz recznie: ' + inv.url
            : 'Strona dewelopera nie odpowiedziala. Sprawdz recznie: ' + inv.url)
        : 'PDF nie podaje strony inwestycji, a wyszukiwanie internetowe jest niedostepne (brak ANTHROPIC_API_KEY).';
      entry.transit = inv.transit_min ? inv.transit_min + ' min' : null;
      entry.ready = inv.ready;
    }
    perInvestment.push(entry);
  }

  // ETAP 3 - wybor 3 najlepszych. Prog 80%; jesli nikt go nie przekracza,
  // pokazujemy najlepsze dostepne z wyrazna adnotacja.
  allUnits.sort(function (a, b) { return b.score - a.score; });
  const strong = allUnits.filter(function (u) { return u.score >= 80; });
  const belowThreshold = strong.length === 0 && allUnits.length > 0;
  const top = (strong.length ? strong : allUnits).slice(0, 3);

  const report = {
    id: uuidv4(),
    profile_id: req.profileId,
    client_id: client.id,
    client_name: client.imie + ' ' + client.nazwisko,
    pdf_id: pdf.id,
    pdf_filename: pdf.filename,
    researched_at: now(),
    ai_used: aiAvailable,
    below_threshold: belowThreshold,
    investigated: perInvestment,
    results: top.map(function (r) {
      return {
        score: r.score,
        investment: {
          name: r.investment.name,
          developer: r.investment.developer,
          location: r.investment.location,
          transit: r.transit,
          ready: r.ready,
          price_range: r.price_range || (r.investment.price_min ? r.investment.price_min.toLocaleString('pl-PL') + ' - ' + (r.investment.price_max || 0).toLocaleString('pl-PL') + ' zl' : null),
          pros: r.entry_pros,
          cons: r.entry_cons
        },
        unit: {
          rooms: r.unit.rooms == null ? null : r.unit.rooms,
          area: r.unit.area == null ? null : r.unit.area,
          floor: r.unit.floor == null ? null : r.unit.floor,
          price: r.unit.price == null ? null : r.unit.price,
          layout: r.unit.layout || null,
          balcony: r.unit.balcony == null ? null : r.unit.balcony,
          parking: r.unit.parking == null ? null : r.unit.parking,
          storage: r.unit.storage == null ? null : r.unit.storage,
          available_from: r.unit.available_from || null,
          source: r.source
        },
        missing: r.missing,
        unclear: r.unclear
      };
    })
  };

  db.get('researchReports').push(report).write();
  res.json(report);
});

app.get('/api/research/reports', (req, res) => {
  const q = { profile_id: req.profileId };
  if (req.query.client_id) q.client_id = req.query.client_id;
  const list = db.get('researchReports').filter(q).value()
    .sort(function (a, b) { return new Date(b.researched_at) - new Date(a.researched_at); })
    .map(function (r) { return { id: r.id, client_name: r.client_name, pdf_filename: r.pdf_filename, researched_at: r.researched_at, count: r.results.length }; });
  res.json(list);
});

app.get('/api/research/reports/:id', (req, res) => {
  const r = db.get('researchReports').find({ id: req.params.id, profile_id: req.profileId }).value();
  if (!r) return res.status(404).json({ error: 'Nie znaleziono raportu.' });
  res.json(r);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Real Estate CRM listening on port ' + PORT);
});


// ---- KOPIE ZAPASOWE: tylko raz dziennie o polnocy ----
// Blokujemy wszystkie inne powody tworzenia kopii (boot, auto co 10 min,
// pre-delete, pre-import, shutdown) - przechodzi wylacznie 'daily'.
const _origWriteSnapshot = writeSnapshot;
writeSnapshot = function (reason) {
  if (reason !== 'daily') return;
  _origWriteSnapshot(reason);
};

// Przy kazdym starcie usuwamy kopie, ktore nie sa kopiami dziennymi
// (w tym wszystkie stare kopie z poprzedniego harmonogramu co 10 minut).
try {
  fs.readdirSync(BACKUP_DIR)
  .filter(f => f.startsWith('db-') && !f.endsWith('-daily.json'))
  .forEach(f => { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) { } });
} catch (e) { }

function msUntilNextMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.getTime() - now.getTime();
}

setTimeout(() => {
  writeSnapshot('daily');
  setInterval(() => writeSnapshot('daily'), 24 * 60 * 60 * 1000).unref();
}, msUntilNextMidnight()).unref();


// ==== YOUR PLANNER: zadania i cele ====
db.defaults({ plannerTasks: [] }).write();

const PLANNER_SCOPES = ['daily', 'weekly', 'monthly', 'yearly'];
const PLANNER_RECURRENCE = ['none', 'daily', 'weekly'];

app.use('/api/planner', requireProfile);

app.get('/api/planner', (req, res) => {
  res.json(db.get('plannerTasks').filter({ profile_id: req.profileId }).value());
});

function sanitizePlanner(body, existing) {
  const out = {};
  if (body.title !== undefined) out.title = String(body.title).trim();
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim();
  if (body.scope !== undefined) {
    if (!PLANNER_SCOPES.includes(body.scope)) return { error: 'Nieprawidlowy zakres zadania.' };
    out.scope = body.scope;
  }
  if (body.date !== undefined) out.date = body.date ? String(body.date) : null;
  if (body.time_start !== undefined) out.time_start = body.time_start ? String(body.time_start) : null;
  if (body.time_end !== undefined) out.time_end = body.time_end ? String(body.time_end) : null;
  if (body.recurrence !== undefined) {
    if (!PLANNER_RECURRENCE.includes(body.recurrence)) return { error: 'Nieprawidlowy typ powtarzania.' };
    out.recurrence = body.recurrence;
  }
  if (body.weekdays !== undefined) {
    const wd = Array.isArray(body.weekdays) ? body.weekdays.map(Number).filter(n => n >= 0 && n <= 6) : [];
    out.weekdays = Array.from(new Set(wd)).sort();
  }
  if (body.done_dates !== undefined) {
    out.done_dates = Array.isArray(body.done_dates) ? body.done_dates.map(String) : [];
  }
  if (body.done !== undefined) out.done = Boolean(body.done);
  const title = out.title !== undefined ? out.title : (existing && existing.title);
  if (!title) return { error: 'Nazwa zadania jest wymagana.' };
  const recurrence = out.recurrence !== undefined ? out.recurrence : (existing && existing.recurrence) || 'none';
  const weekdays = out.weekdays !== undefined ? out.weekdays : (existing && existing.weekdays) || [];
  if (recurrence === 'weekly' && !weekdays.length) {
    return { error: 'Dla powtarzania tygodniowego wybierz przynajmniej jeden dzien.' };
  }
  return { value: out };
}

app.post('/api/planner', (req, res) => {
  const parsed = sanitizePlanner(req.body, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const task = {
    id: uuidv4(),
    profile_id: req.profileId,
    title: '',
    notes: '',
    scope: 'daily',
    date: null,
    time_start: null,
    time_end: null,
    recurrence: 'none',
    weekdays: [],
    done: false,
    done_dates: [],
    created_at: now(),
    ...parsed.value
  };
  db.get('plannerTasks').push(task).write();
  res.status(201).json(task);
});

app.put('/api/planner/:id', (req, res) => {
  const task = db.get('plannerTasks').find({ id: req.params.id, profile_id: req.profileId }).value();
  if (!task) return res.status(404).json({ error: 'Nie znaleziono zadania.' });
  const parsed = sanitizePlanner(req.body, task);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  db.get('plannerTasks').find({ id: req.params.id, profile_id: req.profileId }).assign(parsed.value).write();
  res.json(db.get('plannerTasks').find({ id: req.params.id, profile_id: req.profileId }).value());
});

app.delete('/api/planner/:id', (req, res) => {
  db.get('plannerTasks').remove({ id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

// Przesun katch-all '*' na koniec stosu tras, zeby /api/planner dzialalo.
try {
  const layers = app._router.stack;
  const i = layers.findIndex(l => l.route && l.route.path === '*');
  if (i !== -1) layers.push(layers.splice(i, 1)[0]);
} catch (e) {
  console.error('Nie udalo sie przesunac trasy catch-all:', e.message);
}


// ==== PRACTICE: skrypty rozmow (Cold Call / Spotkanie) + Straight Line ====
db.defaults({ practiceScripts: [] }).write();

const PRACTICE_TYPES = ['coldcall', 'meeting'];

const DEFAULT_COLDCALL_STAGES = [
  { key: 'open', title: 'Open call', script: '', priorities: '' },
  { key: 'explain', title: 'Wyjasnienie', script: '', priorities: '' },
  { key: 'needs', title: 'Badanie potrzeb (pytania)', script: '', priorities: '' },
  { key: 'close', title: 'Zakonczenie - domkniecie na spotkanie', script: '', priorities: '' }
];

const DEFAULT_MEETING_STAGES = [
  { key: 'open', title: 'Otwarcie spotkania', script: '', priorities: '' },
  { key: 'discovery', title: 'Badanie potrzeb', script: '', priorities: '' },
  { key: 'presentation', title: 'Prezentacja rozwiazania', script: '', priorities: '' },
  { key: 'objections', title: 'Obiekcje', script: '', priorities: '' },
  { key: 'close', title: 'Domkniecie', script: '', priorities: '' }
];

const DEFAULT_LINE_COLDCALL = ['Otwarcie', 'Wyjasnienie', 'Potrzeby', 'Domkniecie'];
const DEFAULT_LINE_MEETING = ['Otwarcie', 'Potrzeby', 'Prezentacja', 'Obiekcje', 'Domkniecie'];

function defaultPractice(type) {
  return {
    type: type,
    stages: type === 'coldcall' ? JSON.parse(JSON.stringify(DEFAULT_COLDCALL_STAGES)) : JSON.parse(JSON.stringify(DEFAULT_MEETING_STAGES)),
    lineStages: type === 'coldcall' ? DEFAULT_LINE_COLDCALL.slice() : DEFAULT_LINE_MEETING.slice(),
    markerIndex: 0
  };
}

app.use('/api/practice', requireProfile);

app.get('/api/practice', function (req, res) {
  const out = {};
  PRACTICE_TYPES.forEach(function (type) {
    const found = db.get('practiceScripts').find({ profile_id: req.profileId, type: type }).value();
    out[type] = found ? { type: type, stages: found.stages, lineStages: found.lineStages, markerIndex: found.markerIndex || 0 } : defaultPractice(type);
  });
  res.json(out);
});

app.put('/api/practice', function (req, res) {
  const type = req.body.type;
  const stages = req.body.stages;
  const lineStages = req.body.lineStages;
  const markerIndex = req.body.markerIndex;
  if (!PRACTICE_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Nieprawidlowy typ skryptu.' });
  }
  if (stages !== undefined && !Array.isArray(stages)) {
    return res.status(400).json({ error: 'Etapy musza byc lista.' });
  }
  if (lineStages !== undefined) {
    if (!Array.isArray(lineStages) || !lineStages.length) {
      return res.status(400).json({ error: 'Linia musi miec przynajmniej jeden etap.' });
    }
    if (lineStages.some(function (s) { return !String(s || '').trim(); })) {
      return res.status(400).json({ error: 'Nazwy etapow na linii nie moga byc puste.' });
    }
  }
  const existing = db.get('practiceScripts').find({ profile_id: req.profileId, type: type }).value();
  const base = existing || Object.assign({ id: uuidv4(), profile_id: req.profileId }, defaultPractice(type));
  if (stages !== undefined) {
    base.stages = stages.map(function (s) {
      return {
        key: String(s.key || '').trim() || uuidv4().slice(0, 8),
        title: String(s.title || '').trim() || 'Etap',
        script: String(s.script || ''),
        priorities: String(s.priorities || '')
      };
    });
  }
  if (lineStages !== undefined) base.lineStages = lineStages.map(function (s) { return String(s).trim(); });
  if (markerIndex !== undefined) {
    const m = Number(markerIndex);
    base.markerIndex = Number.isFinite(m) ? Math.max(0, Math.min(base.lineStages.length - 1, Math.round(m))) : 0;
  }
  base.updated_at = now();
  if (existing) {
    db.get('practiceScripts').find({ profile_id: req.profileId, type: type }).assign(base).write();
  } else {
    db.get('practiceScripts').push(base).write();
  }
  res.json({ type: type, stages: base.stages, lineStages: base.lineStages, markerIndex: base.markerIndex });
});
const FILLER_WORDS = ['tak jakby', 'w sumie', 'znaczy', 'yyy', 'jakby', 'no wiesz'];

function heuristicReview(stage, type) {
  const text = String(stage.script || '').trim();
  const prio = String(stage.priorities || '').trim();
  const tips = [];
  const good = [];
  if (!text) {
    return { stage: stage.title, tips: ['Ten etap jest pusty - bez niego trudno prowadzic rozmowe wg planu.'], good: [] };
  }
  const words = text.split(/\s+/).length;
  const sentences = text.split(/[.!?]+/).filter(function (s) { return s.trim(); }).length || 1;
  const avgSentence = words / sentences;
  const questions = (text.match(/\?/g) || []).length;
  const key = stage.key || '';
  if (words < 15) tips.push('Bardzo krotki fragment (' + words + ' slow) - rozwaz rozwiniecie.');
  if (words > 220) tips.push('Dlugi fragment (' + words + ' slow). Klient wylacza sie po ~30 sekundach monologu - rozbij na krotsze wymiany.');
  if (avgSentence > 25) tips.push('Srednie zdanie ma ' + avgSentence.toFixed(0) + ' slow - za dlugo jak na mowe. Skracaj do 12-18 slow.');
  else if (words >= 15) good.push('Dlugosc zdan jest w porzadku dla rozmowy mowionej.');
  const foundFillers = FILLER_WORDS.filter(function (f) { return text.toLowerCase().includes(f); });
  if (foundFillers.length) tips.push('Wypelniacze do usuniecia: ' + foundFillers.join(', ') + '. Oslabiaja pewnosc siebie.');
  if (key === 'open') {
    if (!/dzien dobry|witam|czesc/i.test(text)) tips.push('Brakuje wyraznego powitania na starcie.');
    if (!/nazywam sie|z tej strony|mowi /i.test(text)) tips.push('Nie przedstawiasz sie imieniem - rozmowa zaczyna sie anonimowo.');
    if (!/chwil|moment|minut/i.test(text)) tips.push('Rozwaz pytanie o zgode na czas (Ma Pan chwile?) - obniza opor.');
    if (questions === 0) tips.push('W otwarciu nie ma zadnego pytania - latwo wpasc w monolog.');
  }
  if (key === 'explain') {
    if (!/poniewaz|dlatego|powodem|dzwonie w sprawie/i.test(text)) tips.push('Nie widac jasnego powodu telefonu. Podaj konkret: Dzwonie, poniewaz...');
    if (/najlepsz|lider|numer 1|rewolucyjn/i.test(text)) tips.push('Superlatywy brzmia jak reklama. Zastap je konkretnym faktem lub liczba.');
  }
  if (key === 'needs' || key === 'discovery') {
    if (questions < 3) tips.push('Tylko ' + questions + ' pytan w badaniu potrzeb. To najwazniejszy moment - celuj w 5-8 pytan otwartych.');
    else good.push(questions + ' pytan - dobra podstawa do badania potrzeb.');
    const openQ = (text.match(/\b(co|jak|dlaczego|kiedy|gdzie|jakie|czego)\b/gi) || []).length;
    if (openQ < 2) tips.push('Przewage maja pytania zamkniete. Dodaj pytania otwarte (co / jak / dlaczego).');
  }
  if (key === 'presentation') {
    if (!/dla Pan|dzieki temu|to oznacza|zyska/i.test(text)) tips.push('Prezentacja opisuje cechy, ale nie tlumaczy korzysci. Dodaj: dzieki temu Pan/Pani...');
  }
  if (key === 'objections') {
    if (!/rozumiem|slusznie|to naturalne/i.test(text)) tips.push('Brakuje zbicia napiecia. Zacznij od uznania obiekcji (Rozumiem...).');
  }
  if (key === 'close') {
    const hasConcrete = /poniedzialek|wtorek|sroda|czwartek|piatek|godzin|\d{1,2}:\d{2}|jutro|w tym tygodniu/i.test(text);
    if (!hasConcrete) tips.push(type === 'coldcall' ? 'Domkniecie bez konkretnego terminu. Zaproponuj dwa warianty: wtorek 11:00 czy czwartek 15:00?' : 'Brakuje konkretnego nastepnego kroku z data.');
    if (!/spotka/i.test(text) && type === 'coldcall') tips.push('Cel telefonu to spotkanie - nazwij to wprost.');
    if (/moze|gdyby|ewentualnie|jesli by/i.test(text)) tips.push('Tryb przypuszczajacy oslabia domkniecie. Mow twierdzaco.');
  }
  if (!prio) tips.push('Nie masz zapisanych priorytetow dla tego etapu - trudno ocenic, czy zostal domkniety.');
  else good.push('Priorytety uzupelnione - wiadomo, co musi pasc w tym etapie.');
  return { stage: stage.title, tips: tips, good: good };
}

async function aiReview(stages, type) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const scriptText = stages.map(function (s) { return '### ' + s.title + '\nSKRYPT:\n' + (s.script || '(puste)') + '\nPRIORYTETY:\n' + (s.priorities || '(puste)'); }).join('\n\n');
    const prompt = 'Jestes trenerem sprzedazy nieruchomosci. Ocen ponizszy skrypt ' + (type === 'coldcall' ? 'rozmowy cold call' : 'spotkania z klientem') + '. Dla kazdego etapu podaj maksymalnie 3 konkretne uwagi co poprawic i 1 rzecz ktora jest dobra. Odpowiedz WYLACZNIE w JSON: {"reviews":[{"stage":"nazwa","tips":["..."],"good":["..."]}],"overall":"2-3 zdania"}\n\n' + scriptText;
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const txt = (data.content || []).map(function (c) { return c.text || ''; }).join('').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(txt);
    if (!parsed.reviews) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

app.post('/api/practice/improve', async function (req, res) {
  const type = req.body.type;
  if (!PRACTICE_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Nieprawidlowy typ skryptu.' });
  }
  const found = db.get('practiceScripts').find({ profile_id: req.profileId, type: type }).value();
  const stages = found ? found.stages : defaultPractice(type).stages;
  if (!stages.some(function (s) { return String(s.script || '').trim(); })) {
    return res.status(400).json({ error: 'Napisz najpierw choc jeden etap skryptu - nie ma czego analizowac.' });
  }
  const ai = await aiReview(stages, type);
  if (ai) {
    return res.json({ source: 'ai', reviews: ai.reviews, overall: ai.overall || '' });
  }
  const reviews = stages.map(function (s) { return heuristicReview(s, type); });
  const totalTips = reviews.reduce(function (a, r) { return a + r.tips.length; }, 0);
  const overall = totalTips === 0
    ? 'Skrypt przeszedl wszystkie automatyczne testy. Kolejny krok to przecwiczenie go na glos.'
    : 'Znaleziono ' + totalTips + ' rzeczy do poprawy. To analiza regulowa (dlugosc zdan, pytania, wypelniacze, konkret w domknieciu) - nie ocenia sensu tresci. Pelna analize jezykowa wlaczy klucz ANTHROPIC_API_KEY w ustawieniach Render.';
  res.json({ source: 'heuristic', reviews: reviews, overall: overall });
});

try {
  const layersP = app._router.stack;
  const iP = layersP.findIndex(function (l) { return l.route && l.route.path === '*'; });
  if (iP !== -1) layersP.push(layersP.splice(iP, 1)[0]);
} catch (e) {
  console.error('Nie udalo sie przesunac trasy catch-all:', e.message);
}
