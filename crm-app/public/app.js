const STAGE_COLORS = {};
let STAGES = [];
let clients = [];
let activities = [];
let currentAccount = null;
let currentProfile = null;

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function initials2(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || (parts[0] || '')[1] || '');
}

function marketLabel(rynek) {
  return rynek === 'wtorny' ? 'Rynek Wtórny' : 'Rynek Pierwotny';
}

async function bootstrap() {
  try {
    const res = await fetch('/api/session');
    if (res.ok) {
      const data = await res.json();
      currentAccount = data.account;
      if (data.profile) {
        currentProfile = data.profile;
        showApp();
        return;
      }
      showAuthScreen('profile-picker');
      loadProfilePicker();
      return;
    }
  } catch (e) { /* fall through to account login */ }
  showAuthScreen('account-login');
}

const AUTH_STATES = ['account-login', 'account-register', 'profile-picker', 'profile-create'];
function showAuthScreen(state) {
  $('#app-root').style.display = 'none';
  $('#auth-screen').style.display = 'flex';
  AUTH_STATES.forEach(s => { $(`#${s}`).style.display = s === state ? 'block' : 'none'; });
}

async function showApp() {
  $('#auth-screen').style.display = 'none';
  $('#app-root').style.display = 'flex';
  $('#sidebar-current-user').textContent = `${currentProfile.pseudonim} · ${marketLabel(currentProfile.rynek)}`;
  await init();
}

async function loadProfilePicker() {
  const grid = $('#profile-grid');
  grid.innerHTML = '<div class="profile-empty">Wczytywanie profili...</div>';
  try {
    const profiles = await (await fetch('/api/profiles')).json();
    if (!profiles.length) {
      grid.innerHTML = '<div class="profile-empty">Brak profili na tym koncie. Stwórz pierwszy, aby zacząć.</div>';
      return;
    }
    grid.innerHTML = profiles.map(p => `
      <div class="profile-tile" data-id="${p.id}">
        <div class="avatar" style="--stage-color:var(--gold); width:34px;height:34px;font-size:13px;">${escapeHtml(initials2(p.pseudonim))}</div>
        <div class="profile-tile-name">${escapeHtml(p.pseudonim)}</div>
      </div>
    `).join('');
    $$('.profile-tile').forEach(tile => tile.addEventListener('click', () => selectProfile(tile.dataset.id)));
  } catch (e) {
    grid.innerHTML = '<div class="profile-empty">Nie udało się wczytać profili.</div>';
  }
}

async function selectProfile(id) {
  try {
    const res = await fetch(`/api/profiles/${id}/select`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nie udało się wybrać profilu.');
    currentProfile = data;
    showApp();
  } catch (err) {
    toast(err.message);
  }
}

$('#btn-show-acc-register').addEventListener('click', () => showAuthScreen('account-register'));
$('#btn-show-acc-login').addEventListener('click', () => showAuthScreen('account-login'));

$('#form-account-login').addEventListener('submit', async e => {
  e.preventDefault();
  $('#acc-login-error').textContent = '';
  try {
    const res = await fetch('/api/account/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mail: $('#acc-login-mail').value.trim(),
        password: $('#acc-login-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nie udało się zalogować.');
    currentAccount = data;
    showAuthScreen('profile-picker');
    loadProfilePicker();
  } catch (err) {
    $('#acc-login-error').textContent = err.message;
  }
});

$('#form-account-register').addEventListener('submit', async e => {
  e.preventDefault();
  $('#acc-reg-error').textContent = '';
  try {
    const res = await fetch('/api/account/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mail: $('#acc-reg-mail').value.trim(),
        password: $('#acc-reg-password').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nie udało się stworzyć konta.');
    currentAccount = data;
    showAuthScreen('profile-create');
    $('#form-profile-create').reset();
    $('#profile-create-error').textContent = '';
  } catch (err) {
    $('#acc-reg-error').textContent = err.message;
  }
});

$('#btn-account-logout').addEventListener('click', () => doLogout());

$('#btn-show-profile-create').addEventListener('click', () => {
  showAuthScreen('profile-create');
  $('#form-profile-create').reset();
  $('#profile-create-error').textContent = '';
});
$('#btn-back-from-profile-create').addEventListener('click', () => {
  showAuthScreen('profile-picker');
  loadProfilePicker();
});

$('#form-profile-create').addEventListener('submit', async e => {
  e.preventDefault();
  $('#profile-create-error').textContent = '';
  try {
    const res = await fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imie_nazwisko: $('#prof-name').value.trim(),
        pseudonim: $('#prof-pseudonim').value.trim(),
        rynek: $('input[name="prof-rynek"]:checked').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Nie udało się stworzyć profilu.');
    currentProfile = data;
    showApp();
  } catch (err) {
    $('#profile-create-error').textContent = err.message;
  }
});

$('#btn-switch-profile').addEventListener('click', () => {
  currentProfile = null;
  clients = [];
  activities = [];
  resetToDealsView();
  showAuthScreen('profile-picker');
  loadProfilePicker();
});

$('#btn-logout').addEventListener('click', () => doLogout());

async function doLogout() {
  try { await fetch('/api/account/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  currentAccount = null;
  currentProfile = null;
  clients = [];
  activities = [];
  resetToDealsView();
  showAuthScreen('account-login');
}

function resetToDealsView() {
  $$('.nav-item').forEach(b => b.classList.remove('active'));
  $('.nav-item[data-view="deals"]').classList.add('active');
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view-deals').classList.add('active');
}

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
    if (view === 'settings') renderSettingsView();
    if (view === 'statistics') renderStatisticsView();
  });
});

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (res.status === 401) {
    currentAccount = null;
    currentProfile = null;
    showAuthScreen('account-login');
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
  if (!currentProfile) return;
  $('#profile-avatar').textContent = initials2(currentProfile.pseudonim).toUpperCase();
  $('#profile-full-name').textContent = currentProfile.imie_nazwisko;
  $('#profile-pseudonim').textContent = currentProfile.pseudonim;
  $('#profile-rynek').textContent = marketLabel(currentProfile.rynek);
  $('#profile-mail').textContent = currentAccount ? currentAccount.mail : '—';
}

function renderStatisticsView() {
  const split = (currentProfile && currentProfile.prowizja_agenta) || 50;
  const wonDeals = clients.filter(c => c.deal_status === 'won' && c.cena_nieruchomosci && c.prowizja_procent);

  let sumAgentGross = 0, sumCommissionAmount = 0, sumTax = 0, sumNet = 0;
  wonDeals.forEach(c => {
    const com = computeCommission(c.cena_nieruchomosci, c.prowizja_procent, split);
    sumAgentGross += com.agentGross;
    sumCommissionAmount += com.commissionAmount;
    sumTax += com.tax;
    sumNet += com.net;
  });
  const avgNet = wonDeals.length ? sumNet / wonDeals.length : 0;

  $('#stat-agent-sum').textContent = formatMoney(sumAgentGross);
  $('#stat-revenue-sum').textContent = formatMoney(sumCommissionAmount);
  $('#stat-tax-sum').textContent = formatMoney(sumTax);
  $('#stat-avg-net').textContent = formatMoney(avgNet);
  $('#stats-count').textContent = wonDeals.length
    ? `Na podstawie ${wonDeals.length} udanych transakcji z uzupełnioną ceną i prowizją.`
    : 'Brak udanych transakcji z uzupełnioną ceną nieruchomości i prowizją.';
}

async function renderSettingsView() {
  if (!currentProfile) return;
  if (typeof applySplitToForm === 'function') applySplitToForm();
  else $('#settings-split').value = String(currentProfile.prowizja_agenta || 50);

  try {
    const status = await (await fetch('/api/system/status')).json();
    $('#persistence-banner').style.display = status.persistent ? 'none' : 'block';
  } catch (e) { /* ignore */ }
}

$('#btn-save-split').addEventListener('click', async () => {
  try {
    const data = await api('/profiles/me/settings', {
      method: 'PUT',
      body: JSON.stringify({ prowizja_agenta: $('#settings-split').value })
    });
    currentProfile = data;
    toast('Podział prowizji zapisany.');
  } catch (err) {
    toast(err.message);
  }
});

$('#btn-export-backup').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/backup/export');
    if (!res.ok) throw new Error('Nie udało się pobrać kopii zapasowej.');
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mini-crm-kopia-${currentProfile.pseudonim}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Kopia zapasowa pobrana.');
  } catch (err) {
    toast(err.message);
  }
});

