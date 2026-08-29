const STAGE_COLORS = {};
let STAGES = [];
let clients = [];
let activities = [];

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

// ---------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------
$$('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    if (view === 'contacts') renderContacts();
    if (view === 'activities') renderActivities();
  });
});

// ---------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------
async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Wystąpił błąd.' }));
    throw new Error(err.error || 'Wystąpił błąd.');
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
async function init() {
  STAGES = await api('/stages');
  STAGES.forEach((s, i) => STAGE_COLORS[s] = `var(--stage-${i + 1})`);
  const stageSelect = $('#lead-stage');
  stageSelect.innerHTML = STAGES.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');

  await refreshAll();
  renderBoard();
}

async function refreshAll() {
  [clients, activities] = await Promise.all([api('/clients'), api('/activities')]);
}

function initials(c) {
  return `${(c.imie || '?')[0] || ''}${(c.nazwisko || '?')[0] || ''}`.toUpperCase();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

// ---------------------------------------------------------------------
// DEALS BOARD
// ---------------------------------------------------------------------
function renderBoard() {
  const board = $('#board');
  board.innerHTML = STAGES.map((stage, i) => {
    const stageClients = clients.filter(c => c.stage === stage);
    return `
      <div class="column" data-stage="${escapeHtml(stage)}">
        <div class="column-header" style="--stage-color:${STAGE_COLORS[stage]}">
          <span class="column-title">${escapeHtml(stage)}</span>
          <span class="column-count" style="--stage-color:${STAGE_COLORS[stage]}">${stageClients.length}</span>
        </div>
        <div class="column-body" data-stage="${escapeHtml(stage)}">
          ${stageClients.length ? stageClients.map(c => cardHtml(c, stage)).join('') : `<div class="column-empty">Brak klientów</div>`}
        </div>
      </div>
    `;
  }).join('');

  attachBoardEvents();
}

function cardHtml(c, stage) {
  return `
    <div class="card" draggable="true" data-id="${c.id}" style="--stage-color:${STAGE_COLORS[stage]}">
      <div class="card-top">
        <div class="avatar" style="--stage-color:${STAGE_COLORS[stage]}">${escapeHtml(initials(c))}</div>
        <div>
          <div class="card-name">${escapeHtml(c.imie)} ${escapeHtml(c.nazwisko)}</div>
          <div class="card-meta">${escapeHtml(c.telefon || 'brak telefonu')}</div>
        </div>
      </div>
      ${c.preferencje ? `<div class="card-pref">${escapeHtml(c.preferencje)}</div>` : ''}
      <div class="card-actions">
        <button class="btn-small btn-action" data-id="${c.id}">+ Akcja</button>
        <button class="btn-small btn-edit" data-id="${c.id}">Edytuj</button>
      </div>
    </div>
  `;
}

let draggedId = null;

function attachBoardEvents() {
  $$('.card').forEach(card => {
    card.addEventListener('dragstart', () => {
      draggedId = card.dataset.id;
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedId = null;
    });
  });

  $$('.column-body').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const newStage = col.dataset.stage;
      if (!draggedId) return;
      const client = clients.find(c => c.id === draggedId);
      if (!client || client.stage === newStage) return;
      try {
        await api(`/clients/${draggedId}`, { method: 'PUT', body: JSON.stringify({ stage: newStage }) });
        client.stage = newStage;
        renderBoard();
        toast(`Przeniesiono do "${newStage}"`);
      } catch (err) {
        toast(err.message);
      }
    });
  });

  $$('.btn-action').forEach(btn => btn.addEventListener('click', () => openActionModal(btn.dataset.id)));
  $$('.btn-edit').forEach(btn => btn.addEventListener('click', () => openLeadModal(btn.dataset.id)));
}

// ---------------------------------------------------------------------
// CONTACTS TABLE
// ---------------------------------------------------------------------
function renderContacts() {
  const body = $('#contacts-body');
  if (!clients.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state">Brak kontaktów. Dodaj pierwszy lead w zakładce Deals.</div></td></tr>`;
    return;
  }
  body.innerHTML = clients.map(c => `
    <tr>
      <td>${escapeHtml(c.imie)}</td>
      <td>${escapeHtml(c.nazwisko)}</td>
      <td>${escapeHtml(c.mail) || '—'}</td>
      <td>${escapeHtml(c.telefon) || '—'}</td>
      <td>${escapeHtml(c.preferencje) || '—'}</td>
      <td><span class="stage-pill" style="--stage-color:${STAGE_COLORS[c.stage]}">${escapeHtml(c.stage)}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn-small btn-edit-contact" data-id="${c.id}">Edytuj</button>
          <button class="btn-small btn-danger btn-delete-contact" data-id="${c.id}">Usuń</button>
        </div>
      </td>
    </tr>
  `).join('');

  $$('.btn-edit-contact').forEach(btn => btn.addEventListener('click', () => openLeadModal(btn.dataset.id)));
  $$('.btn-delete-contact').forEach(btn => btn.addEventListener('click', () => deleteClient(btn.dataset.id)));
}

