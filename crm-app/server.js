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
// DB_PATH can point at a Railway Volume (e.g. /data/db.json) so data
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
  'Sprzedaż',
  'Stary Lead'
];

db.defaults({ clients: [], activities: [], users: [], meta: {} }).write();

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

function publicUser(u) {
  return { id: u.id, imie_nazwisko: u.imie_nazwisko, pseudonim: u.pseudonim, mail: u.mail };
}

function issueSession(res, user) {
  const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Musisz się zalogować.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.get('users').find({ id: payload.userId }).value();
    if (!user) return res.status(401).json({ error: 'Profil nie istnieje. Zaloguj się ponownie.' });
    req.userId = user.id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesja wygasła. Zaloguj się ponownie.' });
  }
}

// --- AUTH / PROFILES --------------------------------------------------------

// Public list of profiles (name + id only) for the profile picker.
app.get('/api/auth/profiles', (req, res) => {
  const list = db.get('users')
    .map(u => ({ id: u.id, pseudonim: u.pseudonim }))
    .value()
    .sort((a, b) => a.pseudonim.localeCompare(b.pseudonim, 'pl'));
  res.json(list);
});

app.post('/api/auth/register', async (req, res) => {
  const { imie_nazwisko, pseudonim, mail, password } = req.body;
  if (!imie_nazwisko || !pseudonim || !mail || !password) {
    return res.status(400).json({ error: 'Wszystkie pola są wymagane.' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'Hasło musi mieć co najmniej 6 znaków.' });
  }
  const mailNorm = String(mail).trim().toLowerCase();
  const pseudonimNorm = String(pseudonim).trim();

  const mailTaken = db.get('users').find(u => u.mail.toLowerCase() === mailNorm).value();
  if (mailTaken) return res.status(409).json({ error: 'Ten adres mail jest już zarejestrowany.' });

  const pseudonimTaken = db.get('users').find(u => u.pseudonim.toLowerCase() === pseudonimNorm.toLowerCase()).value();
  if (pseudonimTaken) return res.status(409).json({ error: 'Ten pseudonim jest już zajęty.' });

  const password_hash = await bcrypt.hash(String(password), 10);
  const user = {
    id: uuidv4(),
    imie_nazwisko: String(imie_nazwisko).trim(),
    pseudonim: pseudonimNorm,
    mail: mailNorm,
    password_hash,
    created_at: now()
  };
  db.get('users').push(user).write();
  issueSession(res, user);
  res.status(201).json(publicUser(user));
});

app.post('/api/auth/login', async (req, res) => {
  const { profileId, password } = req.body;
  if (!profileId || !password) {
    return res.status(400).json({ error: 'Wybierz profil i podaj hasło.' });
  }
  const user = db.get('users').find({ id: profileId }).value();
  if (!user) return res.status(404).json({ error: 'Nie znaleziono profilu.' });

  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Nieprawidłowe hasło.' });

  issueSession(res, user);
  res.json(publicUser(user));
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.get('users').find({ id: req.userId }).value();
  res.json(publicUser(user));
});

// --- STAGES (public, static) ------------------------------------------------

app.get('/api/stages', (req, res) => {
  res.json(STAGES);
});

// Every route below requires a logged-in profile and is scoped to that user.
app.use('/api/clients', requireAuth);
app.use('/api/activities', requireAuth);

// --- CLIENTS (used for both Deals board and Contacts list) ----------------

app.get('/api/clients', (req, res) => {
  res.json(db.get('clients').filter({ user_id: req.userId }).value());
});

app.post('/api/clients', (req, res) => {
  const { imie, nazwisko, mail, telefon, preferencje, stage } = req.body;
  if (!imie || !nazwisko) {
    return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });
  }
  const client = {
    id: uuidv4(),
    user_id: req.userId,
    imie,
    nazwisko,
    mail: mail || '',
    telefon: telefon || '',
    preferencje: preferencje || '',
    stage: STAGES.includes(stage) ? stage : STAGES[0],
    created_at: now(),
    updated_at: now()
  };
  db.get('clients').push(client).write();
  res.status(201).json(client);
});

app.put('/api/clients/:id', (req, res) => {
  const client = db.get('clients').find({ id: req.params.id, user_id: req.userId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const allowed = ['imie', 'nazwisko', 'mail', 'telefon', 'preferencje', 'stage'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.stage && !STAGES.includes(updates.stage)) {
    return res.status(400).json({ error: 'Nieprawidłowy etap.' });
  }
  updates.updated_at = now();

  db.get('clients').find({ id: req.params.id, user_id: req.userId }).assign(updates).write();
  res.json(db.get('clients').find({ id: req.params.id, user_id: req.userId }).value());
});

app.delete('/api/clients/:id', (req, res) => {
  db.get('clients').remove({ id: req.params.id, user_id: req.userId }).write();
  // also clean up related activities
  db.get('activities').remove({ client_id: req.params.id, user_id: req.userId }).write();
  res.status(204).end();
});

// --- ACTIVITIES -------------------------------------------------------------

app.get('/api/activities', (req, res) => {
  const clients = db.get('clients').filter({ user_id: req.userId }).value();
  const activities = db.get('activities').filter({ user_id: req.userId }).value().map(a => {
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
  const client = db.get('clients').find({ id: client_id, user_id: req.userId }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const activity = {
    id: uuidv4(),
    user_id: req.userId,
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
  const activity = db.get('activities').find({ id: req.params.id, user_id: req.userId }).value();
  if (!activity) return res.status(404).json({ error: 'Nie znaleziono akcji.' });

  const allowed = ['action_name', 'date', 'time', 'notes', 'done', 'client_id'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (updates.client_id && !db.get('clients').find({ id: updates.client_id, user_id: req.userId }).value()) {
    return res.status(404).json({ error: 'Nie znaleziono klienta.' });
  }
  db.get('activities').find({ id: req.params.id, user_id: req.userId }).assign(updates).write();
  res.json(db.get('activities').find({ id: req.params.id, user_id: req.userId }).value());
});

app.delete('/api/activities/:id', (req, res) => {
  db.get('activities').remove({ id: req.params.id, user_id: req.userId }).write();
  res.status(204).end();
});

// --- Fallback: serve the SPA for any other route --------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mini CRM listening on port ${PORT}`);
});