$('#import-backup-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const result = await api('/backup/import', { method: 'POST', body: JSON.stringify(parsed) });
    await refreshAll();
    renderBoard();
    toast(`Przywrócono ${result.imported_clients} klientów i ${result.imported_activities} akcji.`);
  } catch (err) {
    toast('Nie udało się wczytać pliku: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

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

function formatMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' zł';
}

function computeCommission(price, commissionPct, splitPct) {
  const commissionAmount = price * (commissionPct / 100);
  const agentGross = commissionAmount * (splitPct / 100);
  const tax = agentGross * 0.15;
  const net = agentGross - tax;
  return { commissionAmount, agentGross, tax, net };
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

function renderBoard() {
  const board = $('#board');
  const openClients = clients.filter(c => !c.deal_status);
  board.innerHTML = STAGES.map((stage, i) => {
    const stageClients = openClients.filter(c => c.stage === stage);
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
      if (e.target.closest('button')) return;
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

$('#subtab-board').addEventListener('click', () => {
  $('#subtab-board').classList.add('active');
  $('#subtab-closed').classList.remove('active');
  $('#board').style.display = 'flex';
  $('#closed-deals-panel').style.display = 'none';
  $('#deals-subtitle').textContent = 'Przeciągnij kartę, aby zmienić etap klienta';
  $('#btn-new-lead').style.display = 'inline-block';
});
$('#subtab-closed').addEventListener('click', () => {
  $('#subtab-board').classList.remove('active');
  $('#subtab-closed').classList.add('active');
  $('#board').style.display = 'none';
  $('#closed-deals-panel').style.display = 'block';
  $('#deals-subtitle').textContent = 'Transakcje zamknięte jako Udana lub Nie udana';
  $('#btn-new-lead').style.display = 'none';
  renderClosedDeals();
});

function renderClosedDeals() {
  const won = clients.filter(c => c.deal_status === 'won');
  const lost = clients.filter(c => c.deal_status === 'lost');

  $('#closed-won-count').textContent = won.length;
  $('#closed-lost-count').textContent = lost.length;

  $('#closed-won-list').innerHTML = won.length ? won.map(c => `
    <div class="closed-card" data-id="${c.id}">
      <div class="closed-card-name">${escapeHtml(c.imie)} ${escapeHtml(c.nazwisko)}</div>
      <div class="closed-card-meta">${escapeHtml(c.telefon || 'brak telefonu')}</div>
    </div>
  `).join('') : '<div class="closed-zone-empty">Brak udanych transakcji</div>';

  $('#closed-lost-list').innerHTML = lost.length ? lost.map(c => `
    <div class="closed-card" data-id="${c.id}">
      <div class="closed-card-name">${escapeHtml(c.imie)} ${escapeHtml(c.nazwisko)}</div>
      <div class="closed-card-meta">${escapeHtml(c.telefon || 'brak telefonu')}</div>
      <button class="btn-small btn-return-to-pipeline" data-id="${c.id}">Wróć do lejka Deals</button>
    </div>
  `).join('') : '<div class="closed-zone-empty">Brak nieudanych transakcji</div>';

  $$('#closed-won-list .closed-card, #closed-lost-list .closed-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      openClientViewModal(card.dataset.id);
    });
  });
  $$('.btn-return-to-pipeline').forEach(btn => btn.addEventListener('click', async e => {
    e.stopPropagation();
    try {
      await api(`/clients/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify({ deal_status: null }) });
      await refreshAll();
      renderClosedDeals();
      renderBoard();
      toast('Klient wrócił do lejka Deals.');
    } catch (err) {
      toast(err.message);
    }
  }));
}

async function closeDeal(id, status) {
  try {
    await api(`/clients/${id}`, { method: 'PUT', body: JSON.stringify({ deal_status: status }) });
    await refreshAll();
    renderBoard();
    closeModal('modal-client-view');
    toast(status === 'won' ? 'Transakcja oznaczona jako Udana.' : 'Transakcja oznaczona jako Nie udana.');
  } catch (err) {
    toast(err.message);
  }
}

function openClientViewModal(id) {
  window.__clientViewId = id;
  const c = clients.find(x => x.id === id);
  if (!c) return;

  const clientActivities = activities
    .filter(a => a.client_id === id)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const split = (currentProfile && currentProfile.prowizja_agenta) || 50;
  const hasCommissionData = c.cena_nieruchomosci && c.prowizja_procent;
  const commission = hasCommissionData ? computeCommission(c.cena_nieruchomosci, c.prowizja_procent, split) : null;

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
      <div>
        <div class="client-view-label">Inwestycja</div>
        <div class="client-view-value">${escapeHtml(c.inwestycja) || '—'}</div>
      </div>
      <div>
        <div class="client-view-label">Dodano</div>
        <div class="client-view-value">${new Date(c.created_at).toLocaleDateString('pl-PL')}</div>
      </div>
      <div class="full">
        <div class="client-view-label">Preferencje</div>
        <div class="client-view-value">${escapeHtml(c.preferencje) || '—'}</div>
      </div>
    </div>
    ${commission ? `
      <div class="client-view-section-title">Prowizja</div>
      <div class="commission-box">
        <div class="commission-row"><span>Cena nieruchomości</span><span>${formatMoney(c.cena_nieruchomosci)}</span></div>
        <div class="commission-row"><span>Prowizja agencji (${c.prowizja_procent}%)</span><span>${formatMoney(commission.commissionAmount)}</span></div>
        <div class="commission-row"><span>Udział agenta (${split}%, ustawienia)</span><span>${formatMoney(commission.agentGross)}</span></div>
        <div class="commission-row"><span>Podatek (15%)</span><span>-${formatMoney(commission.tax)}</span></div>
        <div class="commission-row final"><span>Do wypłaty</span><span>${formatMoney(commission.net)}</span></div>
      </div>
    ` : ''}
    <div class="client-view-section-title">Zamknij transakcję</div>
    ${c.deal_status ? `
      <span class="deal-status-pill ${c.deal_status}">${c.deal_status === 'won' ? '✅ Udana' : '❌ Nie udana'}</span>
    ` : `
      <div class="close-deal-buttons">
        <button class="btn btn-ghost" id="close-deal-won-btn">✅ Udana</button>
        <button class="btn btn-ghost" id="close-deal-lost-btn">❌ Nie udana</button>
      </div>
    `}
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

  const wonBtn = $('#close-deal-won-btn');
  const lostBtn = $('#close-deal-lost-btn');
  if (wonBtn) wonBtn.addEventListener('click', () => closeDeal(id, 'won'));
  if (lostBtn) lostBtn.addEventListener('click', () => closeDeal(id, 'lost'));

  const deleteBtn = $('#client-view-delete-btn');
  if (c.deal_status) {
    deleteBtn.style.display = 'flex';
    deleteBtn.onclick = async () => {
      if (!confirm('Usunąć tę zamkniętą transakcję na stałe? Tej operacji nie można cofnąć.')) return;
      try {
        await api(`/clients/${id}`, { method: 'DELETE' });
        await refreshAll();
        renderClosedDeals();
        renderBoard();
        closeModal('modal-client-view');
        toast('Zamknięta transakcja usunięta.');
      } catch (err) {
        toast(err.message);
      }
    };
  } else {
    deleteBtn.style.display = 'none';
    deleteBtn.onclick = null;
  }

  openModal('modal-client-view');
}

function renderContacts() {
  const body = $('#contacts-body');
  if (!clients.length) {
    body.innerHTML = `<tr><td colspan="9"><div class="empty-state">Brak kontaktów. Dodaj pierwszy lead w zakładce Deals.</div></td></tr>`;
    return;
  }
  body.innerHTML = clients.map(c => `
    <tr>
      <td>${escapeHtml(c.imie)}</td>
      <td>${escapeHtml(c.nazwisko)}</td>
      <td>${escapeHtml(c.mail) || '—'}</td>
      <td>${escapeHtml(c.telefon) || '—'}</td>
      <td>${escapeHtml(c.inwestycja) || '—'}</td>
      <td>${(() => {
        if (!c.cena_nieruchomosci || !c.prowizja_procent) return '—';
        const split = (currentProfile && currentProfile.prowizja_agenta) || 50;
        return formatMoney(computeCommission(c.cena_nieruchomosci, c.prowizja_procent, split).net);
      })()}</td>
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

const MONTHS_PL = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];
let calYear, calMonth;

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
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();

  const todayStr = dateStr(new Date().getFullYear(), new Date().getMonth(), new Date().getDate());

  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    const d = daysInPrevMonth - startOffset + i + 1;
    const prevMonthDate = new Date(calYear, calMonth - 1, d);
    cells.push({ d, ds: dateStr(prevMonthDate.getFullYear(), prevMonthDate.getMonth(), d), outside: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ d, ds: dateStr(calYear, calMonth, d), outside: false });
  }
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
        openMeetingViewModal(chip.dataset.activityId);
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

function openMeetingViewModal(activityId) {
  const a = activities.find(x => x.id === activityId);
  if (!a) return;
  const client = clients.find(c => c.id === a.client_id);

  const body = $('#meeting-view-body');
  body.innerHTML = `
    <div class="client-view-grid">
      <div class="full">
        <div class="client-view-label">Klient</div>
        <div class="client-view-value">${escapeHtml(a.client_name || (client ? `${client.imie} ${client.nazwisko}` : '—'))}</div>
      </div>
      <div class="full">
        <div class="client-view-label">Nazwa spotkania / akcji</div>
        <div class="client-view-value">${escapeHtml(a.action_name)}</div>
      </div>
      <div>
        <div class="client-view-label">Data</div>
        <div class="client-view-value">${new Date(a.date + 'T00:00:00').toLocaleDateString('pl-PL')}</div>
      </div>
      <div>
        <div class="client-view-label">Godzina</div>
        <div class="client-view-value">${escapeHtml(a.time) || '—'}</div>
      </div>
      <div class="full">
        <div class="client-view-label">Status</div>
        <div class="client-view-value">${a.done ? 'Wykonane' : 'Zaplanowane'}</div>
      </div>
      <div class="full">
        <div class="client-view-label">Notatki</div>
        <div class="client-view-value">${escapeHtml(a.notes) || '—'}</div>
      </div>
    </div>
  `;

  $('#meeting-view-delete-btn').onclick = async () => {
    if (!confirm('Usunąć to spotkanie?')) return;
    try {
      await api(`/activities/${activityId}`, { method: 'DELETE' });
      await refreshAll();
      renderCalendar();
      closeModal('modal-meeting-view');
      toast('Spotkanie usunięte.');
    } catch (err) {
      toast(err.message);
    }
  };

  openModal('modal-meeting-view');
}

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
    $('#lead-inwestycja').value = c.inwestycja || '';
    $('#lead-cena').value = c.cena_nieruchomosci ?? '';
    $('#lead-prowizja-procent').value = c.prowizja_procent ?? '';
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
    inwestycja: $('#lead-inwestycja').value.trim(),
    cena_nieruchomosci: $('#lead-cena').value,
    prowizja_procent: $('#lead-prowizja-procent').value,
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


// ---------------------------------------------------------------------
// FAST RESEARCH (premium) + ADMIN PANEL
// ---------------------------------------------------------------------
let currentIsAdmin = false;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function refreshAdminFlag() {
  try {
    const res = await fetch('/api/session');
    if (!res.ok) return;
    const data = await res.json();
    currentIsAdmin = Boolean(data.isAdmin);
    const btn = $('#btn-nav-admin');
    if (btn) btn.style.display = currentIsAdmin ? 'flex' : 'none';
  } catch (e) { /* ignore */ }
}

async function loadAdminLinks() {
  const list = $('#admin-links-list');
  if (!list) return;
  try {
    const links = await api('/admin/developer-links');
    list.innerHTML = links.length ? links.map(l => `
      <div class="admin-list-item" data-id="${l.id}">
        <div>
          <div class="name">${escapeHtml(l.label || 'Bez nazwy')}</div>
          <div class="url">${escapeHtml(l.url)}</div>
        </div>
        <button class="btn-small btn-danger btn-delete-link" data-id="${l.id}">Usuń</button>
      </div>
    `).join('') : '<div class="admin-list-empty">Brak dodanych linków.</div>';
    $$('.btn-delete-link').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await api(`/admin/developer-links/${btn.dataset.id}`, { method: 'DELETE' });
        loadAdminLinks();
        toast('Link usunięty.');
      } catch (err) { toast(err.message); }
    }));
  } catch (err) {
    list.innerHTML = '<div class="admin-list-empty">Nie udało się wczytać linków.</div>';
  }
}

async function loadAdminPdfs() {
  const list = $('#admin-pdfs-list');
  if (!list) return;
  try {
    const pdfs = await api('/admin/investment-pdfs');
    list.innerHTML = pdfs.length ? pdfs.map(p => `
      <div class="admin-list-item" data-id="${p.id}">
        <div>
          <div class="name">${escapeHtml(p.filename)}</div>
          <div class="url">${p.chars.toLocaleString('pl-PL')} znaków tekstu · dodano ${new Date(p.created_at).toLocaleDateString('pl-PL')}</div>
        </div>
        <button class="btn-small btn-danger btn-delete-pdf" data-id="${p.id}">Usuń</button>
      </div>
    `).join('') : '<div class="admin-list-empty">Brak wgranych plików PDF.</div>';
    $$('.btn-delete-pdf').forEach(btn => btn.addEventListener('click', async () => {
      try {
        await api(`/admin/investment-pdfs/${btn.dataset.id}`, { method: 'DELETE' });
        loadAdminPdfs();
        toast('Plik PDF usunięty.');
      } catch (err) { toast(err.message); }
    }));
  } catch (err) {
    list.innerHTML = '<div class="admin-list-empty">Nie udało się wczytać plików.</div>';
  }
}


const researchClientSelect = $('#research-client-select');
if (researchClientSelect) researchClientSelect.addEventListener('change', () => {
  const chosen = clients.find(c => c.id === researchClientSelect.value);
  const prefBox = $('#research-preferences');
  if (prefBox && chosen && chosen.preferencje) {
    prefBox.value = chosen.preferencje;
  }
});


(function protectDataEntryModals() {
  const PROTECTED_MODALS = ['modal-lead', 'modal-action', 'modal-meeting'];
  PROTECTED_MODALS.forEach(id => {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) {
        e.stopImmediatePropagation();
      }
    }, true);
  });
})();


