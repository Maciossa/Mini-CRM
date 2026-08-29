const STAGE_COLORS = {};
let STAGES = [];
let clients = [];
let activities = [];
let currentUser = null;

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function initials2(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || (parts[0] || '')[1] || '');
}

// ---------------------------------------------------------------------
// AUTH GATE: profile picker / login / register
// ---------------------------------------------------------------------
async function bootstrap() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      currentUser = await res.json();
      showApp();
      return;
    }
  } catch (e) { /* fall through to auth screen */ }
  showAuthScreen();
}

function showAuthScreen() {
  $('#app-root').style.display = 'none';
  $('#auth-screen').style.display = 'flex';
  loadProfilePicker();
}

async function showApp() {
  $('#auth-screen').style.display = 'none';
  $('#app-root').style.display = 'flex';
  $('#sidebar-current-user').textContent = `Zalogowano jako ${currentUser.pseudonim}`;
  await init();
}

async function loadProfilePicker() {
  setAuthState('picker');
  const grid = $('#profile-grid');
  grid.innerHTML = '<div class="profile-empty">Wczytywanie profili...</div>';
  try {
    const profiles = await (await fetch('/api/auth/profiles')).json();
    if (!profiles.length) {
      grid.innerHTML = '<div class="profile-empty">Brak profili. Stwórz pierwszy, aby zacząć.</div>';
      return;
    }
    grid.innerHTML = profiles.map(p => `
      <div class="profile-tile" data-id="${p.id}" data-pseudonim="${escapeHtml(p.pseudonim)}">
        <div class="avatar" style="--stage-color:var(--gold); width:34px;height:34px;font-size:13px;">${escapeHtml(initials2(p.pseudonim))}</div>
        <div class="profile-tile-name">${escapeHtml(p.pseudonim)}</div>
      </div>
    `).join('');
    $$('.profile-tile').forEach(tile => tile.addEventListener('click', () => {
      showLoginFor(tile.dataset.id, tile.dataset.pseudonim);
    }));
  } catch (e) {
    grid.innerHTML = '<div class="profile-empty">Nie udało się wczytać profili.</div>';
  }
}

function setAuthState(state) {
  $('#auth-picker').style.display = state === 'picker' ? 'block' : 'none';
  $('#auth-login').style.display = state === 'login' ? 'block' : 'none';
  $('#auth-register').style.display = state === 'register' ? 'block' : 'none';
}

function showLoginFor(id, pseudonim) {
  setAuthState('login');
  $('#login-profile-id').value = id;
  $('#login-pseudonim').textContent = pseudonim;
  $('#login-avatar').textContent = initials2(pseudonim).toUpperCase();
  $('#login-password').value = '';
  $('#login-error').textContent = '';
  setTimeout(() => $('#login-password').focus(), 50);
}

$('#btn-show-register').addEventListener('click', () => {
  setAuthState('register');
  $('#form-register').reset();
  $('#register-error').textContent = '';
});
$('#btn-back-from-login').addEventListener('click', loadProfilePicker);
$('#btn-back-from-register').addEventListener('click', loadProfilePicker);

$('#form-login').addEventListener('submit', async e => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId: $('#login-profile-id').value,
        password: $('#login-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nie udało się zalogować.');
    currentUser = data;
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#form-register').addEventListener('submit', async e => {
  e.preventDefault();
  $('#register-error').textContent = '';
  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imie_nazwisko: $('#reg-name').value.trim(),
        pseudonim: $('#reg-pseudonim').value.trim(),
        mail: $('#reg-mail').value.trim(),
        password: $('#reg-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nie udało się stworzyć profilu.');
    currentUser = data;
    showApp();
  } catch (err) {
    $('#register-error').textContent = err.message;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  currentUser = null;
  clients = [];
  activities = [];
  $$('.nav-item').forEach(b => b.classList.remove('active'));
  $('.nav-item[data-view="deals"]').classList.add('active');
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-deals').classList.add('active');
  showAuthScreen();
});

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
    if (view === 'calendar') renderCalendar();
    if (view === 'profile') renderProfileView();
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
  if (res.status === 401) {
    currentUser = null;
    showAuthScreen();
    throw new Error('Sesja wygasła. Zaloguj się ponownie.');
  }
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

