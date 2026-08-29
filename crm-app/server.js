const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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

db.defaults({ clients: [], activities: [] }).write();

// --- App setup ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Helpers ---------------------------------------------------------------
function now() {
  return new Date().toISOString();
}

// --- CLIENTS (used for both Deals board and Contacts list) ----------------

app.get('/api/stages', (req, res) => {
  res.json(STAGES);
});

app.get('/api/clients', (req, res) => {
  res.json(db.get('clients').value());
});

app.post('/api/clients', (req, res) => {
  const { imie, nazwisko, mail, telefon, preferencje, stage } = req.body;
  if (!imie || !nazwisko) {
    return res.status(400).json({ error: 'Imię i nazwisko są wymagane.' });
  }
  const client = {
    id: uuidv4(),
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
  const client = db.get('clients').find({ id: req.params.id }).value();
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

  db.get('clients').find({ id: req.params.id }).assign(updates).write();
  res.json(db.get('clients').find({ id: req.params.id }).value());
});

app.delete('/api/clients/:id', (req, res) => {
  db.get('clients').remove({ id: req.params.id }).write();
  // also clean up related activities
  db.get('activities').remove({ client_id: req.params.id }).write();
  res.status(204).end();
});

// --- ACTIVITIES -------------------------------------------------------------

app.get('/api/activities', (req, res) => {
  const clients = db.get('clients').value();
  const activities = db.get('activities').value().map(a => {
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
  const { client_id, action_name, date, notes } = req.body;
  if (!client_id || !action_name || !date) {
    return res.status(400).json({ error: 'client_id, action_name i date są wymagane.' });
  }
  const client = db.get('clients').find({ id: client_id }).value();
  if (!client) return res.status(404).json({ error: 'Nie znaleziono klienta.' });

  const activity = {
    id: uuidv4(),
    client_id,
    action_name,
    date,
    notes: notes || '',
    done: false,
    created_at: now()
  };
  db.get('activities').push(activity).write();
  res.status(201).json(activity);
});

app.put('/api/activities/:id', (req, res) => {
  const activity = db.get('activities').find({ id: req.params.id }).value();
  if (!activity) return res.status(404).json({ error: 'Nie znaleziono akcji.' });

  const allowed = ['action_name', 'date', 'notes', 'done'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  db.get('activities').find({ id: req.params.id }).assign(updates).write();
  res.json(db.get('activities').find({ id: req.params.id }).value());
});

app.delete('/api/activities/:id', (req, res) => {
  db.get('activities').remove({ id: req.params.id }).write();
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