function dealMonthOf(c) {
  if (Number(c.deal_month)) return Number(c.deal_month);
  if (c.closed_at) return new Date(c.closed_at).getMonth() + 1;
  return null;
}

function splitOf(c) {
  return Number(c.deal_split) || (currentProfile && currentProfile.prowizja_agenta) || 50;
}

function inSelectedPeriod(c, monthGetter) {
  const periodEl = $('#stats-period');
  const period = periodEl ? periodEl.value : 'all';
  if (period === 'all' || period === 'year') return true;
  const m = monthGetter(c);
  if (!m) return false;
  if (period === 'month') return m === Number($('#stats-month').value);
  if (period === 'quarter') return Math.ceil(m / 3) === Number($('#stats-quarter').value);
  return true;
}

function renderStatsChart(wonAll) {
  const wrap = $('#stats-chart');
  if (!wrap) return;
  const wonPerMonth = new Array(12).fill(0);
  const leadsPerMonth = new Array(12).fill(0);
  wonAll.forEach(c => {
    const m = dealMonthOf(c);
    if (m) wonPerMonth[m - 1]++;
  });
  clients.forEach(c => {
    if (!c.created_at) return;
    leadsPerMonth[new Date(c.created_at).getMonth()]++;
  });
  const maxWon = Math.max(1, ...wonPerMonth);
  const periodEl = $('#stats-period');
  const selectedMonth = (periodEl && periodEl.value === 'month') ? Number($('#stats-month').value) : null;
  wrap.innerHTML = MONTHS_PL.map((name, i) => {
    const won = wonPerMonth[i];
    const leads = leadsPerMonth[i];
    const conv = leads ? Math.round((won / leads) * 100) : 0;
    const h = won ? Math.max(Math.round((won / maxWon) * 100), 4) : 0;
    const active = selectedMonth === i + 1;
    return '<div class="chart-col ' + (active ? 'active' : '') + '" title="' + name + ': ' + won + ' udanych z ' + leads + ' leadow"><div class="chart-bar-value">' + won + '</div><div class="chart-bar-track"><div class="chart-bar-fill" style="height:' + h + '%"></div></div><div class="chart-col-label">' + name.slice(0, 3) + '</div><div class="chart-col-conv">' + (leads ? conv + '%' : '-') + '</div></div>';
  }).join('');
}

function renderStatisticsView() {
  const monthSel = $('#stats-month');
  if (monthSel && !monthSel.options.length) {
    monthSel.innerHTML = MONTHS_PL.map((m, i) => '<option value="' + (i + 1) + '">' + m + '</option>').join('');
    monthSel.value = String(new Date().getMonth() + 1);
  }
  const periodEl = $('#stats-period');
  const period = periodEl ? periodEl.value : 'all';
  if ($('#stats-month-wrap')) $('#stats-month-wrap').style.display = period === 'month' ? 'flex' : 'none';
  if ($('#stats-quarter-wrap')) $('#stats-quarter-wrap').style.display = period === 'quarter' ? 'flex' : 'none';
  const wonAll = clients.filter(c => c.deal_status === 'won');
  const wonInPeriod = wonAll.filter(c => inSelectedPeriod(c, dealMonthOf));
  const wonMoney = wonInPeriod.filter(c => c.cena_nieruchomosci && c.prowizja_procent);
  let sumG = 0, sumC = 0, sumT = 0, sumN = 0;
  wonMoney.forEach(c => {
    const com = computeCommission(c.cena_nieruchomosci, c.prowizja_procent, splitOf(c));
    sumG += com.agentGross; sumC += com.commissionAmount; sumT += com.tax; sumN += com.net;
  });
  $('#stat-agent-sum').textContent = formatMoney(sumG);
  $('#stat-revenue-sum').textContent = formatMoney(sumC);
  $('#stat-tax-sum').textContent = formatMoney(sumT);
  $('#stat-avg-net').textContent = formatMoney(wonMoney.length ? sumN / wonMoney.length : 0);
  const leadMonth = c => (c.created_at ? new Date(c.created_at).getMonth() + 1 : null);
  const leadsInPeriod = clients.filter(c => inSelectedPeriod(c, leadMonth));
  const conv = leadsInPeriod.length ? (wonInPeriod.length / leadsInPeriod.length) * 100 : 0;
  if ($('#stat-conversion')) $('#stat-conversion').textContent = leadsInPeriod.length ? conv.toFixed(1) + '%' : '-';
  if ($('#stat-won-count')) $('#stat-won-count').textContent = String(wonInPeriod.length);
  const timed = wonInPeriod.filter(c => c.created_at && c.closed_at);
  const avgDays = timed.length ? timed.reduce((a, c) => a + (new Date(c.closed_at) - new Date(c.created_at)), 0) / timed.length / 86400000 : null;
  if ($('#stat-avg-days')) $('#stat-avg-days').textContent = avgDays === null ? '-' : avgDays.toFixed(1) + ' dni';
  $('#stats-count').textContent = wonMoney.length ? 'Na podstawie ' + wonMoney.length + ' udanych transakcji z cena i prowizja (' + wonInPeriod.length + ' udanych w okresie, ' + leadsInPeriod.length + ' leadow).' : 'Brak udanych transakcji z cena i prowizja w wybranym okresie.';
  renderStatsChart(wonAll);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

function renderStageSettings() {
  const box = $('#settings-stages-list');
  if (!box) return;
  const list = (currentProfile && Array.isArray(currentProfile.stages) && currentProfile.stages.length) ? currentProfile.stages : STAGES;
  box.innerHTML = list.map((name, i) => '<div class="field"><label for="stage-name-' + i + '">Etap ' + (i + 1) + '</label><input type="text" id="stage-name-' + i + '" class="stage-name-input" value="' + escapeHtml(name) + '" /></div>').join('');
}

async function renderSettingsView() {
  if (!currentProfile) return;
  $('#settings-split').value = String(currentProfile.prowizja_agenta || 50);
  if ($('#settings-theme')) $('#settings-theme').value = currentProfile.theme || 'light';
  renderStageSettings();
  try {
    const status = await (await fetch('/api/system/status')).json();
    $('#persistence-banner').style.display = status.persistent ? 'none' : 'block';
  } catch (e) { }
}

['#stats-period', '#stats-month', '#stats-quarter'].forEach(sel => {
  const el = $(sel);
  if (el) el.addEventListener('change', () => renderStatisticsView());
});

const themeBtnNew = $('#btn-save-theme');
if (themeBtnNew) themeBtnNew.addEventListener('click', async () => {
  const theme = $('#settings-theme').value;
  try {
    const data = await api('/profiles/me/settings', { method: 'PUT', body: JSON.stringify({ theme: theme }) });
    currentProfile = data;
    applyTheme(theme);
    toast('Styl strony zapisany.');
  } catch (err) { toast(err.message); }
});

const stagesBtnNew = $('#btn-save-stages');
if (stagesBtnNew) stagesBtnNew.addEventListener('click', async () => {
  const stages = $$('.stage-name-input').map(i => i.value.trim());
  if (stages.some(v => !v)) { toast('Nazwy etapow nie moga byc puste.'); return; }
  try {
    const data = await api('/profiles/me/settings', { method: 'PUT', body: JSON.stringify({ stages: stages }) });
    currentProfile = data;
    STAGES = data.stages;
    Object.keys(STAGE_COLORS).forEach(k => delete STAGE_COLORS[k]);
    STAGES.forEach((st, i) => { STAGE_COLORS[st] = 'var(--stage-' + (i + 1) + ')'; });
    const sel = $('#lead-stage');
    if (sel) sel.innerHTML = STAGES.map(st => '<option value="' + escapeHtml(st) + '">' + escapeHtml(st) + '</option>').join('');
    await refreshAll();
    renderBoard();
    renderStageSettings();
    toast('Nazwy etapow zapisane.');
  } catch (err) { toast(err.message); }
});

const snapBtnNew = $('#btn-load-snapshots');
if (snapBtnNew) snapBtnNew.addEventListener('click', async () => {
  const list = $('#snapshots-list');
  list.innerHTML = '<div class="admin-list-empty">Wczytywanie...</div>';
  try {
    const snaps = await api('/backup/snapshots');
    list.innerHTML = snaps.length ? snaps.map(sn => '<div class="admin-list-item"><div><div class="name">' + new Date(sn.created_at).toLocaleString('pl-PL') + '</div><div class="url">' + escapeHtml(sn.file) + '</div></div><button class="btn-restore-snap" data-file="' + escapeHtml(sn.file) + '">Przywroc</button></div>').join('') : '<div class="admin-list-empty">Brak zapisanych kopii.</div>';
    $$('.btn-restore-snap').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Przywrocic dane tego profilu z wybranej kopii?')) return;
      try {
        const r = await api('/backup/snapshots/' + encodeURIComponent(b.dataset.file) + '/restore', { method: 'POST' });
        await refreshAll();
        renderBoard();
        toast('Przywrocono ' + r.restored_clients + ' klientow i ' + r.restored_activities + ' akcji.');
      } catch (err) { toast(err.message); }
    }));
  } catch (err) {
    list.innerHTML = '<div class="admin-list-empty">Nie udalo sie wczytac kopii.</div>';
  }
});