function renderProfileView() {
  if (!currentUser) return;
  $('#profile-avatar').textContent = initials2(currentUser.pseudonim).toUpperCase();
  $('#profile-full-name').textContent = currentUser.imie_nazwisko;
  $('#profile-pseudonim').textContent = currentUser.pseudonim;
  $('#profile-mail').textContent = currentUser.mail;
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
    card.addEventListener('click', e => {
      if (e.target.closest('button')) return; // buttons handle their own actions
      openClientViewModal(card.dataset.id);
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
// CLIENT DETAILS MODAL (click on a Deals card)
// ---------------------------------------------------------------------
function openClientViewModal(id) {
  const c = clients.find(x => x.id === id);
  if (!c) return;

  const clientActivities = activities
    .filter(a => a.client_id === id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const body = $('#client-view-body');
  body.innerHTML = `
    <div class="client-view-header">
      <div class="client-view-avatar" style="--stage-color:${STAGE_COLORS[c.stage]}">${escapeHtml(initials(c))}</div>
      <div>
        <div class="client-view-name">${escapeHtml(c.imie)} ${escapeHtml(c.nazwisko)}</div>
        <span class="stage-pill" style="--stage-color:${STAGE_COLORS[c.stage]}">${escapeHtml(c.stage)}</span>
      </div>
    </div>
    <div class="client-view-grid">
      <div>
        <div class="client-view-label">Mail</div>
        <div class="client-view-value">${escapeHtml(c.mail) || '—'}</div>
      </div>
      <div>
        <div class="client-view-label">Telefon</div>
        <div class="client-view-value">${escapeHtml(c.telefon) || '—'}</div>
      </div>
      <div class="full">
        <div class="client-view-label">Preferencje</div>
        <div class="client-view-value">${escapeHtml(c.preferencje) || '—'}</div>
      </div>
      <div>
        <div class="client-view-label">Dodano</div>
        <div class="client-view-value">${new Date(c.created_at).toLocaleDateString('pl-PL')}</div>
      </div>
    </div>
    <div class="client-view-section-title">Zaplanowane akcje (${clientActivities.length})</div>
    <div class="client-view-activities">
      ${clientActivities.length ? clientActivities.map(a => `
        <div class="client-view-activity ${a.done ? 'done' : ''}">
          <span>${escapeHtml(a.action_name)}${a.notes ? ' — ' + escapeHtml(a.notes) : ''}</span>
          <span class="a-date">${new Date(a.date + 'T00:00:00').toLocaleDateString('pl-PL')}${a.time ? ' ' + escapeHtml(a.time) : ''}</span>
        </div>
      `).join('') : '<div class="client-view-value" style="color:var(--text-muted)">Brak zaplanowanych akcji.</div>'}
    </div>
  `;

  $('#client-view-edit-btn').onclick = () => {
    closeModal('modal-client-view');
    openLeadModal(id);
  };

  openModal('modal-client-view');
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
    // Delikatne czerwone podświetlenie od dnia, w którym akcja ma być wykonana (i dalej, jeśli zaległa)
    const attention = !a.done && d <= today;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `
      <div class="activity-item ${a.done ? 'done' : ''} ${attention ? 'attention' : ''}" data-id="${a.id}">
        <div class="activity-date">
          <span class="weekday">${WEEKDAYS[d.getDay()]}</span>
          ${day}.${month}
          ${a.time ? `<span class="time">${escapeHtml(a.time)}</span>` : ''}
        </div>
        <div class="activity-body activity-clickable" data-id="${a.id}">
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

  $$('.chk-done').forEach(chk => chk.addEventListener('click', e => e.stopPropagation()));
  $$('.chk-done').forEach(chk => chk.addEventListener('change', async () => {
    try {
      await api(`/activities/${chk.dataset.id}`, { method: 'PUT', body: JSON.stringify({ done: chk.checked }) });
      await refreshAll();
      renderActivities();
    } catch (err) { toast(err.message); }
  }));
  $$('.btn-delete-activity').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    if (!confirm('Usunąć tę akcję?')) return;
    try {
      await api(`/activities/${btn.dataset.id}`, { method: 'DELETE' });
      await refreshAll();
      renderActivities();
      toast('Akcja usunięta.');
    } catch (err) { toast(err.message); }
  }));
  $$('.activity-clickable').forEach(el => el.addEventListener('click', () => openMeetingModal({ activityId: el.dataset.id })));
}

// ---------------------------------------------------------------------
// CALENDAR
// ---------------------------------------------------------------------
const MONTHS_PL = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];
let calYear, calMonth; // calMonth is 0-indexed

function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }

function initCalendarState() {
  if (calYear === undefined) {
    const now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
  }
}

function renderCalendar() {
  initCalendarState();
  $('#cal-month-label').textContent = `${MONTHS_PL[calMonth]} ${calYear}`;

  const grid = $('#calendar-grid');
  const firstOfMonth = new Date(calYear, calMonth, 1);
  // Monday = 0 ... Sunday = 6
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

  const todayStr = dateStr(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const cells = [];
  // leading days from previous month
  for (let i = 0; i < startOffset; i++) {
    const d = daysInPrevMonth - startOffset + i + 1;
    const prevMonthDate = new Date(calYear, calMonth - 1, d);
    cells.push({ d, ds: dateStr(prevMonthDate.getFullYear(), prevMonthDate.getMonth(), d), outside: true });
  }
  // current month days
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ d, ds: dateStr(calYear, calMonth, d), outside: false });
  }
  // trailing days to complete the grid (multiple of 7)
  let nextDay = 1;
  while (cells.length % 7 !== 0 || cells.length < 35) {
    const nextMonthDate = new Date(calYear, calMonth + 1, nextDay);
    cells.push({ d: nextDay, ds: dateStr(nextMonthDate.getFullYear(), nextMonthDate.getMonth(), nextDay), outside: true });
    nextDay++;
    if (cells.length >= 42) break;
  }

  grid.innerHTML = cells.map(cell => {
    const dayActivities = activities
      .filter(a => a.date === cell.ds)
      .sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const visible = dayActivities.slice(0, 3);
    const extra = dayActivities.length - visible.length;
    const isToday = cell.ds === todayStr;

    return `
      <div class="calendar-day ${cell.outside ? 'outside' : ''} ${isToday ? 'is-today' : ''}" data-date="${cell.ds}">
        <div class="calendar-day-num">${cell.d}</div>
        ${visible.map(a => {
          const attention = !a.done && cell.ds <= todayStr;
          return `<div class="calendar-chip ${attention ? 'attention' : ''} ${a.done ? 'done' : ''}" data-activity-id="${a.id}">${a.time ? escapeHtml(a.time) + ' · ' : ''}${escapeHtml(a.client_name || '')}</div>`;
        }).join('')}
        ${extra > 0 ? `<div class="calendar-more">+${extra} więcej</div>` : ''}
      </div>
    `;
  }).join('');

  $$('.calendar-day').forEach(dayEl => {
    dayEl.addEventListener('click', e => {
      const chip = e.target.closest('.calendar-chip');
      if (chip) {
        openMeetingModal({ activityId: chip.dataset.activityId });
      } else {
        openMeetingModal({ date: dayEl.dataset.date });
      }
    });
  });
}

$('#cal-prev').addEventListener('click', () => {
  initCalendarState();
  calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});
$('#cal-next').addEventListener('click', () => {
  initCalendarState();
  calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});
$('#cal-today').addEventListener('click', () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth();
  renderCalendar();
});
$('#btn-new-meeting').addEventListener('click', () => openMeetingModal({}));

// ---------------------------------------------------------------------
// MODAL: New / Edit meeting (used by Calendar)
// ---------------------------------------------------------------------
function openMeetingModal({ date, activityId }) {
  const form = $('#form-meeting');
  form.reset();

  const clientSelect = $('#meeting-client');
  clientSelect.innerHTML = clients.map(c => `<option value="${c.id}">${escapeHtml(c.imie)} ${escapeHtml(c.nazwisko)}</option>`).join('');

  if (!clients.length) {
    toast('Najpierw dodaj klienta w zakładce Deals lub Contacts.');
    return;
  }

  if (activityId) {
    const a = activities.find(x => x.id === activityId);
    if (!a) return;
    $('#meeting-modal-title').textContent = 'Edytuj spotkanie';
    $('#meeting-id').value = a.id;
    clientSelect.value = a.client_id;
    $('#meeting-title').value = a.action_name;
    $('#meeting-date').value = a.date;
    $('#meeting-time').value = a.time || '';
    $('#meeting-notes').value = a.notes || '';
    $('#meeting-delete-btn').style.display = 'inline-block';
  } else {
    $('#meeting-modal-title').textContent = 'Nowe spotkanie';
    $('#meeting-id').value = '';
    $('#meeting-title').value = 'Spotkanie';
    $('#meeting-date').value = date || new Date().toISOString().slice(0, 10);
    $('#meeting-delete-btn').style.display = 'none';
  }
  openModal('modal-meeting');
}

$('#form-meeting').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#meeting-id').value;
  const payload = {
    client_id: $('#meeting-client').value,
    action_name: $('#meeting-title').value.trim(),
    date: $('#meeting-date').value,
    time: $('#meeting-time').value,
    notes: $('#meeting-notes').value.trim()
  };
  try {
    if (id) {
      await api(`/activities/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Spotkanie zaktualizowane.');
    } else {
      await api('/activities', { method: 'POST', body: JSON.stringify(payload) });
      toast('Spotkanie zaplanowane.');
    }
    await refreshAll();
    renderCalendar();
    closeModal('modal-meeting');
  } catch (err) {
    toast(err.message);
  }
});

$('#meeting-delete-btn').addEventListener('click', async () => {
  const id = $('#meeting-id').value;
  if (!id || !confirm('Usunąć to spotkanie?')) return;
  try {
    await api(`/activities/${id}`, { method: 'DELETE' });
    await refreshAll();
    renderCalendar();
    closeModal('modal-meeting');
    toast('Spotkanie usunięte.');
  } catch (err) {
    toast(err.message);
  }
});

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

bootstrap();
