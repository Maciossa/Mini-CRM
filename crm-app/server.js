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

const ADMIN_EMAILS = ['cezary5522@gmail.com', 'maciekmalicki060503@gmail.com'];

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
    prowizja_agenta: p.prowizja_agenta || 50
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
  if (!payload) return res.status(401).json({ error: 'Musisz się zalogować.' });
  const account = db.get('accounts').find({ id: payload.accountId }).value();
  if (!account) return res.status(401).json({ error: 'Konto nie istnieje. Zaloguj się ponownie.' });
  req.accountId = account.id;
  next();
}

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

function requireAdmin(req, res, next) {
  const account = db.get('accounts').find({ id: req.accountId }).value();
  if (!account || !ADMIN_EMAILS.includes(account.mail)) {
    return res.status(403).json({ error: 'Brak dostępu do Admin Panelu.' });
  }
  next();
}

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

app.get('/api/system/status', (req, res) => {
  res.json({ persistent: Boolean(process.env.DB_PATH) });
});

app.get('/api/stages', (req, res) => {
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
    deal_status: null,
    created_at: now(),
    updated_at: now()
  };
  db.get('clients').push(client).write();
  res.status(201).json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const client = db.get('clients').find({ id: req.params.id, profile_id: req.profileId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const allowed = ['imie', 'nazwisko', 'mail', 'telefon', 'preferencje', 'stage', 'inwestycja', 'cena_nieruchomosci', 'prowizja_procent', 'deal_status'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.stage && !STAGES.includes(updates.stage)) {
    return res.status(400).json({ error: 'Nieprawidłowy etap.' });
  }
  if (updates.deal_status !== undefined && ![null, 'won', 'lost'].includes(updates.deal_status)) {
    return res.status(400).json({ error: 'Nieprawidłowy status transakcji.' });
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
    res.status(400).json({ error: 'Nie udało się odczytać PDF-a. Upewnij się, że to poprawny plik PDF.' });
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
    const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MiniCRM-FastResearch/1.0)' } });
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
    const priceMatch = chunk.match(/([\d][\d\s.,]{3,})\s*(?:z[łl]|PLN)\b/i);
    const m2Match = chunk.match(/(\d{2,3}(?:[.,]\d{1,2})?)\s*m(?:2|²)/i);
    const roomsMatch = chunk.match(/(\d)\s*(?:pok(?:ój|oje|oi|ojowe)?)/i);
    const floorMatch = chunk.match(/(parter|\d{1,2})\s*(?:piętro|pietro|p\.)/i);
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

const PREFERENCE_STOPWORDS = new Set([
  'szukam', 'szukamy', 'mieszkania', 'mieszkanie', 'klient', 'klienta', 'preferuje',
  'preferencje', 'chcialby', 'chcialaby', 'chce', 'chcemy', 'najlepiej', 'ewentualnie',
  'oraz', 'lub', 'okolo', 'budzet', 'budzetu', 'cena', 'ceny', 'zeby', 'ktore', 'ktora',
  'jest', 'tak', 'nie', 'bardzo', 'raczej', 'jakies', 'jakis', 'moze', 'mozliwie'
]);

function extractPreferenceCriteria(prefText) {
  const t = prefText.toLowerCase();
  const rooms = t.match(/(\d)\s*(?:pok(?:ój|oje|oi|ojowe|ojowy|ojowego)?)/);
  const maxPriceMatch = t.match(/(?:do|max|maks\w*|bud[żz]et[a-z]*)\D{0,10}([\d][\d\s.,]{3,})\s*(?:z[łl]|pln|tys)/);
  const m2RangeMatch = t.match(/(\d{2,3})\s*(?:-|do)\s*(\d{2,3})\s*m(?:2|²)/);
  const m2SingleMatch = t.match(/(\d{2,3})\s*m(?:2|²)/);
  const words = t.split(/[^a-ząćęłńóśźż0-9]+/i)
    .filter(w => w.length > 3 && !/^\d+$/.test(w) && !PREFERENCE_STOPWORDS.has(w));
  return {
    rooms: rooms ? Number(rooms[1]) : null,
    maxPrice: maxPriceMatch ? Number(maxPriceMatch[1].replace(/[^\d]/g, '')) * (/tys/.test(maxPriceMatch[0]) ? 1000 : 1) : null,
    m2Min: m2RangeMatch ? Number(m2RangeMatch[1]) : (m2SingleMatch ? Number(m2SingleMatch[1]) * 0.85 : null),
    m2Max: m2RangeMatch ? Number(m2RangeMatch[2]) : (m2SingleMatch ? Number(m2SingleMatch[1]) * 1.15 : null),
    words: Array.from(new Set(words))
  };
}

function scoreListing(listing, criteria, prefTextLower) {
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
  { keyword: /metro|tramwaj|autobus|komunikacj/i, pro: 'Dobra dostępność komunikacji miejskiej (wg opisu).' },
  { keyword: /balkon|taras|ogr[óo]dek/i, pro: 'Dodatkowa przestrzeń zewnętrzna (balkon/taras/ogródek).' },
  { keyword: /winda/i, pro: 'Budynek wyposażony w windę.' },
  { keyword: /garaż|miejsce postojowe|parking/i, pro: 'Zapewnione miejsce parkingowe/garaż.' },
  { keyword: /parter/i, con: 'Lokal na parterze — może wiązać się z mniejszą prywatnością.' },
  { keyword: /bez windy/i, con: 'Budynek bez windy.' },
  { keyword: /do remontu|stan deweloperski surowy/i, con: 'Lokal wymaga dodatkowych nakładów wykończeniowych.' }
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
  if (!pros.length) pros.push('Brak wystarczających danych w opisie, by wskazać dodatkowe zalety — zalecana wizja lokalna.');
  if (!cons.length) cons.push('Brak wykrytych istotnych wad na podstawie opisu — zalecana weryfikacja na miejscu.');
  return { pros, cons };
}

async function buildWalkingDistanceSection(listing) {
  if (process.env.GOOGLE_MAPS_API_KEY) {
    return 'Klucz Google Maps API wykryty, ale integracja czasu dojścia pieszo nie jest jeszcze podłączona w tej wersji — skontaktuj się, aby ją aktywować.';
  }
  return 'Brak klucza GOOGLE_MAPS_API_KEY w konfiguracji serwera — dokładny czas dojścia pieszo do komunikacji nie mógł zostać wyliczony automatycznie. Dodaj ten klucz jako zmienną środowiskową na Render, aby włączyć tę analizę.';
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
      const walkingSection = await buildWalkingDistanceSection(listing);
      const rent = estimateRent(listing.price);

      doc.fontSize(18).text('Raport dopasowania nieruchomosci', { underline: true });
      doc.moveDown(0.5);
      doc.fontSize(11).fillColor('#555').text(`Wygenerowano: ${new Date().toLocaleString('pl-PL')}`);
      doc.text(`Klient: ${client.imie} ${client.nazwisko}`);
      doc.moveDown();

      doc.fillColor('#000').fontSize(14).text(`Dopasowanie: ${score}%`, { underline: true });
      doc.moveDown(0.5);

      doc.fontSize(13).text('Dane nieruchomosci', { underline: true });
      doc.fontSize(11);
      doc.text(`Cena: ${listing.price ? listing.price.toLocaleString('pl-PL') + ' zl' : 'brak danych'}`);
      doc.text(`Metraz: ${listing.m2 ? listing.m2 + ' m2' : 'brak danych'}`);
      doc.text(`Liczba pokoi: ${listing.rooms ?? 'brak danych'}`);
      doc.text(`Pietro: ${listing.floor ?? 'brak danych'}`);
      if (listing.sourceLink) doc.fillColor('#1a56db').text(`Zrodlo: ${listing.sourceLink}`, { link: listing.sourceLink });
      doc.fillColor('#000');
      doc.moveDown();

      doc.fontSize(13).text('Opis (wyodrebniony z materialow zrodlowych)', { underline: true });
      doc.fontSize(10).fillColor('#333').text(listing.raw);
      doc.fillColor('#000');
      doc.moveDown();

      doc.fontSize(13).text('Dojscie do komunikacji', { underline: true });
      doc.fontSize(10).fillColor('#333').text(walkingSection);
      doc.fillColor('#000');
      doc.moveDown();

      doc.fontSize(13).text('Zalety', { underline: true });
      doc.fontSize(10);
      pros.forEach(p => doc.text(`- ${p}`));
      doc.moveDown(0.5);
      doc.fontSize(13).text('Wady', { underline: true });
      doc.fontSize(10);
      cons.forEach(c => doc.text(`- ${c}`));
      doc.moveDown();

      doc.fontSize(13).text('Analiza pod wynajem (szacunkowa)', { underline: true });
      doc.fontSize(10).fillColor('#333').text(
        rent
          ? `Szacunkowy miesieczny czynsz najmu: ok. ${rent.toLocaleString('pl-PL')} zl (bardzo przyblizona regula kciuka, nie stanowi analizy rynkowej). Rentownosc roczna brutto: ok. ${((rent * 12 / listing.price) * 100).toFixed(1)}%.`
          : 'Brak ceny nieruchomosci w danych zrodlowych - nie mozna wyliczyc szacunkowej rentownosci najmu.'
      );
      doc.fillColor('#000');

      doc.moveDown(1.5);
      doc.fontSize(8).fillColor('#888').text(
        'Raport wygenerowany automatycznie na podstawie tresci przeslanych plikow PDF i stron deweloperow. Dane moga byc niekompletne lub nieaktualne - zalecana weryfikacja bezposrednio u dewelopera.',
        { align: 'left' }
      );

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
    return res.status(400).json({ error: 'Brak danych źródłowych — poproś administratora o dodanie linków deweloperów lub PDF z inwestycjami w Admin Panelu.' });
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
    return res.status(422).json({ error: 'Nie udało się wyodrębnić żadnych ofert z podanych źródeł. Sprawdź, czy PDF zawiera czytelny tekst, a strony deweloperów są dostępne publicznie.' });
  }

  const criteria = extractPreferenceCriteria(preferences);
  const prefLower = String(preferences).toLowerCase();
  const scored = allListings.map(listing => ({ listing, score: scoreListing(listing, criteria, prefLower) }));
  scored.sort((a, b) => b.score - a.score);

  const strong = scored.filter(s => s.score >= 90).slice(0, 5);
  const needsPreferenceChange = strong.length === 0;
  const chosen = needsPreferenceChange
    ? scored.filter(s => s.score >= 60 && s.score < 90).slice(0, 5)
    : strong;

  const results = [];
  for (const { listing, score } of chosen) {
    const pdfBuffer = await buildReportPdfBuffer({ client, listing, score });
    results.push({
      score,
      price: listing.price,
      m2: listing.m2,
      rooms: listing.rooms,
      floor: listing.floor,
      source: listing.source,
      sourceLink: listing.sourceLink,
      excerpt: listing.raw.slice(0, 300),
      pdfBase64: pdfBuffer.toString('base64')
    });
  }

  const report = {
    id: uuidv4(),
    profile_id: req.profileId,
    client_id,
    created_at: now(),
    needsPreferenceChange,
    resultCount: results.length
  };
  db.get('researchReports').remove({ profile_id: req.profileId, client_id }).write();
  db.get('researchReports').push(report).write();

  res.json({ needsPreferenceChange, results });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mini CRM listening on port ${PORT}`);
});