const origOpenClientViewModal = openClientViewModal;
openClientViewModal = function (id) {
  origOpenClientViewModal(id);
  const c = clients.find(x => x.id === id);
  if (!c || !c.deal_status) return;
  const body = $('#client-view-body');
  if (!body || body.querySelector('#deal-month-select')) return;
  const pill = body.querySelector('.deal-status-pill');
  if (!pill) return;
  const box = document.createElement('div');
  box.className = 'closed-deal-settings';
  box.innerHTML = '<div class="field"><label for="deal-month-select">Miesiac transakcji</label><select id="deal-month-select">' + MONTHS_PL.map((m, i) => '<option value="' + (i + 1) + '"' + (Number(c.deal_month) === i + 1 ? ' selected' : '') + '>' + m + '</option>').join('') + '</select></div><div class="field"><label for="deal-split-select">Podzial prowizji agenta</label><select id="deal-split-select">' + [45, 50, 55, 60].map(v => '<option value="' + v + '"' + (splitOf(c) === v ? ' selected' : '') + '>' + v + '%</option>').join('') + '</select></div><button type="button" class="btn btn-primary" id="btn-save-deal-details">Zapisz</button>';
  pill.parentNode.insertBefore(box, pill.nextSibling);
  $('#btn-save-deal-details').addEventListener('click', async () => {
    try {
      await api('/clients/' + id, { method: 'PUT', body: JSON.stringify({ deal_month: Number($('#deal-month-select').value), deal_split: Number($('#deal-split-select').value) }) });
      await refreshAll();
      renderClosedDeals();
      closeModal('modal-client-view');
      openClientViewModal(id);
      toast('Zapisano dane transakcji.');
    } catch (err) { toast(err.message); }
  });
};

const origShowAppFn = showApp;
showApp = async function () {
  await origShowAppFn();
  if (currentProfile) applyTheme(currentProfile.theme || 'light');
};


(function () {
  const oldBtn = document.getElementById('btn-load-snapshots');
  if (!oldBtn) return;
  const btn = oldBtn.cloneNode(true);
  btn.textContent = 'Pokaz dostepne kopie';
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.addEventListener('click', async () => {
    const list = document.getElementById('snapshots-list');
    if (!list) return;
    if (list.dataset.open === '1') {
      list.innerHTML = '';
      list.dataset.open = '0';
      btn.textContent = 'Pokaz dostepne kopie';
      return;
    }
    list.dataset.open = '1';
    btn.textContent = 'Ukryj kopie';
    list.innerHTML = '<div class="admin-list-empty">Wczytywanie...</div>';
    try {
      const snaps = await api('/backup/snapshots');
      list.innerHTML = snaps.length ? snaps.map(sn => '<div class="admin-list-item"><div><div class="name">' + new Date(sn.created_at).toLocaleString('pl-PL') + '</div><div class="url">' + escapeHtml(sn.file) + '</div></div><button class="btn-restore-snap" data-file="' + escapeHtml(sn.file) + '">Przywroc</button></div>').join('') : '<div class="admin-list-empty">Brak kopii. Pierwsza kopia powstanie automatycznie o polnocy.</div>';
      $$('.btn-restore-snap').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Przywrocic dane tego profilu z wybranej kopii?')) return;
        try {
          const r = await api('/backup/snapshots/' + encodeURIComponent(b.dataset.file) + '/restore', { method: 'POST' });
          await refreshAll();
          renderBoard();
          toast('Przywrocono ' + r.restored_clients + ' klientow i ' + r.restored_activities + ' akcji.');
        } catch (err) { toast(err.message); }
      }));
    } catch (err) {
      list.innerHTML = '<div class="admin-list-empty">Nie udalo sie wczytac kopii.</div>';
    }
  });
})();


let plannerTasks = [];
let plannerScope = 'daily';
let plannerMode = 'calendar';
let plannerDate = new Date();
const WD_SHORT = ['Nd','Pn','Wt','Sr','Cz','Pt','Sb'];

function isoDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function taskOccursOn(t, dateStr) {
  if (t.recurrence === 'daily') return true;
  if (t.recurrence === 'weekly') return (t.weekdays || []).includes(new Date(dateStr + 'T00:00:00').getDay());
  return t.date === dateStr;
}

function isTaskDone(t, dateStr) {
  if (t.recurrence === 'none') return Boolean(t.done);
  return (t.done_dates || []).includes(dateStr);
}

async function toggleTaskDone(t, dateStr) {
  try {
    if (t.recurrence === 'none') {
      await api('/planner/' + t.id, { method: 'PUT', body: JSON.stringify({ done: !t.done }) });
    } else {
      const list = new Set(t.done_dates || []);
      if (list.has(dateStr)) list.delete(dateStr); else list.add(dateStr);
      await api('/planner/' + t.id, { method: 'PUT', body: JSON.stringify({ done_dates: Array.from(list) }) });
    }
    await loadPlanner();
  } catch (err) { toast(err.message); }
}

async function loadPlanner() {
  try { plannerTasks = await api('/planner'); } catch (err) { plannerTasks = []; }
  renderPlanner();
}

function renderPlanner() {
  const cal = $('#planner-calendar');
  const list = $('#planner-list');
  const daynav = $('#planner-daynav');
  if (!cal || !list) return;
  const showDayNav = plannerScope === 'daily' && plannerMode === 'calendar';
  if (daynav) daynav.style.display = showDayNav ? 'flex' : 'none';
  cal.style.display = plannerMode === 'calendar' ? 'block' : 'none';
  list.style.display = plannerMode === 'list' ? 'block' : 'none';
  if (plannerMode === 'calendar') renderPlannerCalendar(); else renderPlannerList();
}

function renderPlannerCalendar() {
  const cal = $('#planner-calendar');
  const scoped = plannerTasks.filter(t => t.scope === plannerScope);
  if (plannerScope !== 'daily') {
    cal.innerHTML = scoped.length ? '<div class="goal-grid">' + scoped.map(t => '<div class="goal-card ' + (t.done ? 'done' : '') + '"><label class="goal-check"><input type="checkbox" class="task-check" data-id="' + t.id + '" ' + (t.done ? 'checked' : '') + ' /><span class="goal-title">' + escapeHtml(t.title) + '</span></label>' + (t.notes ? '<div class="goal-notes">' + escapeHtml(t.notes) + '</div>' : '') + '<button class="btn-small task-edit" data-id="' + t.id + '">Edytuj</button></div>').join('') + '</div>' : '<div class="admin-list-empty">Brak celow w tym zakresie.</div>';
    attachPlannerEvents(isoDate(plannerDate));
    return;
  }
  const dayStr = isoDate(plannerDate);
  $('#planner-day-label').textContent = WD_SHORT[plannerDate.getDay()] + ', ' + plannerDate.toLocaleDateString('pl-PL', { day:'numeric', month:'long', year:'numeric' });
  const todays = scoped.filter(t => taskOccursOn(t, dayStr));
  const untimed = todays.filter(t => !t.time_start);
  let html = '<div class="hour-grid">';
  for (let h = 0; h < 24; h++) {
    const hh = String(h).padStart(2,'0');
    const inHour = todays.filter(t => t.time_start && Number(t.time_start.slice(0,2)) === h);
    html += '<div class="hour-row"><div class="hour-label">' + hh + ':00</div><div class="hour-slot" data-hour="' + hh + '">' + inHour.map(t => '<div class="task-chip ' + (isTaskDone(t,dayStr)?'done':'') + '"><input type="checkbox" class="task-check" data-id="' + t.id + '" ' + (isTaskDone(t,dayStr)?'checked':'') + ' /><span class="task-chip-time">' + escapeHtml(t.time_start) + (t.time_end ? '-' + escapeHtml(t.time_end) : '') + '</span><span class="task-chip-title">' + escapeHtml(t.title) + '</span>' + (t.recurrence !== 'none' ? '<span class="task-repeat">R</span>' : '') + '<button class="task-edit" data-id="' + t.id + '">E</button></div>').join('') + '</div></div>';
  }
  html += '</div>';
  if (untimed.length) {
    html = '<div class="untimed-box"><div class="untimed-title">Bez godziny</div>' + untimed.map(t => '<div class="task-chip ' + (isTaskDone(t,dayStr)?'done':'') + '"><input type="checkbox" class="task-check" data-id="' + t.id + '" ' + (isTaskDone(t,dayStr)?'checked':'') + ' /><span class="task-chip-title">' + escapeHtml(t.title) + '</span>' + (t.recurrence !== 'none' ? '<span class="task-repeat">R</span>' : '') + '<button class="task-edit" data-id="' + t.id + '">E</button></div>').join('') + '</div>' + html;
  }
  cal.innerHTML = html;
  attachPlannerEvents(dayStr);
  $$('.hour-slot').forEach(slot => slot.addEventListener('click', e => {
    if (e.target.closest('.task-chip')) return;
    openTaskModal(null, { hour: slot.dataset.hour, date: dayStr });
  }));
}

