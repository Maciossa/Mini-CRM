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
    text += content.items.map(it => it.str).join(' ') + '\n';
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
  activities: [],
  accounts: [],
  profiles: [],
  developerLinks: [],
  investmentPdfs: [],
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
  const allowed = ['imie', 'nazwisko', 'mail', 'telefon', 'preferencje', 'stage', 'inwestycja', 'cena_nieruchomosci', 'prowizja_procent', 'deal_status', 'deal_month', 'deal_split'];
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

app.use('/api/admin', requireProfile, requireAdmin);
app.use('/api/research', requireProfile);

app.get('/api/admin/developer-links', (req, res) => {
  res.json(db.get('developerLinks').filter({ profile_id: req.profileId }).value());
});

app.post('/api/admin/developer-links', (req, res) => {
  const { url, label } = req.body;
  if (!url) return res.status(400).json({ error: 'Link jest wymagany.' });
  const link = {
    id: uuidv4(),
    profile_id: req.profileId,
    url: String(url).trim(),
    label: label ? String(label).trim() : '',
    created_at: now()
  };
  db.get('developerLinks').push(link).write();
  res.status(201).json(link);
});

app.delete('/api/admin/developer-links/:id', (req, res) => {
  db.get('developerLinks').remove({ id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

app.get('/api/admin/investment-pdfs', (req, res) => {
  const list = db.get('investmentPdfs').filter({ profile_id: req.profileId })
  .map(p => ({ id: p.id, filename: p.filename, created_at: p.created_at, chars: (p.text || '').length }))
  .value();
  res.json(list);
});

app.post('/api/admin/investment-pdfs', async (req, res) => {
  const { filename, base64 } = req.body;
  if (!base64) return res.status(400).json({ error: 'Plik PDF (base64) jest wymagany.' });
  try {
    const buffer = Buffer.from(base64, 'base64');
    const text = await extractPdfText(buffer);
    const record = {
      id: uuidv4(),
      profile_id: req.profileId,
      filename: filename || 'inwestycje.pdf',
      text: text || '',
      created_at: now()
    };
    db.get('investmentPdfs').push(record).write();
    res.status(201).json({ id: record.id, filename: record.filename, created_at: record.created_at, chars: record.text.length });
  } catch (e) {
    res.status(400).json({ error: 'Nie udalo sie odczytac PDF-a. Upewnij sie, ze to poprawny plik PDF.' });
  }
});

app.delete('/api/admin/investment-pdfs/:id', (req, res) => {
  db.get('investmentPdfs').remove({ id: req.params.id, profile_id: req.profileId }).write();
  res.status(204).end();
});

function stripHtml(html) {
  return String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
}

async function fetchDeveloperPageText(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CRM-FastResearch/1.0)' } });
    clearTimeout(timeout);
    if (!resp.ok) return '';
    const html = await resp.text();
    return stripHtml(html).slice(0, 20000);
  } catch (e) {
    return '';
  }
}

function parseListingsFromText(text, sourceLabel, sourceLink) {
  if (!text) return [];
  const chunks = text.split(/\n\s*\n|(?=(?:Mieszkanie|Lokal|Apartament)\s*(?:nr|#)?\s*\d)/i);
  const listings = [];
  for (const raw of chunks) {
    const chunk = raw.trim();
    if (chunk.length < 20) continue;
    const priceMatch = chunk.match(/([\d][\d\s.,]{3,})\s*(?:z[al]|PLN)\b/i);
    const m2Match = chunk.match(/(\d{2,3}(?:[.,]\d{1,2})?)\s*m(?:2)/i);
    const roomsMatch = chunk.match(/(\d)\s*(?:pok)/i);
    const floorMatch = chunk.match(/(parter|\d{1,2})\s*(?:pietro|p\.)/i);
    const fieldCount = [priceMatch, m2Match, roomsMatch].filter(Boolean).length;
    if (fieldCount < 2) continue;
    listings.push({
      raw: chunk.slice(0, 900),
      price: priceMatch ? Number(priceMatch[1].replace(/[^\d]/g, '')) : null,
      m2: m2Match ? Number(m2Match[1].replace(',', '.')) : null,
      rooms: roomsMatch ? Number(roomsMatch[1]) : null,
      floor: floorMatch ? floorMatch[1] : null,
      source: sourceLabel,
      sourceLink: sourceLink || null
    });
    if (listings.length >= 60) break;
  }
  return listings;
}

const PREFERENCE_STOPWORDS = new Set(['szukam','szukamy','mieszkania','mieszkanie','klient','klienta','preferuje','preferencje','chce','chcemy','najlepiej','ewentualnie','oraz','lub','okolo','budzet','budzetu','cena','ceny','zeby','ktore','ktora','jest','tak','nie','bardzo','raczej','moze']);

function extractPreferenceCriteria(prefText) {
  const t = prefText.toLowerCase();
  const rooms = t.match(/(\d)\s*(?:pok)/);
  const maxPriceMatch = t.match(/(?:do|max|maks\w*|budzet[a-z]*)\D{0,10}([\d][\d\s.,]{3,})\s*(?:zl|pln|tys)/);
  const m2RangeMatch = t.match(/(\d{2,3})\s*(?:-|do)\s*(\d{2,3})\s*m2/);
  const m2SingleMatch = t.match(/(\d{2,3})\s*m2/);
  const words = t.split(/[^a-z0-9]+/i).filter(w => w.length > 3 && !/^\d+$/.test(w) && !PREFERENCE_STOPWORDS.has(w));
  return {
    rooms: rooms ? Number(rooms[1]) : null,
    maxPrice: maxPriceMatch ? Number(maxPriceMatch[1].replace(/[^\d]/g, '')) * (/tys/.test(maxPriceMatch[0]) ? 1000 : 1) : null,
    m2Min: m2RangeMatch ? Number(m2RangeMatch[1]) : (m2SingleMatch ? Number(m2SingleMatch[1]) * 0.85 : null),
    m2Max: m2RangeMatch ? Number(m2RangeMatch[2]) : (m2SingleMatch ? Number(m2SingleMatch[1]) * 1.15 : null),
    words: Array.from(new Set(words))
  };
}

function scoreListing(listing, criteria) {
  let score = 0;
  let maxScore = 0;
  maxScore += 30;
  if (criteria.rooms != null && listing.rooms != null) {
    if (listing.rooms === criteria.rooms) score += 30;
    else if (Math.abs(listing.rooms - criteria.rooms) === 1) score += 15;
  } else if (criteria.rooms == null) {
    score += 15;
  }
  maxScore += 25;
  if (criteria.m2Min != null && listing.m2 != null) {
    if (listing.m2 >= criteria.m2Min && listing.m2 <= criteria.m2Max) score += 25;
    else {
      const dist = Math.min(Math.abs(listing.m2 - criteria.m2Min), Math.abs(listing.m2 - criteria.m2Max));
      if (dist <= 10) score += 12;
    }
  } else if (criteria.m2Min == null) {
    score += 12;
  }
  maxScore += 25;
  if (criteria.maxPrice != null && listing.price != null) {
    if (listing.price <= criteria.maxPrice) score += 25;
    else if (listing.price <= criteria.maxPrice * 1.1) score += 10;
  } else if (criteria.maxPrice == null) {
    score += 12;
  }
  maxScore += 20;
  if (criteria.words.length) {
    const raw = listing.raw.toLowerCase();
    const hits = criteria.words.filter(w => raw.includes(w.slice(0, Math.min(5, w.length)))).length;
    score += Math.min(20, Math.round((hits / criteria.words.length) * 20));
  } else {
    score += 20;
  }
  return Math.round((score / maxScore) * 100);
}

const PROS_CONS_DICTIONARY = [
  { keyword: /metro|tramwaj|autobus|komunikacj/i, pro: 'Dobra dostepnosc komunikacji miejskiej (wg opisu).' },
  { keyword: /balkon|taras|ogrodek/i, pro: 'Dodatkowa przestrzen zewnetrzna (balkon/taras/ogrodek).' },
  { keyword: /winda/i, pro: 'Budynek wyposazony w winde.' },
  { keyword: /garaz|miejsce postojowe|parking/i, pro: 'Zapewnione miejsce parkingowe/garaz.' },
  { keyword: /parter/i, con: 'Lokal na parterze - mniejsza prywatnosc.' },
  { keyword: /bez windy/i, con: 'Budynek bez windy.' },
  { keyword: /do remontu/i, con: 'Lokal wymaga dodatkowych nakladow wykonczeniowych.' }
  ];

function buildProsAndCons(listing) {
  const pros = [];
  const cons = [];
  for (const rule of PROS_CONS_DICTIONARY) {
    if (rule.keyword.test(listing.raw)) {
      if (rule.pro) pros.push(rule.pro);
      if (rule.con) cons.push(rule.con);
    }
  }
  if (!pros.length) pros.push('Brak wystarczajacych danych w opisie - zalecana wizja lokalna.');
  if (!cons.length) cons.push('Brak wykrytych istotnych wad na podstawie opisu - zalecana weryfikacja na miejscu.');
  return { pros, cons };
}

async function buildWalkingDistanceSection() {
  if (process.env.GOOGLE_MAPS_API_KEY) {
    return 'Klucz Google Maps API wykryty, ale integracja czasu dojscia pieszo nie jest jeszcze podlaczona w tej wersji.';
  }
  return 'Brak klucza GOOGLE_MAPS_API_KEY w konfiguracji serwera - dokladny czas dojscia pieszo do komunikacji nie mogl zostac wyliczony automatycznie. Dodaj ten klucz jako zmienna srodowiskowa na Render, aby wlaczyc te analize.';
}

function estimateRent(price) {
  if (!price) return null;
  return Math.round((price * 0.004) / 50) * 50;
}

async function buildReportPdfBuffer({ client, listing, score }) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const { pros, cons } = buildProsAndCons(listing);
      const walkingSection = await buildWalkingDistanceSection();
      const rent = estimateRent(listing.price);
      doc.fontSize(18).text('Raport dopasowania nieruchomosci', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555').text('Wygenerowano: ' + new Date().toLocaleString('pl-PL'));
      doc.text('Klient: ' + client.imie + ' ' + client.nazwisko);
      doc.moveDown();
      doc.fillColor('#000').fontSize(14).text('Dopasowanie: ' + score + '%', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(13).text('Dane nieruchomosci', { underline: true });
      doc.fontSize(11);
      doc.text('Cena: ' + (listing.price ? listing.price.toLocaleString('pl-PL') + ' zl' : 'brak danych'));
      doc.text('Metraz: ' + (listing.m2 ? listing.m2 + ' m2' : 'brak danych'));
      doc.text('Liczba pokoi: ' + (listing.rooms != null ? listing.rooms : 'brak danych'));
      doc.text('Pietro: ' + (listing.floor != null ? listing.floor : 'brak danych'));
      if (listing.sourceLink) doc.fillColor('#1a56db').text('Zrodlo: ' + listing.sourceLink, { link: listing.sourceLink });
      doc.fillColor('#000');
      doc.moveDown();
      doc.fontSize(13).text('Opis', { underline: true });
      doc.fontSize(10).fillColor('#333').text(listing.raw);
      doc.fillColor('#000');
      doc.moveDown();
      doc.fontSize(13).text('Dojscie do komunikacji', { underline: true });
      doc.fontSize(10).fillColor('#333').text(walkingSection);
      doc.fillColor('#000');
      doc.moveDown();
      doc.fontSize(13).text('Zalety', { underline: true });
      doc.fontSize(10);
      pros.forEach(p => doc.text('- ' + p));
      doc.moveDown(0.5);
      doc.fontSize(13).text('Wady', { underline: true });
      doc.fontSize(10);
      cons.forEach(c => doc.text('- ' + c));
      doc.moveDown();
      doc.fontSize(13).text('Analiza pod wynajem (szacunkowa)', { underline: true });
      doc.fontSize(10).fillColor('#333').text(rent ? 'Szacunkowy miesieczny czynsz najmu: ok. ' + rent.toLocaleString('pl-PL') + ' zl (przyblizona regula kciuka). Rentownosc roczna brutto: ok. ' + ((rent * 12 / listing.price) * 100).toFixed(1) + '%.' : 'Brak ceny w danych zrodlowych.');
      doc.fillColor('#000');
      doc.moveDown(1.5);
      doc.fontSize(8).fillColor('#888').text('Raport wygenerowany automatycznie na podstawie tresci przeslanych plikow PDF i stron deweloperow. Dane moga byc niekompletne - zalecana weryfikacja u dewelopera.');
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

app.post('/api/research/run', async (req, res) => {
  const { client_id, preferences } = req.body;
  if (!client_id || !preferences || !String(preferences).trim()) {
    return res.status(400).json({ error: 'Wybierz klienta i podaj preferencje.' });
  }
  const client = db.get('clients').find({ id: client_id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });
  const pdfs = db.get('investmentPdfs').filter({ profile_id: req.profileId }).value();
  const links = db.get('developerLinks').filter({ profile_id: req.profileId }).value();
  if (!pdfs.length && !links.length) {
    return res.status(400).json({ error: 'Brak danych zrodlowych - dodaj linki deweloperow lub PDF w Admin Panelu.' });
  }
  let allListings = [];
  for (const pdf of pdfs) {
    allListings = allListings.concat(parseListingsFromText(pdf.text, pdf.filename, null));
  }
  for (const link of links) {
    const text = await fetchDeveloperPageText(link.url);
    allListings = allListings.concat(parseListingsFromText(text, link.label || link.url, link.url));
  }
  if (!allListings.length) {
    return res.status(422).json({ error: 'Nie udalo sie wyodrebnic zadnych ofert z podanych zrodel.' });
  }
  const criteria = extractPreferenceCriteria(preferences);
  const scored = allListings.map(listing => ({ listing, score: scoreListing(listing, criteria) }));
  scored.sort((a, b) => b.score - a.score);
  const strong = scored.filter(s => s.score >= 90).slice(0, 5);
  const needsPreferenceChange = strong.length === 0;
  const chosen = needsPreferenceChange ? scored.filter(s => s.score >= 60 && s.score < 90).slice(0, 5) : strong;
  const results = [];
  for (const item of chosen) {
    const pdfBuffer = await buildReportPdfBuffer({ client, listing: item.listing, score: item.score });
    results.push({
      score: item.score,
      price: item.listing.price,
      m2: item.listing.m2,
      rooms: item.listing.rooms,
      floor: item.listing.floor,
      source: item.listing.source,
      sourceLink: item.listing.sourceLink,
      excerpt: item.listing.raw.slice(0, 300),
      pdfBase64: pdfBuffer.toString('base64')
    });
  }
  res.json({ needsPreferenceChange, results });
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