async function deleteClient(id) {
  if (!confirm('Usunąć tego klienta i powiązane z nim akcje?')) return;
  try {
    await api(`/clients/${id}`, { method: 'DELETE' });
    await refreshAll();
    renderContacts();
    renderBoard();
    toast('Kontakt usunięty.');
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------------
// ACTIVITIES LIST
// ---------------------------------------------------------------------
const WEEKDAYS = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'Sb'];

function renderActivities() {
  const list = $('#activities-list');
  if (!activities.length) {
    list.innerHTML = `<div class="empty-state">Brak zaplanowanych akcji. Dodaj akcję z poziomu karty klienta w zakładce Deals.</div>`;
    return;
  }
  const sorted = [...activities].sort((a, b) => new Date(a.date) - new Date(b.date));
  const today = new Date(); today.setHours(0, 0, 0, 0);

  list.innerHTML = sorted.map(a => {
    const d = new Date(a.date + 'T00:00:00');
    const overdue = !a.done && d < today;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `
      <div class="activity-item ${a.done ? 'done' : ''} ${overdue ? 'activity-overdue' : ''}">
        <div class="activity-date">
          <span class="weekday">${WEEKDAYS[d.getDay()]}</span>
          ${day}.${month}
        </div>
        <div class="activity-body">
          <div class="activity-title">${escapeHtml(a.action_name)}</div>
          <div class="activity-client">${escapeHtml(a.client_name)}</div>
          <div class="activity-meta">${escapeHtml(a.client_telefon || a.client_phone || '')} ${a.client_mail ? '· ' + escapeHtml(a.client_mail) : ''}</div>
          ${a.notes ? `<div class="activity-notes">${escapeHtml(a.notes)}</div>` : ''}
        </div>
        <div class="activity-controls">
          <label class="checkbox-label">
            <input type="checkbox" data-id="${a.id}" class="chk-done" ${a.done ? 'checked' : ''} />
            Wykonane
          </label>
          <button class="btn-small btn-danger btn-delete-activity" data-id="${a.id}">Usuń</button>
        </div>
      </div>
    `;
  }).join('');

  $$('.chk-done').forEach(chk => chk.addEventListener('change', async () => {
    try {
      await api(`/activities/${chk.dataset.id}`, { method: 'PUT', body: JSON.stringify({ done: chk.checked }) });
      await refreshAll();
      renderActivities();
    } catch (err) { toast(err.message); }
  }));
  $$('.btn-delete-activity').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Usunąć tę akcję?')) return;
    try {
      await api(`/activities/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshAll();
      renderActivities();
      toast('Akcja usunięta.');
    } catch (err) { toast(err.message); }
  }));
}

// ---------------------------------------------------------------------
// MODALS: New / Edit Lead
// ---------------------------------------------------------------------
function openModal(id) { $(`#${id}`).classList.add('open'); }
function closeModal(id) { $(`#${id}`).classList.remove('open'); }

$$('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
$$('.modal-overlay').forEach(overlay => overlay.addEventListener('click', e => {
  if (e.target === overlay) overlay.classList.remove('open');
}));

function openLeadModal(id) {
  const form = $('#form-lead');
  form.reset();
  $('#lead-id').value = '';
  $('#lead-stage-field').style.display = 'flex';

  if (id) {
    const c = clients.find(x => x.id === id);
    if (!c) return;
    $('#lead-modal-title').textContent = 'Edytuj kontakt';
    $('#lead-id').value = c.id;
    $('#lead-imie').value = c.imie;
    $('#lead-nazwisko').value = c.nazwisko;
    $('#lead-mail').value = c.mail;
    $('#lead-telefon').value = c.telefon;
    $('#lead-preferencje').value = c.preferencje;
    $('#lead-stage').value = c.stage;
  } else {
    $('#lead-modal-title').textContent = 'Nowy Lead';
    $('#lead-stage').value = STAGES[0];
  }
  openModal('modal-lead');
}

$('#btn-new-lead').addEventListener('click', () => openLeadModal(null));
$('#btn-new-lead-contacts').addEventListener('click', () => openLeadModal(null));

$('#form-lead').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#lead-id').value;
  const payload = {
    imie: $('#lead-imie').value.trim(),
    nazwisko: $('#lead-nazwisko').value.trim(),
    mail: $('#lead-mail').value.trim(),
    telefon: $('#lead-telefon').value.trim(),
    preferencje: $('#lead-preferencje').value.trim(),
    stage: $('#lead-stage').value
  };
  try {
    if (id) {
      await api(`/clients/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Kontakt zaktualizowany.');
    } else {
      await api('/clients', { method: 'POST', body: JSON.stringify(payload) });
      toast('Nowy lead dodany.');
    }
    await refreshAll();
    renderBoard();
    renderContacts();
    closeModal('modal-lead');
  } catch (err) {
    toast(err.message);
  }
});

// ---------------------------------------------------------------------
// MODAL: New Action
// ---------------------------------------------------------------------
function openActionModal(clientId) {
  const c = clients.find(x => x.id === clientId);
  if (!c) return;
  $('#form-action').reset();
  $('#action-client-id').value = clientId;
  $('#action-client-name').textContent = `${c.imie} ${c.nazwisko}`;
  const todayStr = new Date().toISOString().slice(0, 10);
  $('#action-date').value = todayStr;
  openModal('modal-action');
}

$('#form-action').addEventListener('submit', async e => {
  e.preventDefault();
  const payload = {
    client_id: $('#action-client-id').value,
    action_name: $('#action-name').value.trim(),
    date: $('#action-date').value,
    notes: $('#action-notes').value.trim()
  };
  try {
    await api('/activities', { method: 'POST', body: JSON.stringify(payload) });
    await refreshAll();
    toast('Akcja zaplanowana.');
    closeModal('modal-action');
  } catch (err) {
    toast(err.message);
  }
});

init();