function renderPlannerList() {
  const list = $('#planner-list');
  const scoped = plannerTasks.filter(t => t.scope === plannerScope);
  const dayStr = isoDate(plannerDate);
  if (!scoped.length) { list.innerHTML = '<div class="admin-list-empty">Brak zadan w tym zakresie.</div>'; return; }
  const sorted = scoped.slice().sort((a,b) => (a.time_start || '99').localeCompare(b.time_start || '99'));
  list.innerHTML = sorted.map(t => {
    let when = '';
    if (t.recurrence === 'daily') when = 'Codziennie';
    else if (t.recurrence === 'weekly') when = (t.weekdays || []).map(d => WD_SHORT[d]).join(', ');
    else if (t.date) when = new Date(t.date + 'T00:00:00').toLocaleDateString('pl-PL');
    const time = t.time_start ? (t.time_start + (t.time_end ? '-' + t.time_end : '')) : '';
    return '<div class="task-row ' + (isTaskDone(t,dayStr)?'done':'') + '"><input type="checkbox" class="task-check" data-id="' + t.id + '" ' + (isTaskDone(t,dayStr)?'checked':'') + ' /><div class="task-row-main"><div class="task-row-title">' + escapeHtml(t.title) + '</div><div class="task-row-meta">' + [when,time].filter(Boolean).join(' - ') + (t.notes ? ' - ' + escapeHtml(t.notes) : '') + '</div></div><button class="btn-small task-edit" data-id="' + t.id + '">Edytuj</button></div>';
  }).join('');
  attachPlannerEvents(dayStr);
}

function attachPlannerEvents(dayStr) {
  $$('.task-check').forEach(chk => chk.addEventListener('click', async e => {
    e.stopPropagation();
    const t = plannerTasks.find(x => x.id === chk.dataset.id);
    if (t) await toggleTaskDone(t, dayStr);
  }));
  $$('.task-edit').forEach(btn => btn.addEventListener('click', e => {
    e.stopPropagation();
    openTaskModal(btn.dataset.id);
  }));
}

function openTaskModal(id, preset) {
  const form = $('#form-task');
  form.reset();
  $('#task-id').value = '';
  $('#task-weekdays-wrap').style.display = 'none';
  $$('#task-weekdays input').forEach(c => { c.checked = false; });
  $('#task-delete-btn').style.display = 'none';
  if (id) {
    const t = plannerTasks.find(x => x.id === id);
    if (!t) return;
    $('#task-modal-title').textContent = 'Edytuj zadanie';
    $('#task-id').value = t.id;
    $('#task-title').value = t.title;
    $('#task-scope').value = t.scope;
    $('#task-date').value = t.date || '';
    $('#task-start').value = t.time_start || '';
    $('#task-end').value = t.time_end || '';
    $('#task-recurrence').value = t.recurrence;
    $('#task-notes').value = t.notes || '';
    (t.weekdays || []).forEach(d => { const c = $('#task-weekdays input[value="' + d + '"]'); if (c) c.checked = true; });
    $('#task-weekdays-wrap').style.display = t.recurrence === 'weekly' ? 'block' : 'none';
    $('#task-delete-btn').style.display = 'inline-block';
  } else {
    $('#task-modal-title').textContent = 'Nowe zadanie';
    $('#task-scope').value = plannerScope;
    $('#task-date').value = (preset && preset.date) || isoDate(plannerDate);
    if (preset && preset.hour) {
      $('#task-start').value = preset.hour + ':00';
      $('#task-end').value = String(Math.min(23, Number(preset.hour)+1)).padStart(2,'0') + ':00';
    }
  }
  $('#task-time-row').style.display = $('#task-scope').value === 'daily' ? 'flex' : 'none';
  openModal('modal-task');
}

$('#task-recurrence').addEventListener('change', () => {
  $('#task-weekdays-wrap').style.display = $('#task-recurrence').value === 'weekly' ? 'block' : 'none';
});
$('#task-scope').addEventListener('change', () => {
  $('#task-time-row').style.display = $('#task-scope').value === 'daily' ? 'flex' : 'none';
});

$('#form-task').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#task-id').value;
  const recurrence = $('#task-recurrence').value;
  const payload = {
    title: $('#task-title').value.trim(),
    scope: $('#task-scope').value,
    notes: $('#task-notes').value.trim(),
    recurrence: recurrence,
    weekdays: recurrence === 'weekly' ? $$('#task-weekdays input:checked').map(c => Number(c.value)) : [],
    date: recurrence === 'none' ? ($('#task-date').value || null) : null,
    time_start: $('#task-start').value || null,
    time_end: $('#task-end').value || null
  };
  try {
    if (id) await api('/planner/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/planner', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('modal-task');
    await loadPlanner();
    toast(id ? 'Zadanie zaktualizowane.' : 'Zadanie dodane.');
  } catch (err) { toast(err.message); }
});

$('#task-delete-btn').addEventListener('click', async () => {
  const id = $('#task-id').value;
  if (!id || !confirm('Usunac to zadanie?')) return;
  try {
    await api('/planner/' + id, { method: 'DELETE' });
    closeModal('modal-task');
    await loadPlanner();
    toast('Zadanie usuniete.');
  } catch (err) { toast(err.message); }
});

$('#btn-new-task').addEventListener('click', () => openTaskModal(null));

$$('.planner-scope').forEach(b => b.addEventListener('click', () => {
  $$('.planner-scope').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  plannerScope = b.dataset.scope;
  renderPlanner();
}));

$$('.planner-mode').forEach(b => b.addEventListener('click', () => {
  $$('.planner-mode').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  plannerMode = b.dataset.mode;
  renderPlanner();
}));

$('#planner-prev').addEventListener('click', () => { plannerDate.setDate(plannerDate.getDate()-1); renderPlanner(); });
$('#planner-next').addEventListener('click', () => { plannerDate.setDate(plannerDate.getDate()+1); renderPlanner(); });
$('#planner-today').addEventListener('click', () => { plannerDate = new Date(); renderPlanner(); });

$$('.nav-item').forEach(btn => {
  if (btn.dataset.view === 'planner') btn.addEventListener('click', () => loadPlanner());
});

$$('.settings-acc-head').forEach((head, i) => {
  const body = head.nextElementSibling;
  if (!body) return;
  const open = i === 0;
  body.style.display = open ? 'block' : 'none';
  head.classList.toggle('open', open);
  head.addEventListener('click', () => {
    const isOpen = body.style.display !== 'none';
    body.style.display = isOpen ? 'none' : 'block';
    head.classList.toggle('open', !isOpen);
  });
});


// ==== PRACTICE: skrypty rozmow + Straight Line ====
let practiceData = null;
let practiceType = 'coldcall';

function currentPractice() {
  return practiceData ? practiceData[practiceType] : null;
}

async function loadPractice() {
  try { practiceData = await api('/practice'); } catch (err) { toast(err.message); return; }
  renderPractice();
}

function renderPractice() {
  const p = currentPractice();
  if (!p) return;
  renderStraightLine();
  renderPracticeStages();
  $('#practice-review').innerHTML = '';
}

function renderPracticeStages() {
  const p = currentPractice();
  const box = $('#practice-stages');
  if (!box) return;
  box.innerHTML = p.stages.map(function (st, i) {
    return '<div class="script-stage"><div class="script-stage-head"><span class="script-stage-num">' + (i + 1) + '</span><input type="text" class="script-stage-title" data-i="' + i + '" value="' + escapeHtml(st.title) + '" /></div><div class="script-stage-body"><div class="script-col"><label>Skrypt rozmowy</label><textarea class="script-text" data-i="' + i + '" rows="7">' + escapeHtml(st.script) + '</textarea></div><div class="script-col script-col-prio"><label>Priorytety / kamienie milowe</label><textarea class="script-prio" data-i="' + i + '" rows="7">' + escapeHtml(st.priorities) + '</textarea></div></div></div>';
  }).join('');
}

function collectPracticeFromForm() {
  const p = currentPractice();
  $$('.script-stage-title').forEach(function (inp) { p.stages[Number(inp.dataset.i)].title = inp.value; });
  $$('.script-text').forEach(function (t) { p.stages[Number(t.dataset.i)].script = t.value; });
  $$('.script-prio').forEach(function (t) { p.stages[Number(t.dataset.i)].priorities = t.value; });
  return p;
}

function renderStraightLine() {
  const p = currentPractice();
  const pts = $('#sl-points');
  if (!pts) return;
  const n = p.lineStages.length;
  pts.innerHTML = p.lineStages.map(function (name, i) {
    const left = n === 1 ? 0 : (i / (n - 1)) * 100;
    return '<div class="sl-point ' + (i <= p.markerIndex ? 'passed' : '') + '" data-i="' + i + '" style="left:' + left + '%"><span class="sl-dot"></span><span class="sl-label">' + escapeHtml(name) + '</span></div>';
  }).join('');
  positionMarker();
  $('#sl-current').textContent = 'Jestes na etapie: ' + (p.lineStages[p.markerIndex] || '-');
  $$('.sl-point').forEach(function (pt) { pt.addEventListener('click', function () { setMarker(Number(pt.dataset.i)); }); });
}

function positionMarker() {
  const p = currentPractice();
  const marker = $('#sl-marker');
  if (!marker) return;
  const n = p.lineStages.length;
  marker.style.left = (n === 1 ? 0 : (p.markerIndex / (n - 1)) * 100) + '%';
}

async function setMarker(i, save) {
  if (save === undefined) save = true;
  const p = currentPractice();
  p.markerIndex = Math.max(0, Math.min(p.lineStages.length - 1, i));
  renderStraightLine();
  if (save) {
    try { await api('/practice', { method: 'PUT', body: JSON.stringify({ type: practiceType, markerIndex: p.markerIndex }) }); } catch (err) { }
  }
}

(function initMarkerDrag() {
  const marker = $('#sl-marker');
  const track = $('#sl-track');
  if (!marker || !track) return;
  let dragging = false;
  function moveTo(clientX) {
    const p = currentPractice();
    if (!p) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const n = p.lineStages.length;
    marker.style.left = (ratio * 100) + '%';
    return n === 1 ? 0 : Math.round(ratio * (n - 1));
  }
  function start(e) { dragging = true; marker.classList.add('dragging'); e.preventDefault(); }
  function move(e) { if (!dragging) return; moveTo(e.touches ? e.touches[0].clientX : e.clientX); }
  function end(e) {
    if (!dragging) return;
    dragging = false;
    marker.classList.remove('dragging');
    const x = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
    const idx = moveTo(x);
    if (idx !== undefined) setMarker(idx);
  }
  marker.addEventListener('mousedown', start);
  marker.addEventListener('touchstart', start, { passive: false });
  document.addEventListener('mousemove', move);
  document.addEventListener('touchmove', move, { passive: false });
  document.addEventListener('mouseup', end);
  document.addEventListener('touchend', end);
})();

$('#btn-edit-line').addEventListener('click', function () {
  const ed = $('#sl-editor');
  const open = ed.style.display !== 'none';
  ed.style.display = open ? 'none' : 'block';
  if (!open) $('#sl-input').value = currentPractice().lineStages.join(', ');
});

$('#btn-save-line').addEventListener('click', async function () {
  const raw = $('#sl-input').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!raw.length) { toast('Podaj przynajmniej jeden etap.'); return; }
  const p = currentPractice();
  try {
    const saved = await api('/practice', { method: 'PUT', body: JSON.stringify({ type: practiceType, lineStages: raw, markerIndex: Math.min(p.markerIndex, raw.length - 1) }) });
    p.lineStages = saved.lineStages;
    p.markerIndex = saved.markerIndex;
    $('#sl-editor').style.display = 'none';
    renderStraightLine();
    toast('Etapy linii zapisane.');
  } catch (err) { toast(err.message); }
});

$$('.practice-tab').forEach(function (tab) {
  tab.addEventListener('click', function () {
    $$('.practice-tab').forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    practiceType = tab.dataset.ptype;
    renderPractice();
  });
});

$('#btn-save-practice').addEventListener('click', async function () {
  const p = collectPracticeFromForm();
  try {
    await api('/practice', { method: 'PUT', body: JSON.stringify({ type: practiceType, stages: p.stages, lineStages: p.lineStages, markerIndex: p.markerIndex }) });
    toast('Skrypt zapisany.');
  } catch (err) { toast(err.message); }
});

$('#btn-improve-script').addEventListener('click', async function () {
  const btn = $('#btn-improve-script');
  const out = $('#practice-review');
  const p = collectPracticeFromForm();
  btn.disabled = true;
  btn.textContent = 'Analizuje...';
  out.innerHTML = '';
  try {
    await api('/practice', { method: 'PUT', body: JSON.stringify({ type: practiceType, stages: p.stages, lineStages: p.lineStages, markerIndex: p.markerIndex }) });
    const data = await api('/practice/improve', { method: 'POST', body: JSON.stringify({ type: practiceType }) });
    const badge = data.source === 'ai' ? '<span class="review-badge review-ai">Analiza AI</span>' : '<span class="review-badge review-heur">Analiza regulowa</span>';
    out.innerHTML = '<div class="review-card"><div class="review-head">' + badge + '<h3 class="chart-title">Co poprawic w skrypcie</h3></div><p class="review-overall">' + escapeHtml(data.overall || '') + '</p>' + data.reviews.map(function (r) {
      return '<div class="review-stage"><div class="review-stage-title">' + escapeHtml(r.stage) + '</div>' + ((r.tips || []).length ? '<ul class="review-tips">' + r.tips.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>' : '<div class="review-none">Brak uwag do tego etapu.</div>') + ((r.good || []).length ? '<ul class="review-good">' + r.good.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
    }).join('') + '</div>';
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Ulepsz skrypt (AI)';
  }
});

$$('.nav-item').forEach(function (btn) {
  if (btn.dataset.view === 'practice') btn.addEventListener('click', function () { loadPractice(); });
});


// ===========================================================================
// FAST RESEARCH v2 — 4 kroki: klient+PDF -> inwestycje -> research -> raport
// ===========================================================================
let frPdfs = [];
let frStage1 = null;
let frReport = null;

function frSetStep(n) {
  $$('.fr-step').forEach(el => el.classList.toggle('active', Number(el.dataset.step) <= n));
  [1, 2, 3, 4].forEach(i => {
    const p = $('#fr-step-' + i);
    if (p) p.style.display = i === n ? 'block' : 'none';
  });
  $('#fr-restart').style.display = n > 1 ? 'inline-block' : 'none';
}

function frMoney(v) {
  return (v === null || v === undefined) ? '—' : Number(v).toLocaleString('pl-PL') + ' zł';
}
function frVal(v, suffix) {
  return (v === null || v === undefined || v === '') ? '<span class="fr-na">brak danych</span>' : escapeHtml(String(v)) + (suffix || '');
}
function frBool(v) {
  if (v === true) return '✅ tak';
  if (v === false) return '❌ nie';
  return '<span class="fr-na">brak danych</span>';
}

// Podgląd preferencji wybranego klienta — agent od razu widzi, na czym
// system oprze dopasowanie, i czego brakuje w profilu.
function frRenderPrefs() {
  const c = clients.find(x => x.id === $('#fr-client').value);
  const box = $('#fr-prefs');
  if (!c) { box.innerHTML = ''; return; }
  const rows = [
    ['Budżet', (c.budget_min || c.budget_max) ? (frMoney(c.budget_min) + ' – ' + frMoney(c.budget_max)) : null],
    ['Lokalizacje', c.pref_locations],
    ['Max do komunikacji', c.max_transit_min ? c.max_transit_min + ' min' : null],
    ['Pokoje', (c.rooms_min || c.rooms_max) ? ((c.rooms_min || '?') + ' – ' + (c.rooms_max || '?')) : null],
    ['Metraż', (c.area_min || c.area_max) ? ((c.area_min || '?') + ' – ' + (c.area_max || '?') + ' m²') : null],
    ['Priorytety', [c.needs_balcony && 'balkon', c.needs_parking && 'parking', c.needs_elevator && 'winda'].filter(Boolean).join(', ')]
  ];
  const missing = rows.filter(r => !r[1]).map(r => r[0]);
  box.innerHTML = '<div class="fr-prefs-grid">' + rows.map(r =>
    '<div><span class="fr-prefs-label">' + r[0] + '</span><span class="fr-prefs-value">' + (r[1] ? escapeHtml(String(r[1])) : '<span class="fr-na">nie ustawiono</span>') + '</span></div>'
  ).join('') + '</div>' +
  (missing.length ? '<p class="fr-warn">Uzupełnij w karcie klienta: ' + escapeHtml(missing.join(', ')) + ' — im mniej danych, tym słabsze dopasowanie.</p>' : '');
}

async function frLoadPdfs() {
  try {
    frPdfs = await api('/research/pdfs');
  } catch (err) { frPdfs = []; }
  $('#fr-pdf-select').innerHTML = frPdfs.length
    ? frPdfs.map(p => '<option value="' + p.id + '">' + escapeHtml(p.filename) + ' — ' + p.count + ' inwestycji (' + new Date(p.created_at).toLocaleDateString('pl-PL') + ')</option>').join('')
    : '<option value="">Brak wgranych list — wgraj PDF</option>';
}

async function initFastResearch() {
  frSetStep(1);
  $('#fr-client').innerHTML = clients.length
    ? clients.map(c => '<option value="' + c.id + '">' + escapeHtml(c.imie) + ' ' + escapeHtml(c.nazwisko) + '</option>').join('')
    : '<option value="">Brak klientów — dodaj klienta w Deals</option>';
  frRenderPrefs();
  await frLoadPdfs();
}

$('#fr-client').addEventListener('change', frRenderPrefs);

$('#fr-pdf-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#fr-pdf-status');
  status.textContent = 'Przetwarzam PDF…';
  try {
    const base64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const res = await api('/research/pdf', { method: 'POST', body: JSON.stringify({ filename: file.name, base64 }) });
    await frLoadPdfs();
    $('#fr-pdf-select').value = res.id;
    status.textContent = 'Odczytano ' + res.count + ' inwestycji z pliku ' + res.filename + '.';
    toast('Lista inwestycji wgrana.');
  } catch (err) {
    status.textContent = err.message;
    toast(err.message);
  } finally {
    e.target.value = '';
  }
});

$('#fr-go-stage1').addEventListener('click', async () => {
  const clientId = $('#fr-client').value;
  const pdfId = $('#fr-pdf-select').value;
  if (!clientId) { toast('Wybierz klienta.'); return; }
  if (!pdfId) { toast('Wgraj lub wybierz listę inwestycji (PDF).'); return; }
  try {
    frStage1 = await api('/research/stage1', { method: 'POST', body: JSON.stringify({ client_id: clientId, pdf_id: pdfId }) });
    frRenderStage1();
    frSetStep(2);
  } catch (err) { toast(err.message); }
});

function frRenderStage1() {
  const d = frStage1;
  $('#fr-stage1-summary').textContent =
    'Z ' + d.total + ' inwestycji w pliku ' + d.pdf_filename + ' do kryteriów klienta pasuje ' + d.matched.length + '. Zaznacz te, które mam sprawdzić na stronach deweloperów.';

  $('#fr-matched').innerHTML = d.matched.length ? d.matched.map(m =>
    '<label class="fr-inv-card"><input type="checkbox" class="fr-inv-check" value="' + m.id + '" checked />' +
    '<div class="fr-inv-main"><div class="fr-inv-head"><span class="fr-inv-name">' + escapeHtml(m.name) + '</span>' +
    '<span class="fr-score">' + m.score + '%</span></div>' +
    '<div class="fr-inv-meta">' + escapeHtml(m.developer || 'deweloper: brak danych') + ' · ' + escapeHtml(m.location || 'lokalizacja: brak danych') +
    (m.price_min ? ' · ' + frMoney(m.price_min) + ' – ' + frMoney(m.price_max) : (m.price_per_m2 ? ' · ' + frMoney(m.price_per_m2) + '/m²' : '')) + '</div>' +
    m.reasons.map(r => '<div class="fr-reason ok">✓ ' + escapeHtml(r) + '</div>').join('') +
    m.gaps.map(g => '<div class="fr-reason gap">? ' + escapeHtml(g) + '</div>').join('') +
    '</div></label>'
  ).join('') : '<div class="admin-list-empty">Żadna inwestycja z tej listy nie spełnia kryteriów klienta.</div>';

  $('#fr-rejected').innerHTML = d.rejected.length
    ? '<details class="fr-rejected"><summary>Odrzucone inwestycje (' + d.rejected.length + ')</summary>' +
      d.rejected.map(r => '<div class="fr-rej-row"><strong>' + escapeHtml(r.name) + '</strong> — ' + escapeHtml(r.reason) + '</div>').join('') +
      '</details>'
    : '';
}

$('#fr-back-1').addEventListener('click', () => frSetStep(1));
$('#fr-back-2').addEventListener('click', () => frSetStep(2));
$('#fr-restart').addEventListener('click', () => initFastResearch());
$('#fr-print').addEventListener('click', () => window.print());

$('#fr-go-stage2').addEventListener('click', async () => {
  const ids = $$('.fr-inv-check:checked').map(c => c.value);
  if (!ids.length) { toast('Zaznacz przynajmniej jedną inwestycję.'); return; }
  const chosen = frStage1.matched.filter(m => ids.includes(m.id));

  frSetStep(3);
  $('#fr-progress').innerHTML = chosen.map(c =>
    '<div class="fr-prog-row"><span class="fr-spinner"></span> Sprawdzam stronę: <strong>' + escapeHtml(c.developer || c.name) + '</strong>…</div>'
  ).join('') + '<p class="settings-hint" style="margin-top:14px;">Research potrafi potrwać — system otwiera strony deweloperów i czyta listy dostępnych lokali.</p>';

  try {
    frReport = await api('/research/run', {
      method: 'POST',
      body: JSON.stringify({ client_id: frStage1.client.id, pdf_id: frStage1.pdf.id, investment_ids: ids })
    });
    frRenderReport();
    frSetStep(4);
  } catch (err) {
    toast(err.message);
    frSetStep(2);
  }
});

function frRenderReport() {
  const d = frReport;
  const head =
    '<div class="fr-report-head"><div>' +
    '<h2 class="fr-report-title">Raport dopasowania — ' + escapeHtml(d.client_name) + '</h2>' +
    '<p class="settings-hint">Źródło listy: ' + escapeHtml(d.pdf_filename) + ' · Data researchu: ' + new Date(d.researched_at).toLocaleString('pl-PL') +
    ' · Tryb: ' + (d.ai_used ? 'wyszukiwanie internetowe' : 'ograniczony (brak klucza API)') + '</p>' +
    '</div></div>' +
    (d.below_threshold ? '<p class="fr-warn">Żaden lokal nie osiągnął 80% zgodności. Poniżej najlepsze dostępne dopasowania — sprawdź, czego zabrakło.</p>' : '');

  const invNotes = d.investigated.filter(e => e.note).map(e =>
    '<div class="fr-note"><strong>' + escapeHtml(e.investment) + '</strong>: ' + escapeHtml(e.note) + '</div>'
  ).join('');

  if (!d.results.length) {
    $('#fr-report').innerHTML = head +
      '<div class="admin-list-empty">Nie znaleziono żadnych konkretnych lokali. Szczegóły poniżej — nie wymyślam mieszkań, których nie udało się odczytać.</div>' + invNotes;
    return;
  }

  $('#fr-report').innerHTML = head + d.results.map((r, i) =>
    '<div class="fr-result">' +
      '<div class="fr-result-top"><span class="fr-rank">#' + (i + 1) + '</span>' +
      '<span class="fr-result-name">' + escapeHtml(r.investment.name) + '</span>' +
      '<span class="fr-score big">' + r.score + '%</span></div>' +

      '<div class="fr-sect"><div class="fr-sect-title">A. Inwestycja</div><div class="fr-grid">' +
      '<div><span class="fr-k">Deweloper</span><span class="fr-v">' + frVal(r.investment.developer) + '</span></div>' +
      '<div><span class="fr-k">Lokalizacja</span><span class="fr-v">' + frVal(r.investment.location) + '</span></div>' +
      '<div><span class="fr-k">Komunikacja</span><span class="fr-v">' + frVal(r.investment.transit) + '</span></div>' +
      '<div><span class="fr-k">Termin oddania</span><span class="fr-v">' + frVal(r.investment.ready) + '</span></div>' +
      '<div><span class="fr-k">Zakres cen</span><span class="fr-v">' + frVal(r.investment.price_range) + '</span></div>' +
      '</div>' +
      (r.investment.pros.length ? '<ul class="fr-pros">' + r.investment.pros.map(p => '<li>✅ ' + escapeHtml(p) + '</li>').join('') + '</ul>' : '') +
      (r.investment.cons.length ? '<ul class="fr-cons">' + r.investment.cons.map(p => '<li>❌ ' + escapeHtml(p) + '</li>').join('') + '</ul>' : '') +
      '</div>' +

      '<div class="fr-sect"><div class="fr-sect-title">B. Mieszkanie</div><div class="fr-grid">' +
      '<div><span class="fr-k">Metraż</span><span class="fr-v">' + frVal(r.unit.area, ' m²') + '</span></div>' +
      '<div><span class="fr-k">Pokoje</span><span class="fr-v">' + frVal(r.unit.rooms) + '</span></div>' +
      '<div><span class="fr-k">Piętro</span><span class="fr-v">' + frVal(r.unit.floor) + '</span></div>' +
      '<div><span class="fr-k">Cena</span><span class="fr-v">' + (r.unit.price === null ? '<span class="fr-na">brak danych</span>' : frMoney(r.unit.price)) + '</span></div>' +
      '<div><span class="fr-k">Balkon/taras</span><span class="fr-v">' + frBool(r.unit.balcony) + '</span></div>' +
      '<div><span class="fr-k">Parking</span><span class="fr-v">' + frBool(r.unit.parking) + '</span></div>' +
      '<div><span class="fr-k">Komórka lokatorska</span><span class="fr-v">' + frBool(r.unit.storage) + '</span></div>' +
      '<div><span class="fr-k">Dostępność</span><span class="fr-v">' + frVal(r.unit.available_from) + '</span></div>' +
      '</div>' +
      (r.unit.layout ? '<p class="fr-layout">Układ: ' + escapeHtml(r.unit.layout) + '</p>' : '') +
      (r.unit.source ? '<a class="fr-source" href="' + escapeHtml(r.unit.source) + '" target="_blank" rel="noopener">🔗 Zobacz ofertę u dewelopera</a>' : '<span class="fr-na">Brak linku do oferty</span>') +
      '</div>' +

      '<div class="fr-sect"><div class="fr-sect-title">C. Dopasowanie — ' + r.score + '%</div>' +
      (r.missing.length
        ? '<ul class="fr-cons">' + r.missing.map(m => '<li>➖ ' + escapeHtml(m) + '</li>').join('') + '</ul>'
        : '<p class="fr-ok-line">Spełnia wszystkie zdefiniowane kryteria klienta.</p>') +
      (r.unclear.length ? '<p class="fr-warn">Niejasne dane na stronie dewelopera: ' + escapeHtml(r.unclear.join('; ')) + '</p>' : '') +
      '</div>' +
    '</div>'
  ).join('') + invNotes;
}

$$('.nav-item').forEach(function (btn) {
  if (btn.dataset.view === 'research') btn.addEventListener('click', function () { initFastResearch(); });
});


// ===========================================================================
// PREFERENCJE KLIENTA — okno edycji danych używanych przez Fast Research
// ===========================================================================
function openPrefsModal(clientId) {
  const c = clients.find(x => x.id === clientId);
  if (!c) return;
  $('#prefs-client-id').value = c.id;
  $('#prefs-client-name').textContent = c.imie + ' ' + c.nazwisko;

  const set = (id, v) => { $(id).value = (v === null || v === undefined) ? '' : v; };
  set('#prefs-budget-min', c.budget_min);
  set('#prefs-budget-max', c.budget_max);
  set('#prefs-locations', c.pref_locations);
  set('#prefs-transit', c.max_transit_min);
  set('#prefs-rooms-min', c.rooms_min);
  set('#prefs-rooms-max', c.rooms_max);
  set('#prefs-area-min', c.area_min);
  set('#prefs-area-max', c.area_max);
  set('#prefs-floor-min', c.floor_min);
  set('#prefs-floor-max', c.floor_max);
  set('#prefs-ready', c.ready_by);
  // Uwagi opisowe: nowe pole, a jak puste — pokazujemy stare "preferencje",
  // żeby nie zgubić tego, co agent wpisał przed rozbudową profilu.
  set('#prefs-notes', c.pref_notes || c.preferencje || '');

  $('#prefs-balcony').checked = Boolean(c.needs_balcony);
  $('#prefs-parking').checked = Boolean(c.needs_parking);
  $('#prefs-elevator').checked = Boolean(c.needs_elevator);

  const w = c.pref_weights || {};
  set('#prefs-w-price', w.price);
  set('#prefs-w-rooms', w.rooms);
  set('#prefs-w-area', w.area);
  set('#prefs-w-floor', w.floor);

  openModal('modal-prefs');
}

$('#client-view-prefs-btn').addEventListener('click', () => {
  if (window.__clientViewId) openPrefsModal(window.__clientViewId);
});

$('#form-prefs').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('#prefs-client-id').value;
  const num = sel => { const v = $(sel).value.trim(); return v === '' ? null : Number(v); };

  const weights = {};
  [['price', '#prefs-w-price'], ['rooms', '#prefs-w-rooms'], ['area', '#prefs-w-area'], ['floor', '#prefs-w-floor']]
    .forEach(pair => { const v = num(pair[1]); if (v !== null) weights[pair[0]] = v; });

  const payload = {
    budget_min: num('#prefs-budget-min'),
    budget_max: num('#prefs-budget-max'),
    pref_locations: $('#prefs-locations').value.trim(),
    max_transit_min: num('#prefs-transit'),
    rooms_min: num('#prefs-rooms-min'),
    rooms_max: num('#prefs-rooms-max'),
    area_min: num('#prefs-area-min'),
    area_max: num('#prefs-area-max'),
    floor_min: num('#prefs-floor-min'),
    floor_max: num('#prefs-floor-max'),
    ready_by: $('#prefs-ready').value.trim(),
    needs_balcony: $('#prefs-balcony').checked,
    needs_parking: $('#prefs-parking').checked,
    needs_elevator: $('#prefs-elevator').checked,
    pref_notes: $('#prefs-notes').value.trim(),
    pref_weights: Object.keys(weights).length ? weights : null
  };

  if (payload.budget_min && payload.budget_max && payload.budget_min > payload.budget_max) {
    toast('Budżet "od" nie może być większy niż "do".');
    return;
  }
  if (payload.area_min && payload.area_max && payload.area_min > payload.area_max) {
    toast('Metraż "od" nie może być większy niż "do".');
    return;
  }

  try {
    await api('/clients/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    await refreshAll();
    closeModal('modal-prefs');
    toast('Preferencje zapisane.');
    // Jeśli Fast Research jest otwarty, odśwież podgląd preferencji.
    if ($('#fr-prefs') && $('#view-research').classList.contains('active')) frRenderPrefs();
  } catch (err) { toast(err.message); }
});


// ===========================================================================
// OPISY ETAPÓW, PRIORYTETY ZADAŃ, WŁASNY PODZIAŁ PROWIZJI
// ===========================================================================

// --- Podział prowizji: gotowe opcje + własna wartość ---
(function initCustomSplit() {
  const sel = $('#settings-split');
  const custom = $('#settings-split-custom');
  if (!sel || !custom) return;

  const syncVisibility = () => {
    const isCustom = sel.value === 'custom';
    custom.style.display = isCustom ? 'block' : 'none';
    if (isCustom) custom.focus();
  };
  sel.addEventListener('change', syncVisibility);

  // Nadpisujemy stary handler: podmieniamy przycisk na klon, żeby usunąć
  // wcześniejsze nasłuchy zapisujące tylko wartość z listy.
  const oldBtn = $('#btn-save-split');
  if (!oldBtn) return;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);

  btn.addEventListener('click', async () => {
    const raw = sel.value === 'custom' ? custom.value.replace(',', '.') : sel.value;
    const val = Number(raw);
    if (!Number.isFinite(val) || val <= 0 || val > 100) {
      toast('Podaj podział prowizji jako liczbę od 1 do 100.');
      return;
    }
    try {
      const data = await api('/profiles/me/settings', { method: 'PUT', body: JSON.stringify({ prowizja_agenta: val }) });
      currentProfile = data;
      toast('Podział prowizji ustawiony na ' + val + '%.');
      renderSettingsView();
    } catch (err) { toast(err.message); }
  });
})();

// Ustawia listę na wartość profilu; nietypowe % trafiają do pola własnego.
function applySplitToForm() {
  const sel = $('#settings-split');
  const custom = $('#settings-split-custom');
  if (!sel || !custom || !currentProfile) return;
  const val = Number(currentProfile.prowizja_agenta) || 50;
  const preset = ['45', '50', '55', '60'];
  if (preset.includes(String(val))) {
    sel.value = String(val);
    custom.style.display = 'none';
    custom.value = '';
  } else {
    sel.value = 'custom';
    custom.style.display = 'block';
    custom.value = val;
  }
}

// --- Opisy etapów w Settings ---
function renderStageSettings() {
  const box = $('#settings-stages-list');
  if (!box) return;
  const names = (currentProfile && Array.isArray(currentProfile.stages) && currentProfile.stages.length) ? currentProfile.stages : STAGES;
  const descs = (currentProfile && Array.isArray(currentProfile.stageDescriptions)) ? currentProfile.stageDescriptions : names.map(function () { return ''; });
  box.innerHTML = names.map(function (name, i) {
    return '<div class="stage-row">' +
      '<div class="field"><label for="stage-name-' + i + '">Etap ' + (i + 1) + '</label>' +
      '<input type="text" id="stage-name-' + i + '" class="stage-name-input" value="' + escapeHtml(name) + '" /></div>' +
      '<div class="field"><label for="stage-desc-' + i + '">Opis (pokaże się po najechaniu na ⓘ)</label>' +
      '<input type="text" id="stage-desc-' + i + '" class="stage-desc-input" placeholder="np. klient po prezentacji, czeka na decyzję" value="' + escapeHtml(descs[i] || '') + '" /></div>' +
      '</div>';
  }).join('');
}

(function initStagesSave() {
  const oldBtn = $('#btn-save-stages');
  if (!oldBtn) return;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);

  btn.addEventListener('click', async () => {
    const stages = $$('.stage-name-input').map(i => i.value.trim());
    const stageDescriptions = $$('.stage-desc-input').map(i => i.value.trim());
    if (stages.some(v => !v)) { toast('Nazwy etapów nie mogą być puste.'); return; }
    try {
      const data = await api('/profiles/me/settings', {
        method: 'PUT',
        body: JSON.stringify({ stages: stages, stageDescriptions: stageDescriptions })
      });
      currentProfile = data;
      STAGES = data.stages;
      Object.keys(STAGE_COLORS).forEach(k => delete STAGE_COLORS[k]);
      STAGES.forEach(function (st, i) { STAGE_COLORS[st] = 'var(--stage-' + (i + 1) + ')'; });
      const sel = $('#lead-stage');
      if (sel) sel.innerHTML = STAGES.map(st => '<option value="' + escapeHtml(st) + '">' + escapeHtml(st) + '</option>').join('');
      await refreshAll();
      renderBoard();
      renderStageSettings();
      toast('Etapy i opisy zapisane.');
    } catch (err) { toast(err.message); }
  });
})();

// --- Znaczek ⓘ z opisem na kolumnach kanbanu ---
function decorateBoardWithStageInfo() {
  const descs = (currentProfile && Array.isArray(currentProfile.stageDescriptions)) ? currentProfile.stageDescriptions : [];
  if (!descs.length) return;
  $$('.column').forEach(function (col) {
    const name = col.dataset.stage;
    const idx = STAGES.indexOf(name);
    const desc = idx >= 0 ? descs[idx] : '';
    const head = col.querySelector('.column-title');
    if (!head || head.querySelector('.stage-info') || !desc) return;
    const badge = document.createElement('span');
    badge.className = 'stage-info';
    badge.textContent = 'ⓘ';
    badge.setAttribute('data-tip', desc);
    head.appendChild(badge);
  });
}

// Znaczek ⓘ dorysowujemy po każdym renderze tablicy.
(function hookBoardInfo() {
  const orig = renderBoard;
  renderBoard = function () {
    orig.apply(this, arguments);
    decorateBoardWithStageInfo();
  };
})();

// --- Priorytety A/B/C w Plannerze ---
(function hookPlannerPriority() {
  const origCal = renderPlannerCalendar;
  renderPlannerCalendar = function () {
    origCal.apply(this, arguments);
    applyPriorityStyling();
  };
  const origList = renderPlannerList;
  renderPlannerList = function () {
    origList.apply(this, arguments);
    applyPriorityStyling();
  };
})();

function applyPriorityStyling() {
  $$('.task-chip, .task-row, .goal-card').forEach(function (el) {
    let id = el.dataset.id;
    if (!id) {
      const chk = el.querySelector('.task-check');
      if (chk) id = chk.dataset.id;
    }
    if (!id) return;
    const t = plannerTasks.find(function (x) { return x.id === id; });
    el.classList.remove('prio-A', 'prio-B', 'prio-C');
    if (t && t.priority) {
      el.classList.add('prio-' + t.priority);
      if (!el.querySelector('.prio-badge')) {
        const b = document.createElement('span');
        b.className = 'prio-badge prio-' + t.priority;
        b.textContent = t.priority;
        el.insertBefore(b, el.firstChild);
      }
    }
  });
}

// Priorytet w formularzu zadania
(function hookTaskPriority() {
  const origOpen = openTaskModal;
  openTaskModal = function (id, preset) {
    origOpen(id, preset);
    const sel = $('#task-priority');
    if (!sel) return;
    const t = id ? plannerTasks.find(function (x) { return x.id === id; }) : null;
    sel.value = (t && t.priority) ? t.priority : '';
  };

  const form = $('#form-task');
  if (!form) return;
  form.addEventListener('submit', function () {
    window.__pendingPriority = $('#task-priority') ? ($('#task-priority').value || null) : null;
  }, true);
})();

// api() dokleja priorytet do żądań plannera — dzięki temu nie duplikujemy
// całej obsługi formularza tylko po to, żeby dodać jedno pole.
(function patchApiForPriority() {
  const origApi = api;
  api = async function (path, options) {
    if (options && options.body && /^\/planner(\/|$)/.test(path) && window.__pendingPriority !== undefined) {
      try {
        const body = JSON.parse(options.body);
        if (body.title !== undefined) {
          body.priority = window.__pendingPriority;
          options = Object.assign({}, options, { body: JSON.stringify(body) });
          window.__pendingPriority = undefined;
        }
      } catch (e) { /* nie ruszamy żądań, których nie da się sparsować */ }
    }
    return origApi(path, options);
  };
})();
