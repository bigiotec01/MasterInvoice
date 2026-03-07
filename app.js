/* ============================================================
   MasterInvoice Pro - app.js
   ============================================================ */

'use strict';

// ============================================================
// CONFIG — Replace with your Supabase project values
// ============================================================
const SUPABASE_URL = 'https://juqhxuxctiqmpxcjyopr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp1cWh4dXhjdGlxbXB4Y2p5b3ByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NDU2NzEsImV4cCI6MjA4ODMyMTY3MX0.ijZXwDEu33R44PJog5lIKWa7uhvD6agmBdUO16pHteI';

// ============================================================
// SUPABASE CLIENT (inicializado en DOMContentLoaded)
// ============================================================
let db = null;

// ============================================================
// APP STATE
// ============================================================
let state = {
  user: null,
  company: null,
  clients: [],
  invoices: [],
  quotes: [],
  expenses: [],
  currentDoc: null,
  currentDocType: 'invoice',
  lineItems: [],
  charts: {},
};

// ============================================================
// BOOT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Verificar que Supabase CDN cargo
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    document.getElementById('loading-overlay').innerHTML =
      '<p style="color:#dc2626;font-size:1rem;padding:24px;text-align:center;">Error al cargar la aplicacion.<br>Verifica tu conexion a internet y recarga la pagina.</p>';
    return;
  }

  // Usar siempre memoria para evitar bloqueos de Tracking Prevention en Edge/Chrome
  const mem = {};
  const authStorage = {
    getItem: k => mem[k] ?? null,
    setItem: (k, v) => { mem[k] = v; },
    removeItem: k => { delete mem[k]; },
  };

  // Inicializar cliente Supabase
  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { storage: authStorage, persistSession: false, detectSessionInUrl: false },
  });

  // Mostrar login inmediatamente — no bloquear en espera de sesión
  showAuth();

  // Verificar sesión existente en segundo plano
  db.auth.getSession().then(({ data: { session } }) => {
    if (session?.user && !state.user) {
      state.user = session.user;
      afterLogin().catch(() => showAuth());
    }
  }).catch(() => {});

  // Listener de cambio de sesion
  db.auth.onAuthStateChange(async (_event, session) => {
    if (session?.user && !state.user) {
      state.user = session.user;
      await afterLogin().catch(() => showAuth());
    } else if (!session && state.user) {
      state.user = null;
      state.company = null;
      showAuth();
    }
  });

  // Filtros de reporte
  const yearSel = document.getElementById('report-year');
  if (yearSel) {
    const y = new Date().getFullYear();
    yearSel.innerHTML = '';
    for (let i = y - 2; i <= y + 1; i++) {
      yearSel.innerHTML += `<option value="${i}" ${i === y ? 'selected' : ''}>${i}</option>`;
    }
  }
  const mSel = document.getElementById('report-month');
  if (mSel) mSel.value = new Date().getMonth();

  if ('serviceWorker' in navigator) {
    // Desregistrar todos los SWs viejos antes de registrar el nuevo
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    }).finally(() => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
});

async function afterLogin() {
  try {
    const company = await loadCompany();
    if (!company) {
      showCompanySetup();
    } else {
      state.company = company;
      await loadAllData();
      showApp();
    }
  } catch (err) {
    console.error('afterLogin error:', err);
    showAuth();
  }
}

// ============================================================
// SCREEN MANAGEMENT
// ============================================================
function showAuth() {
  hide('loading-overlay');
  show('auth-container');
  hide('company-setup-container');
  hide('app-container');
}

function showCompanySetup() {
  hide('loading-overlay');
  hide('auth-container');
  show('company-setup-container');
  hide('app-container');
}

function showApp() {
  hide('loading-overlay');
  hide('auth-container');
  hide('company-setup-container');
  show('app-container');
  updateSidebarUser();
  navigate('dashboard');
}

// ============================================================
// NAVIGATION
// ============================================================
const VIEW_TITLES = {
  dashboard: 'Dashboard',
  invoices: 'Facturas',
  quotes: 'Cotizaciones',
  'invoice-editor': 'Nuevo Documento',
  clients: 'Clientes',
  expenses: 'Gastos',
  reports: 'Reportes',
  settings: 'Configuracion',
};

function navigate(view, params = {}) {
  closeSidebar();
  // Hide all views
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  // Update nav active
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  // Set page title
  document.getElementById('page-title').textContent = VIEW_TITLES[view] || view;
  // Clear header actions
  document.getElementById('header-actions').innerHTML = '';

  if (view === 'dashboard') renderDashboard();
  else if (view === 'invoices') renderInvoicesList();
  else if (view === 'quotes') renderQuotesList();
  else if (view === 'invoice-editor') openEditor(params);
  else if (view === 'clients') renderClientsList();
  else if (view === 'expenses') renderExpensesList();
  else if (view === 'reports') { show('view-reports'); loadReports(); }
  else if (view === 'settings') { show('view-settings'); loadSettings(); }

  // Mark nav item active for parent views
  const navMap = { 'invoice-editor': view === 'invoice-editor' ? (params.type === 'quote' ? 'quotes' : 'invoices') : view };
  if (navMap[view]) {
    document.querySelectorAll('.nav-item').forEach(n => {
      if (n.dataset.view === navMap[view]) n.classList.add('active');
    });
  }
}

// ============================================================
// AUTH FUNCTIONS
// ============================================================
async function handleLogin() {
  const email = val('login-email').trim();
  const password = val('login-password');
  if (!email || !password) { showAuthError('auth-error', 'Completa todos los campos.'); return; }
  if (!db) { showAuthError('auth-error', 'Error de conexion. Recarga la pagina.'); return; }

  setLoading('loading-overlay', true);
  try {
    const { error } = await db.auth.signInWithPassword({ email, password });
    if (error) showAuthError('auth-error', translateAuthError(error.message));
  } catch (err) {
    console.error('Login error:', err);
    showAuthError('auth-error', 'Error al iniciar sesion. Intenta de nuevo.');
  } finally {
    setLoading('loading-overlay', false);
  }
}

async function handleChangePassword() {
  const newPass = val('new-password');
  const confirmPass = val('confirm-password');
  const errEl = document.getElementById('change-pass-error');
  const okEl = document.getElementById('change-pass-success');
  errEl.style.display = 'none';
  okEl.style.display = 'none';

  if (!newPass || !confirmPass) { errEl.textContent = 'Completa ambos campos.'; errEl.style.display = 'block'; return; }
  if (newPass.length < 8) { errEl.textContent = 'La contrasena debe tener al menos 8 caracteres.'; errEl.style.display = 'block'; return; }
  if (newPass !== confirmPass) { errEl.textContent = 'Las contrasenas no coinciden.'; errEl.style.display = 'block'; return; }

  const { error } = await db.auth.updateUser({ password: newPass });
  if (error) { errEl.textContent = 'Error: ' + error.message; errEl.style.display = 'block'; return; }
  okEl.style.display = 'block';
  document.getElementById('new-password').value = '';
  document.getElementById('confirm-password').value = '';
}

async function handleLogout() {
  await db.auth.signOut();
  state.user = null;
  state.company = null;
  state.clients = [];
  state.invoices = [];
  state.quotes = [];
  showAuth();
}

function showForgotPassword() {
  document.getElementById('forgot-success').style.display = 'none';
  openModal('modal-forgot');
}

async function handleForgotPassword() {
  const email = val('forgot-email').trim();
  if (!email) return;
  const { error } = await db.auth.resetPasswordForEmail(email);
  if (!error) {
    document.getElementById('forgot-success').style.display = 'block';
  }
}

function translateAuthError(msg) {
  if (msg.includes('Invalid login')) return 'Email o contrasena incorrectos.';
  if (msg.includes('already registered')) return 'Este email ya esta registrado.';
  if (msg.includes('Email not confirmed')) return 'Confirma tu email antes de entrar.';
  if (msg.includes('Password should')) return 'La contrasena debe tener al menos 6 caracteres.';
  return msg;
}

function showAuthError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = 'block';
}

// ============================================================
// COMPANY SETUP
// ============================================================
async function loadCompany() {
  if (!state.user) return null;
  const { data } = await db.from('companies').select('*').eq('user_id', state.user.id).single();
  return data;
}

async function handleCompanySetup() {
  const name = val('setup-name').trim();
  if (!name) { showAuthError('setup-error', 'El nombre de la empresa es requerido.'); return; }

  setLoading('loading-overlay', true);
  const payload = {
    user_id: state.user.id,
    name,
    phone: val('setup-phone').trim(),
    email: val('setup-email').trim(),
    address: val('setup-address').trim(),
    city: val('setup-city').trim(),
    state: val('setup-state').trim(),
    industry: val('setup-industry'),
    license_number: val('setup-license').trim(),
  };

  const { data, error } = await db.from('companies').insert(payload).select().single();
  setLoading('loading-overlay', false);

  if (error) { showAuthError('setup-error', 'Error al guardar: ' + error.message); return; }
  state.company = data;
  await loadAllData();
  showApp();
}

// ============================================================
// DATA LOADERS
// ============================================================
async function loadAllData() {
  if (!state.company) return;
  const cid = state.company.id;
  const [clientsRes, invoicesRes, quotesRes, expensesRes] = await Promise.all([
    db.from('clients').select('*').eq('company_id', cid).order('name'),
    db.from('invoices').select('*, clients(name, email, phone)').eq('company_id', cid).eq('type', 'invoice').order('created_at', { ascending: false }),
    db.from('invoices').select('*, clients(name, email, phone)').eq('company_id', cid).eq('type', 'quote').order('created_at', { ascending: false }),
    db.from('expenses').select('*').eq('company_id', cid).order('date', { ascending: false }),
  ]);
  state.clients = clientsRes.data || [];
  state.invoices = invoicesRes.data || [];
  state.quotes = quotesRes.data || [];
  state.expenses = expensesRes.data || [];
  updateBadges();
}

function updateBadges() {
  const pendingInv = state.invoices.filter(i => i.status === 'sent').length;
  const pendingQt = state.quotes.filter(q => q.status === 'sent').length;
  const elInv = document.getElementById('badge-invoices');
  const elQt = document.getElementById('badge-quotes');
  if (elInv) { elInv.textContent = pendingInv; elInv.style.display = pendingInv ? 'inline' : 'none'; }
  if (elQt) { elQt.textContent = pendingQt; elQt.style.display = pendingQt ? 'inline' : 'none'; }
}

function updateSidebarUser() {
  const name = state.company?.name || state.user?.user_metadata?.full_name || 'Usuario';
  const email = state.user?.email || '';
  const companyName = state.company?.name || '';
  const logoEl = document.getElementById('sidebar-logo-name');
  const subtitleEl = document.getElementById('sidebar-company-name');
  if (companyName) {
    logoEl.textContent = companyName;
    subtitleEl.style.display = 'none';
  } else {
    logoEl.innerHTML = 'Master<span style="color:var(--accent)">Invoice</span>';
    subtitleEl.style.display = '';
  }
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-email-display').textContent = email;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
}

// ============================================================
// DASHBOARD
// ============================================================
function renderDashboard() {
  show('view-dashboard');
  const now = new Date();
  const monthInvoices = state.invoices.filter(i => {
    const d = new Date(i.issue_date);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  });
  const paid = state.invoices.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);
  const pending = state.invoices.filter(i => i.status === 'sent').reduce((s, i) => s + Number(i.total), 0);
  const monthTotal = monthInvoices.reduce((s, i) => s + Number(i.total), 0);

  document.getElementById('stat-month-total').textContent = fmt(monthTotal);
  document.getElementById('stat-paid').textContent = fmt(paid);
  document.getElementById('stat-pending').textContent = fmt(pending);
  document.getElementById('stat-clients').textContent = state.clients.length;

  // Overdue invoices
  const today = new Date(); today.setHours(0,0,0,0);
  const overdue = state.invoices.filter(i => {
    if (!i.due_date || i.status === 'paid' || i.status === 'cancelled') return false;
    return new Date(i.due_date) < today;
  });
  const overdueSection = document.getElementById('overdue-section');
  if (overdueSection) overdueSection.style.display = overdue.length ? 'block' : 'none';
  if (overdue.length && !state._overdueToastShown) {
    state._overdueToastShown = true;
    setTimeout(() => toast(`⚠️ Tienes ${overdue.length} factura${overdue.length > 1 ? 's' : ''} vencida${overdue.length > 1 ? 's' : ''}`, 'error'), 800);
  }
  const overdueBody = document.getElementById('overdue-invoices-body');
  if (overdueBody) {
    overdueBody.innerHTML = overdue.map(inv => `
      <tr>
        <td><strong style="color:var(--danger);cursor:pointer" onclick="editDocument('${inv.id}','invoice')">${esc(inv.number)}</strong></td>
        <td>${esc(inv.clients?.name || '—')}</td>
        <td style="color:var(--danger)">${fmtDate(inv.due_date)}</td>
        <td><strong>${fmt(inv.total)}</strong></td>
        <td><button class="btn btn-primary btn-sm btn-xs" onclick="editDocument('${inv.id}','invoice')">Ver</button></td>
      </tr>
    `).join('');
  }

  // Recent invoices
  const recent = [...state.invoices].slice(0, 6);
  const tbody = document.getElementById('recent-invoices-body');
  if (recent.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><p>No hay facturas aun.</p></td></tr>';
  } else {
    tbody.innerHTML = recent.map(inv => `
      <tr>
        <td><strong style="color:var(--primary);cursor:pointer" onclick="editDocument('${inv.id}','invoice')">${esc(inv.number)}</strong></td>
        <td>${esc(inv.clients?.name || '—')}</td>
        <td>${fmtDate(inv.issue_date)}</td>
        <td><strong>${fmt(inv.total)}</strong></td>
        <td>${statusBadge(inv.status)}</td>
      </tr>
    `).join('');
  }

  // Dashboard chart (last 6 months)
  renderDashboardChart();
}

function renderDashboardChart() {
  const canvas = document.getElementById('chart-dashboard');
  if (!canvas) return;
  if (state.charts.dashboard) state.charts.dashboard.destroy();

  const months = [];
  const values = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d.toLocaleString('es', { month: 'short' }));
    const total = state.invoices
      .filter(inv => {
        const id = new Date(inv.issue_date);
        return id.getMonth() === d.getMonth() && id.getFullYear() === d.getFullYear();
      })
      .reduce((s, inv) => s + Number(inv.total), 0);
    values.push(total);
  }

  state.charts.dashboard = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: months,
      datasets: [{
        data: values,
        backgroundColor: 'rgba(30,64,175,.15)',
        borderColor: '#1e40af',
        borderWidth: 2,
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, grid: { color: '#f1f5f9' }, ticks: { callback: v => '$' + v.toLocaleString() } },
        x: { grid: { display: false } }
      }
    }
  });
}

// ============================================================
// INVOICES LIST
// ============================================================
function renderInvoicesList() {
  show('view-invoices');
  renderInvoicesTable(state.invoices, 'invoices-table-body', 'invoice');
  document.getElementById('search-invoices').value = '';
  document.getElementById('filter-invoice-status').value = '';
}

function filterInvoices() {
  const q = val('search-invoices').toLowerCase();
  const status = val('filter-invoice-status');
  const filtered = state.invoices.filter(i =>
    (!q || i.number.toLowerCase().includes(q) || (i.clients?.name || '').toLowerCase().includes(q)) &&
    (!status || i.status === status)
  );
  renderInvoicesTable(filtered, 'invoices-table-body', 'invoice');
}

function renderInvoicesTable(list, tbodyId, type) {
  const tbody = document.getElementById(tbodyId);
  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="table-empty"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No se encontraron documentos.</p></td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(inv => `
    <tr>
      <td><strong style="color:var(--primary);cursor:pointer" onclick="editDocument('${inv.id}','${type}')">${esc(inv.number)}</strong></td>
      <td>${esc(inv.clients?.name || '—')}</td>
      <td>${fmtDate(inv.issue_date)}</td>
      <td>${type === 'invoice' ? fmtDate(inv.due_date) : fmtDate(inv.valid_until)}</td>
      <td><strong>${fmt(inv.total)}</strong></td>
      <td>${statusBadge(inv.status)}</td>
      <td class="col-actions">
        <button class="btn btn-ghost btn-sm btn-icon" title="Editar" onclick="editDocument('${inv.id}','${type}')">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm btn-icon" title="PDF" onclick="quickPDF('${inv.id}','${type}')">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm btn-icon" title="Eliminar" onclick="confirmDelete('${inv.id}','${type}')" style="color:var(--danger)">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
}

// ============================================================
// QUOTES LIST
// ============================================================
function renderQuotesList() {
  show('view-quotes');
  renderInvoicesTable(state.quotes, 'quotes-table-body', 'quote');
  document.getElementById('search-quotes').value = '';
  document.getElementById('filter-quote-status').value = '';
}

function filterQuotes() {
  const q = val('search-quotes').toLowerCase();
  const status = val('filter-quote-status');
  const filtered = state.quotes.filter(i =>
    (!q || i.number.toLowerCase().includes(q) || (i.clients?.name || '').toLowerCase().includes(q)) &&
    (!status || i.status === status)
  );
  renderInvoicesTable(filtered, 'quotes-table-body', 'quote');
}

// ============================================================
// INVOICE EDITOR
// ============================================================
function openEditor(params = {}) {
  show('view-invoice-editor');
  const { type = 'invoice', id = null } = params;
  state.currentDocType = type;
  state.currentDoc = null;
  state.lineItems = [];

  const isQuote = type === 'quote';
  document.getElementById('editor-title').textContent = id ? (isQuote ? 'Editar Cotizacion' : 'Editar Factura') : (isQuote ? 'Nueva Cotizacion' : 'Nueva Factura');
  document.getElementById('page-title').textContent = document.getElementById('editor-title').textContent;
  document.getElementById('editor-date2-label').textContent = isQuote ? 'Valida Hasta' : 'Fecha de Vencimiento';
  document.getElementById('card-convert').style.display = (id && isQuote) ? 'block' : 'none';
  document.getElementById('btn-cancel-edit').onclick = () => navigate(isQuote ? 'quotes' : 'invoices');

  // Status options
  const statusSel = document.getElementById('editor-status');
  if (isQuote) {
    statusSel.innerHTML = `<option value="">-- Estado --</option><option value="sent">Enviada</option><option value="accepted">Aceptada</option><option value="rejected">Rechazada</option>`;
  } else {
    statusSel.innerHTML = `<option value="">-- Estado --</option><option value="sent">Enviada</option><option value="paid">Pagada</option><option value="cancelled">Cancelada</option>`;
  }

  // Populate client dropdown
  populateClientDropdown();

  // Defaults
  const today = new Date().toISOString().split('T')[0];
  const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  document.getElementById('editor-issue-date').value = today;
  document.getElementById('editor-date2').value = dueDate;
  document.getElementById('input-tax').value = state.company?.default_tax_rate || '';
  document.getElementById('input-tax-label').value = state.company?.default_tax_label || '';
  document.getElementById('input-tax2').value = '';
  document.getElementById('input-tax2-label').value = '';
  document.getElementById('input-discount').value = '';
  document.getElementById('editor-notes').value = '';
  document.getElementById('editor-terms').value = state.company?.default_payment_terms || 'Net 30';
  document.getElementById('editor-po-number').value = '';
  document.getElementById('editor-internal-notes').value = '';
  document.getElementById('editor-policies').checked = state.company?.show_policies || false;

  if (id) {
    loadDocumentForEdit(id, type);
  } else {
    // New document — get next number
    getNextNumber(type).then(num => {
      document.getElementById('editor-number').textContent = num;
    });
    addLineItem(); // start with one empty line
    recalculate();
  }
}

async function getNextNumber(type) {
  const { data } = await db.rpc('get_next_invoice_number', {
    p_company_id: state.company.id,
    p_type: type,
  });
  return data || (type === 'invoice' ? 'INV-0001' : 'QT-0001');
}

async function loadDocumentForEdit(id, type) {
  const list = type === 'invoice' ? state.invoices : state.quotes;
  let doc = list.find(d => d.id === id);
  if (!doc) {
    const { data } = await db.from('invoices').select('*, clients(*)').eq('id', id).single();
    doc = data;
  }
  if (!doc) return;
  state.currentDoc = doc;

  document.getElementById('editor-number').textContent = doc.number;
  document.getElementById('editor-issue-date').value = doc.issue_date;
  document.getElementById('editor-date2').value = type === 'invoice' ? (doc.due_date || '') : (doc.valid_until || '');
  document.getElementById('editor-status').value = doc.status;
  document.getElementById('editor-notes').value = doc.notes || '';
  document.getElementById('editor-terms').value = doc.terms || '';
  document.getElementById('editor-po-number').value = doc.po_number || '';
  document.getElementById('editor-internal-notes').value = doc.internal_notes || '';
  document.getElementById('input-tax').value = doc.tax_rate || '';
  document.getElementById('input-tax-label').value = doc.tax_label || '';
  document.getElementById('input-tax2').value = doc.tax2_rate || '';
  document.getElementById('input-tax2-label').value = doc.tax2_label || '';
  document.getElementById('input-discount').value = doc.discount || '';
  document.getElementById('editor-policies').checked = doc.include_policies || false;
  updateStatusBadge();

  if (doc.client_id) {
    document.getElementById('editor-client').value = doc.client_id;
    onClientChange();
  }

  // Load items
  const { data: items } = await db.from('invoice_items').select('*').eq('invoice_id', id).order('sort_order');
  state.lineItems = items || [];
  renderLineItems();
  recalculate();
}

function populateClientDropdown() {
  const sel = document.getElementById('editor-client');
  sel.innerHTML = '<option value="">-- Seleccionar cliente --</option>';
  state.clients.forEach(c => {
    sel.innerHTML += `<option value="${c.id}">${esc(c.name)}</option>`;
  });
  sel.innerHTML += '<option value="new">+ Nuevo cliente...</option>';
}

function onClientChange() {
  const val_client = document.getElementById('editor-client').value;
  if (val_client === 'new') {
    document.getElementById('editor-client').value = '';
    openClientModal(null, true); // open and come back to editor
    return;
  }
  const client = state.clients.find(c => c.id === val_client);
  const display = document.getElementById('client-info-display');
  if (client) {
    document.getElementById('client-display-name').textContent = client.name;
    const parts = [client.email, client.phone, client.address, client.city].filter(Boolean);
    document.getElementById('client-display-details').textContent = parts.join(' • ');
    display.classList.remove('hidden');
    // Pre-fill email modal
    if (client.email) document.getElementById('email-to').value = client.email;
  } else {
    display.classList.add('hidden');
  }
}

// ============================================================
// LINE ITEMS
// ============================================================
function addLineItem() {
  state.lineItems.push({ description: '', quantity: 1, unit_price: 0, total: 0 });
  renderLineItems();
}

function removeLineItem(idx) {
  state.lineItems.splice(idx, 1);
  renderLineItems();
  recalculate();
}

function renderLineItems() {
  const tbody = document.getElementById('items-body');
  tbody.innerHTML = state.lineItems.map((item, i) => `
    <tr class="item-row" data-idx="${i}">
      <td class="col-desc"><input type="text" value="${esc(item.description)}" placeholder="Descripcion del servicio/producto" oninput="updateItem(${i},'description',this.value)"></td>
      <td class="col-qty"><input type="number" value="${item.quantity}" min="0" step=".01" oninput="updateItem(${i},'quantity',this.value)"></td>
      <td class="col-price"><input type="number" value="${item.unit_price}" min="0" step=".01" placeholder="0.00" oninput="updateItem(${i},'unit_price',this.value)"></td>
      <td class="col-total"><strong>${fmt(item.total)}</strong></td>
      <td class="col-del"><button class="btn-remove-item" onclick="removeLineItem(${i})" title="Eliminar">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button></td>
    </tr>
  `).join('');
}

function updateItem(idx, field, value) {
  state.lineItems[idx][field] = field === 'description' ? value : parseFloat(value) || 0;
  if (field !== 'description') {
    state.lineItems[idx].total = state.lineItems[idx].quantity * state.lineItems[idx].unit_price;
    // Update total display in row
    const rows = document.querySelectorAll('.item-row');
    if (rows[idx]) {
      const totalCell = rows[idx].querySelector('.col-total strong');
      if (totalCell) totalCell.textContent = fmt(state.lineItems[idx].total);
    }
    recalculate();
  }
}

function recalculate() {
  const subtotal = state.lineItems.reduce((s, i) => s + (i.total || 0), 0);
  const taxRate = parseFloat(val('input-tax')) || 0;
  const taxLabel = val('input-tax-label') || 'Tax';
  const tax2Rate = parseFloat(val('input-tax2')) || 0;
  const tax2Label = val('input-tax2-label') || 'Tax 2';
  const discount = parseFloat(val('input-discount')) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const taxAmt = taxable * (taxRate / 100);
  const tax2Amt = taxable * (tax2Rate / 100);
  const total = taxable + taxAmt + tax2Amt;

  document.getElementById('display-subtotal').textContent = fmt(subtotal);
  document.getElementById('display-discount').textContent = '-' + fmt(discount);
  document.getElementById('display-tax-label').textContent = taxLabel;
  document.getElementById('display-tax-pct').textContent = taxRate;
  document.getElementById('display-tax').textContent = fmt(taxAmt);
  const tax2Row = document.getElementById('display-tax2-row');
  if (tax2Row) tax2Row.style.display = tax2Rate > 0 ? 'flex' : 'none';
  document.getElementById('display-tax2-label').textContent = tax2Label;
  document.getElementById('display-tax2-pct').textContent = tax2Rate;
  document.getElementById('display-tax2').textContent = fmt(tax2Amt);
  document.getElementById('display-total').textContent = fmt(total);
}

function updateStatusBadge() {
  const status = val('editor-status');
  const badge = document.getElementById('editor-status-badge');
  if (!status) { badge.className = 'badge'; badge.textContent = ''; return; }
  badge.className = 'badge badge-' + status;
  badge.textContent = statusLabel(status);
}

function updatePoliciesToggle() {} // no extra logic needed

// ============================================================
// SAVE DOCUMENT
// ============================================================
async function saveDocument() {
  const clientId = val('editor-client');
  if (!clientId) { toast('Selecciona un cliente.', 'error'); return; }
  if (state.lineItems.length === 0) { toast('Agrega al menos un servicio.', 'error'); return; }

  const subtotal = state.lineItems.reduce((s, i) => s + (i.total || 0), 0);
  const taxRate = parseFloat(val('input-tax')) || 0;
  const tax2Rate = parseFloat(val('input-tax2')) || 0;
  const discount = parseFloat(val('input-discount')) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const taxAmt = taxable * (taxRate / 100);
  const tax2Amt = taxable * (tax2Rate / 100);
  const total = taxable + taxAmt + tax2Amt;

  const isQuote = state.currentDocType === 'quote';
  const payload = {
    company_id: state.company.id,
    client_id: clientId,
    type: state.currentDocType,
    number: document.getElementById('editor-number').textContent,
    status: val('editor-status'),
    issue_date: val('editor-issue-date'),
    [isQuote ? 'valid_until' : 'due_date']: val('editor-date2'),
    subtotal,
    tax_rate: taxRate,
    tax_label: val('input-tax-label').trim(),
    tax_amount: taxAmt,
    tax2_rate: tax2Rate,
    tax2_label: val('input-tax2-label').trim(),
    tax2_amount: tax2Amt,
    discount,
    total,
    notes: val('editor-notes').trim(),
    terms: val('editor-terms').trim(),
    po_number: val('editor-po-number').trim(),
    internal_notes: val('editor-internal-notes').trim(),
    include_policies: document.getElementById('editor-policies').checked,
  };

  let invoiceId = state.currentDoc?.id;

  if (invoiceId) {
    const { error } = await db.from('invoices').update(payload).eq('id', invoiceId);
    if (error) { toast('Error al guardar: ' + error.message, 'error'); return; }
  } else {
    const { data, error } = await db.from('invoices').insert(payload).select().single();
    if (error) { toast('Error al guardar: ' + error.message, 'error'); return; }
    invoiceId = data.id;
    state.currentDoc = data;
  }

  // Save items
  await db.from('invoice_items').delete().eq('invoice_id', invoiceId);
  if (state.lineItems.length > 0) {
    const itemsPayload = state.lineItems.map((item, i) => ({
      invoice_id: invoiceId,
      description: item.description,
      quantity: item.quantity,
      unit_price: item.unit_price,
      total: item.total,
      sort_order: i,
    }));
    await db.from('invoice_items').insert(itemsPayload);
  }

  toast('Documento guardado.', 'success');
  await loadAllData();
  updateBadges();
}

// ============================================================
// EDIT DOCUMENT
// ============================================================
async function editDocument(id, type) {
  navigate('invoice-editor', { type, id });
}

// ============================================================
// DELETE DOCUMENT
// ============================================================
function confirmDelete(id, type) {
  document.getElementById('confirm-message').textContent = 'Estas seguro de que quieres eliminar este documento? Esta accion no se puede deshacer.';
  document.getElementById('confirm-action-btn').onclick = () => deleteDocument(id, type);
  openModal('modal-confirm');
}

async function deleteDocument(id, type) {
  await db.from('invoices').delete().eq('id', id);
  closeModal('modal-confirm');
  toast('Documento eliminado.', 'success');
  await loadAllData();
  if (type === 'invoice') renderInvoicesList();
  else renderQuotesList();
}

// ============================================================
// CONVERT QUOTE TO INVOICE
// ============================================================
async function convertQuoteToInvoice() {
  if (!state.currentDoc) return;
  const num = await getNextNumber('invoice');
  const payload = {
    company_id: state.company.id,
    client_id: state.currentDoc.client_id,
    type: 'invoice',
    number: num,
    status: '',
    issue_date: new Date().toISOString().split('T')[0],
    due_date: new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
    subtotal: state.currentDoc.subtotal,
    tax_rate: state.currentDoc.tax_rate,
    tax_amount: state.currentDoc.tax_amount,
    discount: state.currentDoc.discount,
    total: state.currentDoc.total,
    notes: state.currentDoc.notes,
    terms: state.currentDoc.terms,
    include_policies: state.currentDoc.include_policies,
  };

  const { data: newInv, error } = await db.from('invoices').insert(payload).select().single();
  if (error) { toast('Error: ' + error.message, 'error'); return; }

  // Copy items
  const { data: items } = await db.from('invoice_items').select('*').eq('invoice_id', state.currentDoc.id);
  if (items?.length) {
    await db.from('invoice_items').insert(items.map(({ id, invoice_id, ...i }) => ({ ...i, invoice_id: newInv.id })));
  }

  // Mark quote as accepted
  await db.from('invoices').update({ status: 'accepted' }).eq('id', state.currentDoc.id);

  toast('Cotizacion convertida a factura ' + num, 'success');
  await loadAllData();
  navigate('invoice-editor', { type: 'invoice', id: newInv.id });
}

// ============================================================
// CLIENTS
// ============================================================
function renderClientsList() {
  show('view-clients');
  renderClientsTable(state.clients);
  document.getElementById('search-clients').value = '';
}

function filterClients() {
  const q = val('search-clients').toLowerCase();
  const filtered = state.clients.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.email || '').toLowerCase().includes(q) ||
    (c.phone || '').includes(q)
  );
  renderClientsTable(filtered);
}

function renderClientsTable(list) {
  const tbody = document.getElementById('clients-table-body');
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="table-empty"><svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>No se encontraron clientes.</p></td></tr>';
    return;
  }
  tbody.innerHTML = list.map(c => {
    const invoiceCount = state.invoices.filter(i => i.client_id === c.id).length;
    return `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td>${esc(c.email || '—')}</td>
        <td>${esc(c.phone || '—')}</td>
        <td>${esc(c.city || '—')}</td>
        <td><span class="badge badge-draft">${invoiceCount}</span></td>
        <td class="col-actions">
          <button class="btn btn-ghost btn-sm btn-icon" onclick="openClientModal('${c.id}')">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmDeleteClient('${c.id}')" style="color:var(--danger)">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function openClientModal(id = null, fromEditor = false) {
  document.getElementById('client-id').value = id || '';
  document.getElementById('client-modal-title').textContent = id ? 'Editar Cliente' : 'Nuevo Cliente';
  ['name','email','phone','address','city','state','zip','notes'].forEach(f => {
    document.getElementById('client-' + f).value = '';
  });
  if (id) {
    const c = state.clients.find(c => c.id === id);
    if (c) {
      document.getElementById('client-name').value = c.name || '';
      document.getElementById('client-email').value = c.email || '';
      document.getElementById('client-phone').value = c.phone || '';
      document.getElementById('client-address').value = c.address || '';
      document.getElementById('client-city').value = c.city || '';
      document.getElementById('client-state').value = c.state || '';
      document.getElementById('client-zip').value = c.zip || '';
      document.getElementById('client-notes').value = c.notes || '';
    }
  }
  document.getElementById('modal-client').dataset.fromEditor = fromEditor;
  openModal('modal-client');
}

async function saveClient() {
  const name = val('client-name').trim();
  if (!name) { toast('El nombre del cliente es requerido.', 'error'); return; }

  const payload = {
    company_id: state.company.id,
    name,
    email: val('client-email').trim(),
    phone: val('client-phone').trim(),
    address: val('client-address').trim(),
    city: val('client-city').trim(),
    state: val('client-state').trim(),
    zip: val('client-zip').trim(),
    notes: val('client-notes').trim(),
  };

  const existingId = val('client-id');
  if (existingId) {
    await db.from('clients').update(payload).eq('id', existingId);
    toast('Cliente actualizado.', 'success');
  } else {
    const { data, error } = await db.from('clients').insert(payload).select().single();
    if (error) { toast('Error: ' + error.message, 'error'); return; }
    toast('Cliente guardado.', 'success');
    // If opened from editor, select new client
    if (document.getElementById('modal-client').dataset.fromEditor === 'true') {
      state.clients.push(data);
      populateClientDropdown();
      document.getElementById('editor-client').value = data.id;
      onClientChange();
    }
  }

  closeModal('modal-client');
  await loadAllData();
  if (document.getElementById('view-clients').classList.contains('hidden') === false) {
    renderClientsList();
  }
}

function confirmDeleteClient(id) {
  document.getElementById('confirm-message').textContent = 'Eliminar este cliente? No se eliminaran sus facturas.';
  document.getElementById('confirm-action-btn').onclick = async () => {
    await db.from('clients').delete().eq('id', id);
    closeModal('modal-confirm');
    toast('Cliente eliminado.', 'success');
    await loadAllData();
    renderClientsList();
  };
  openModal('modal-confirm');
}

// ============================================================
// EXPENSES
// ============================================================
const EXPENSE_CATEGORIES = {
  materials: 'Materiales', labor: 'Mano de obra', equipment: 'Equipos',
  travel: 'Transporte', office: 'Oficina', other: 'Otro',
};

function renderExpensesList() {
  show('view-expenses');
  document.getElementById('search-expenses').value = '';
  document.getElementById('filter-expense-category').value = '';
  renderExpensesTable(state.expenses);
}

function filterExpenses() {
  const q = val('search-expenses').toLowerCase();
  const cat = val('filter-expense-category');
  const filtered = state.expenses.filter(e =>
    (!q || (e.description || '').toLowerCase().includes(q) || (e.notes || '').toLowerCase().includes(q)) &&
    (!cat || e.category === cat)
  );
  renderExpensesTable(filtered);
}

function renderExpensesTable(list) {
  const tbody = document.getElementById('expenses-table-body');
  const totalEl = document.getElementById('expenses-total');
  const total = list.reduce((s, e) => s + Number(e.amount), 0);
  if (totalEl) totalEl.textContent = fmt(total);
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty"><p>No hay gastos registrados.</p></td></tr>';
    return;
  }
  tbody.innerHTML = list.map(e => `
    <tr>
      <td>${fmtDate(e.date)}</td>
      <td><strong>${esc(e.description || '—')}</strong>${e.notes ? `<br><span style="font-size:.75rem;color:var(--text-muted)">${esc(e.notes)}</span>` : ''}</td>
      <td><span class="badge badge-draft">${esc(EXPENSE_CATEGORIES[e.category] || e.category)}</span></td>
      <td><strong>${fmt(e.amount)}</strong></td>
      <td class="col-actions">
        <button class="btn btn-ghost btn-sm btn-icon" onclick="openExpenseModal('${e.id}')">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="confirmDeleteExpense('${e.id}')" style="color:var(--danger)">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </td>
    </tr>
  `).join('');
}

function openExpenseModal(id) {
  document.getElementById('expense-id').value = id || '';
  document.getElementById('expense-modal-title').textContent = id ? 'Editar Gasto' : 'Nuevo Gasto';
  document.getElementById('expense-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('expense-description').value = '';
  document.getElementById('expense-category').value = 'materials';
  document.getElementById('expense-amount').value = '';
  document.getElementById('expense-notes').value = '';
  if (id) {
    const e = state.expenses.find(x => x.id === id);
    if (e) {
      document.getElementById('expense-date').value = e.date || '';
      document.getElementById('expense-description').value = e.description || '';
      document.getElementById('expense-category').value = e.category || 'other';
      document.getElementById('expense-amount').value = e.amount || '';
      document.getElementById('expense-notes').value = e.notes || '';
    }
  }
  openModal('modal-expense');
}

async function saveExpense() {
  const description = val('expense-description').trim();
  if (!description) { toast('La descripcion es requerida.', 'error'); return; }
  const amount = parseFloat(val('expense-amount'));
  if (!amount || amount <= 0) { toast('Ingresa un monto valido.', 'error'); return; }

  const payload = {
    company_id: state.company.id,
    date: val('expense-date') || new Date().toISOString().split('T')[0],
    description,
    category: val('expense-category'),
    amount,
    notes: val('expense-notes').trim(),
  };

  const id = val('expense-id');
  if (id) {
    const { error } = await db.from('expenses').update(payload).eq('id', id);
    if (error) { toast('Error: ' + error.message, 'error'); return; }
  } else {
    const { error } = await db.from('expenses').insert(payload);
    if (error) { toast('Error: ' + error.message, 'error'); return; }
  }

  closeModal('modal-expense');
  toast('Gasto guardado.', 'success');
  const { data } = await db.from('expenses').select('*').eq('company_id', state.company.id).order('date', { ascending: false });
  state.expenses = data || [];
  renderExpensesTable(state.expenses);
}

function confirmDeleteExpense(id) {
  document.getElementById('confirm-message').textContent = 'Estas seguro de que quieres eliminar este gasto?';
  document.getElementById('confirm-action-btn').onclick = () => deleteExpense(id);
  openModal('modal-confirm');
}

async function deleteExpense(id) {
  await db.from('expenses').delete().eq('id', id);
  closeModal('modal-confirm');
  toast('Gasto eliminado.', 'success');
  state.expenses = state.expenses.filter(e => e.id !== id);
  renderExpensesTable(state.expenses);
}

// ============================================================
// SETTINGS
// ============================================================
function loadSettings() {
  const c = state.company;
  if (!c) return;
  setValue('cfg-name', c.name);
  setValue('cfg-phone', c.phone);
  setValue('cfg-email', c.email);
  setValue('cfg-address', c.address);
  setValue('cfg-city', c.city);
  setValue('cfg-state', c.state);
  setValue('cfg-zip', c.zip);
  setValue('cfg-license', c.license_number);
  setValue('cfg-taxid', c.tax_id);
  setValue('cfg-website', c.website);
  setValue('cfg-industry', c.industry || 'general');
  setValue('cfg-tax', c.default_tax_rate);
  setValue('cfg-payment-terms', c.default_payment_terms || 'Net 30');
  document.getElementById('cfg-show-policies').checked = c.show_policies || false;
  setValue('cfg-policy-text', c.policy_text || '');
  show('view-settings');
}

async function saveSettings() {
  const name = val('cfg-name').trim();
  if (!name) { toast('El nombre de la empresa es requerido.', 'error'); return; }

  const payload = {
    name,
    phone: val('cfg-phone').trim(),
    email: val('cfg-email').trim(),
    address: val('cfg-address').trim(),
    city: val('cfg-city').trim(),
    state: val('cfg-state').trim(),
    zip: val('cfg-zip').trim(),
    license_number: val('cfg-license').trim(),
    tax_id: val('cfg-taxid').trim(),
    website: val('cfg-website').trim(),
    industry: val('cfg-industry'),
    default_tax_rate: parseFloat(val('cfg-tax')) || 0,
    default_payment_terms: val('cfg-payment-terms').trim(),
    show_policies: document.getElementById('cfg-show-policies').checked,
    policy_text: val('cfg-policy-text').trim(),
  };

  const { data, error } = await db.from('companies').update(payload).eq('id', state.company.id).select().single();
  if (error) { toast('Error: ' + error.message, 'error'); return; }
  state.company = data;
  toast('Configuracion guardada.', 'success');
  updateSidebarUser();
}

// ============================================================
// REPORTS
// ============================================================
async function loadReports() {
  const year = parseInt(val('report-year'));
  const monthVal = val('report-month');
  const month = monthVal !== '' ? parseInt(monthVal) : null;

  let filtered = state.invoices.filter(inv => {
    const d = new Date(inv.issue_date);
    if (d.getFullYear() !== year) return false;
    if (month !== null && d.getMonth() !== month) return false;
    return true;
  });

  // Stats
  const total = filtered.reduce((s, i) => s + Number(i.total), 0);
  const paid = filtered.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);
  const pending = filtered.filter(i => i.status === 'sent').reduce((s, i) => s + Number(i.total), 0);
  const cancelled = filtered.filter(i => i.status === 'cancelled').reduce((s, i) => s + Number(i.total), 0);

  document.getElementById('report-stats').innerHTML = `
    <div class="stat-card"><div class="stat-icon blue"><svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg></div><div class="stat-info"><div class="stat-value">${fmt(total)}</div><div class="stat-label">Total Facturado</div></div></div>
    <div class="stat-card"><div class="stat-icon green"><svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div><div class="stat-info"><div class="stat-value">${fmt(paid)}</div><div class="stat-label">Cobrado</div></div></div>
    <div class="stat-card"><div class="stat-icon amber"><svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></div><div class="stat-info"><div class="stat-value">${fmt(pending)}</div><div class="stat-label">Pendiente</div></div></div>
    <div class="stat-card"><div class="stat-icon red"><svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div><div class="stat-info"><div class="stat-value">${fmt(cancelled)}</div><div class="stat-label">Cancelado</div></div></div>
  `;

  // Monthly chart
  renderMonthlyChart(year);
  renderStatusChart(filtered);

  // Detail table
  const tbody = document.getElementById('report-invoices-body');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="table-empty"><p>No hay facturas en este periodo.</p></td></tr>';
  } else {
    tbody.innerHTML = filtered.map(inv => `
      <tr>
        <td><strong style="color:var(--primary)">${esc(inv.number)}</strong></td>
        <td>${esc(inv.clients?.name || '—')}</td>
        <td>${fmtDate(inv.issue_date)}</td>
        <td>${fmt(inv.subtotal)}</td>
        <td>${fmt(inv.tax_amount)}</td>
        <td><strong>${fmt(inv.total)}</strong></td>
        <td>${statusBadge(inv.status)}</td>
      </tr>
    `).join('');
  }
}

function renderMonthlyChart(year) {
  const canvas = document.getElementById('chart-monthly');
  if (!canvas) return;
  if (state.charts.monthly) state.charts.monthly.destroy();

  const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const data = MONTHS.map((_, m) =>
    state.invoices
      .filter(i => { const d = new Date(i.issue_date); return d.getFullYear() === year && d.getMonth() === m; })
      .reduce((s, i) => s + Number(i.total), 0)
  );

  state.charts.monthly = new Chart(canvas, {
    type: 'line',
    data: {
      labels: MONTHS,
      datasets: [{
        label: 'Ingresos',
        data,
        borderColor: '#1e40af',
        backgroundColor: 'rgba(30,64,175,.08)',
        borderWidth: 2.5,
        pointBackgroundColor: '#1e40af',
        pointRadius: 4,
        fill: true,
        tension: .4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() }, grid: { color: '#f1f5f9' } },
        x: { grid: { display: false } }
      }
    }
  });
}

function renderStatusChart(filtered) {
  const canvas = document.getElementById('chart-status');
  if (!canvas) return;
  if (state.charts.status) state.charts.status.destroy();

  const counts = {
    draft: filtered.filter(i => i.status === 'draft').length,
    sent: filtered.filter(i => i.status === 'sent').length,
    paid: filtered.filter(i => i.status === 'paid').length,
    cancelled: filtered.filter(i => i.status === 'cancelled').length,
  };

  state.charts.status = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Borrador', 'Enviadas', 'Pagadas', 'Canceladas'],
      datasets: [{
        data: [counts.draft, counts.sent, counts.paid, counts.cancelled],
        backgroundColor: ['#94a3b8','#0284c7','#059669','#dc2626'],
        borderWidth: 0,
        hoverOffset: 8,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, font: { size: 13 } } },
      },
      cutout: '65%',
    }
  });
}

async function exportReportPDF() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape' });
  const year = val('report-year');
  const monthVal = val('report-month');
  const month = monthVal !== '' ? parseInt(monthVal) : null;
  const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

  const filtered = state.invoices.filter(inv => {
    const d = new Date(inv.issue_date);
    if (d.getFullYear() !== parseInt(year)) return false;
    if (month !== null && d.getMonth() !== month) return false;
    return true;
  });

  doc.setFontSize(20);
  doc.setTextColor(0, 0, 0);
  doc.text(state.company.name, 14, 20);
  doc.setFontSize(14);
  doc.setTextColor(100);
  doc.text('Reporte de Facturas — ' + (month !== null ? MONTHS[month] + ' ' : '') + year, 14, 30);

  const total = filtered.reduce((s, i) => s + Number(i.total), 0);
  const paid = filtered.filter(i => i.status === 'paid').reduce((s, i) => s + Number(i.total), 0);
  doc.setFontSize(11);
  doc.setTextColor(30);
  doc.text(`Total Facturado: ${fmtRaw(total)}   |   Cobrado: ${fmtRaw(paid)}   |   Facturas: ${filtered.length}`, 14, 40);

  doc.autoTable({
    startY: 48,
    head: [['Numero','Cliente','Fecha','Subtotal','Tax','Total','Estado']],
    body: filtered.map(inv => [
      inv.number, inv.clients?.name || '—', fmtDate(inv.issue_date),
      fmtRaw(inv.subtotal), fmtRaw(inv.tax_amount), fmtRaw(inv.total), statusLabel(inv.status)
    ]),
    headStyles: { fillColor: [20, 20, 20], fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  doc.save(`reporte-${year}${month !== null ? '-' + String(month + 1).padStart(2,'0') : ''}.pdf`);
  toast('Reporte exportado.', 'success');
}

// ============================================================
// PDF GENERATION (jsPDF)
// ============================================================
async function buildDocumentData() {
  const clientId = val('editor-client');
  const client = state.clients.find(c => c.id === clientId) || {};
  const isQuote = state.currentDocType === 'quote';
  const subtotal = state.lineItems.reduce((s, i) => s + (i.total || 0), 0);
  const taxRate = parseFloat(val('input-tax')) || 0;
  const taxLabel = val('input-tax-label') || 'Tax';
  const tax2Rate = parseFloat(val('input-tax2')) || 0;
  const tax2Label = val('input-tax2-label') || 'Tax 2';
  const discount = parseFloat(val('input-discount')) || 0;
  const taxable = Math.max(0, subtotal - discount);
  const taxAmt = taxable * (taxRate / 100);
  const tax2Amt = taxable * (tax2Rate / 100);
  const total = taxable + taxAmt + tax2Amt;

  return {
    company: state.company,
    client,
    type: state.currentDocType,
    number: document.getElementById('editor-number').textContent,
    status: val('editor-status'),
    issueDate: val('editor-issue-date'),
    date2: val('editor-date2'),
    items: state.lineItems,
    subtotal, taxRate, taxLabel, taxAmt, tax2Rate, tax2Label, tax2Amt, discount, total,
    notes: val('editor-notes'),
    terms: val('editor-terms'),
    poNumber: val('editor-po-number'),
    includePolicies: document.getElementById('editor-policies').checked,
    isQuote,
  };
}

function buildHTMLPreview(d) {
  const comp = d.company;
  const compAddr = [comp.address, comp.city, comp.state, comp.zip].filter(Boolean).join(', ');
  const clientAddr = [d.client.address, d.client.city, d.client.state, d.client.zip].filter(Boolean).join(', ');
  const docLabel = d.isQuote ? 'COTIZACION' : 'FACTURA';

  const itemRows = d.items.map((item, i) => `
    <tr>
      <td class="inv2-c">${i + 1}</td>
      <td>${esc(item.description || '—')}</td>
      <td class="inv2-c">${item.quantity}</td>
      <td class="inv2-r">${fmt(item.unit_price)}</td>
      <td class="inv2-r inv2-b">${fmt(item.total)}</td>
    </tr>`).join('');

  const subtotalRows = [
    ['SUBTOTAL', fmt(d.subtotal)],
    ...(d.discount > 0 ? [['DESCUENTO', '-' + fmt(d.discount)]] : []),
    ...(d.taxRate > 0 ? [[esc(d.taxLabel) + ' (' + d.taxRate + '%)', fmt(d.taxAmt)]] : []),
    ...(d.tax2Rate > 0 ? [[esc(d.tax2Label) + ' (' + d.tax2Rate + '%)', fmt(d.tax2Amt)]] : []),
  ].map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join('');

  return `
  <div class="inv2-doc">
    <div class="inv2-header">
      <div class="inv2-co-name">${esc(comp.name)}</div>
      ${compAddr ? `<div class="inv2-co-sub">${esc(compAddr)}</div>` : ''}
      ${(comp.phone || comp.email) ? `<div class="inv2-co-sub">${[comp.phone ? esc(comp.phone) : '', comp.email ? esc(comp.email) : ''].filter(Boolean).join(' &nbsp;&middot;&nbsp; ')}</div>` : ''}
      ${comp.license_number ? `<div class="inv2-co-sub">Lic: ${esc(comp.license_number)}</div>` : ''}
    </div>
    <table class="inv2-meta-row">
      <thead><tr>
        <th>FECHA EMISION</th><th>NUMERO</th>
        <th>${d.isQuote ? 'VALIDA HASTA' : 'FECHA VENCE'}</th><th>TIPO</th>
      </tr></thead>
      <tbody><tr>
        <td>${fmtDate(d.issueDate)}</td>
        <td class="inv2-b">${esc(d.number)}</td>
        <td>${fmtDate(d.date2)}</td>
        <td class="inv2-b">${docLabel}</td>
      </tr></tbody>
    </table>
    <table class="inv2-bill-row">
      <tbody><tr>
        <td class="inv2-bill-lbl">FACTURAR<br>A</td>
        <td class="inv2-bill-info">
          ${d.client.name ? `<strong>${esc(d.client.name)}</strong>` : '—'}
          ${d.client.phone ? `<br>${esc(d.client.phone)}` : ''}
          ${d.client.email ? `<br>${esc(d.client.email)}` : ''}
          ${clientAddr ? `<br>${esc(clientAddr)}` : ''}
        </td>
        <td class="inv2-bill-extra">
          ${d.terms ? `<div><span class="inv2-lbl">TERMINOS:</span> ${esc(d.terms)}</div>` : ''}
          ${d.poNumber ? `<div><span class="inv2-lbl">PO#:</span> ${esc(d.poNumber)}</div>` : ''}
          ${comp.tax_id ? `<div><span class="inv2-lbl">TAX ID:</span> ${esc(comp.tax_id)}</div>` : ''}
          ${d.status ? `<div><span class="inv2-lbl">ESTADO:</span> ${esc(d.status.toUpperCase())}</div>` : ''}
        </td>
      </tr></tbody>
    </table>
    <table class="inv2-items">
      <thead><tr>
        <th style="width:36px">#</th>
        <th>DESCRIPCION</th>
        <th style="width:60px">CANT.</th>
        <th style="width:110px">PRECIO UNIT.</th>
        <th style="width:110px">TOTAL</th>
      </tr></thead>
      <tbody>${itemRows}</tbody>
    </table>
    <table class="inv2-foot-row">
      <tbody><tr>
        <td class="inv2-foot-notes">
          ${d.notes ? `<div class="inv2-foot-lbl">NOTAS</div><div class="inv2-foot-text">${esc(d.notes)}</div>` : ''}
          ${d.includePolicies && comp.policy_text ? `<div class="inv2-foot-lbl" style="margin-top:8px">POLITICAS</div><div class="inv2-foot-text">${esc(comp.policy_text)}</div>` : ''}
        </td>
        <td class="inv2-foot-totals">
          <table class="inv2-totals">
            <tbody>${subtotalRows}</tbody>
            <tbody><tr class="inv2-grand"><td>TOTAL</td><td>${fmt(d.total)}</td></tr></tbody>
          </table>
        </td>
      </tr></tbody>
    </table>
    <div class="inv2-sig-row">Received by X <span class="inv2-sig-line"></span></div>
  </div>`;
}

async function previewDocument() {
  const d = await buildDocumentData();
  document.getElementById('invoice-preview').innerHTML = buildHTMLPreview(d);
  openModal('modal-preview');
}

async function downloadPDF() {
  const d = await buildDocumentData();
  const { jsPDF } = window.jspdf;
  const pdfDoc = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'portrait' });

  const comp = d.company;
  const compAddr = [comp.address, comp.city, comp.state, comp.zip].filter(Boolean).join(', ');
  const clientAddr = [d.client.address, d.client.city, d.client.state, d.client.zip].filter(Boolean).join(', ');
  const pageW = pdfDoc.internal.pageSize.getWidth();
  const margin = 18;
  const col2x = pageW / 2 + 4;
  let y = 18;

  // Header — compact black bar
  const headerH = 30;
  pdfDoc.setFillColor(20, 20, 20);
  pdfDoc.rect(0, 0, pageW, headerH, 'F');

  // Left: company info
  pdfDoc.setFontSize(14);
  pdfDoc.setFont('helvetica', 'bold');
  pdfDoc.setTextColor(255, 255, 255);
  pdfDoc.text(comp.name, margin, 11);

  const infoLine1 = [comp.address ? compAddr : null, comp.phone ? 'Tel: ' + comp.phone : null].filter(Boolean).join('   ');
  const infoLine2 = [comp.email, comp.license_number ? 'Lic: ' + comp.license_number : null].filter(Boolean).join('   ');
  pdfDoc.setFontSize(7.5);
  pdfDoc.setFont('helvetica', 'normal');
  pdfDoc.setTextColor(200, 200, 200);
  if (infoLine1) pdfDoc.text(infoLine1, margin, 18);
  if (infoLine2) pdfDoc.text(infoLine2, margin, 24);

  // Right: invoice type + number + dates
  const label = d.isQuote ? 'COTIZACION' : 'FACTURA';
  pdfDoc.setFontSize(18);
  pdfDoc.setFont('helvetica', 'bold');
  pdfDoc.setTextColor(255, 255, 255);
  pdfDoc.text(label, pageW - margin, 11, { align: 'right' });
  pdfDoc.setFontSize(10);
  pdfDoc.setTextColor(180, 180, 180);
  pdfDoc.text(d.number, pageW - margin, 18, { align: 'right' });
  pdfDoc.setFontSize(7.5);
  pdfDoc.text('Fecha: ' + fmtDate(d.issueDate) + '   ' + (d.isQuote ? 'Valida: ' : 'Vence: ') + fmtDate(d.date2), pageW - margin, 24, { align: 'right' });

  y = 38;

  // Bill To
  pdfDoc.setFillColor(240, 240, 240);
  pdfDoc.roundedRect(margin - 2, y, pageW / 2 - margin - 2, 36, 2, 2, 'F');
  pdfDoc.setFontSize(8);
  pdfDoc.setFont('helvetica', 'bold');
  pdfDoc.setTextColor(0, 0, 0);
  pdfDoc.text('FACTURAR A', margin + 2, y + 7);
  pdfDoc.setFont('helvetica', 'bold');
  pdfDoc.setFontSize(10);
  pdfDoc.setTextColor(30, 30, 30);
  pdfDoc.text(d.client.name || '—', margin + 2, y + 14);
  pdfDoc.setFont('helvetica', 'normal');
  pdfDoc.setFontSize(8.5);
  pdfDoc.setTextColor(80);
  let ci = y + 20;
  if (d.client.email) { pdfDoc.text(d.client.email, margin + 2, ci); ci += 5; }
  if (d.client.phone) { pdfDoc.text(d.client.phone, margin + 2, ci); ci += 5; }
  if (clientAddr) pdfDoc.text(clientAddr, margin + 2, ci);

  // Payment Terms + PO (right)
  {
    const lines = [];
    if (d.terms) lines.push(['TERMINOS', d.terms]);
    if (d.poNumber) lines.push(['PO#', d.poNumber]);
    if (lines.length) {
      const boxH = lines.length * 12 + 8;
      pdfDoc.setFillColor(240, 240, 240);
      pdfDoc.roundedRect(col2x, y, pageW - col2x - margin + 2, boxH, 2, 2, 'F');
      let ly = y + 7;
      lines.forEach(([lbl, val]) => {
        pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'bold'); pdfDoc.setTextColor(0, 0, 0);
        pdfDoc.text(lbl, col2x + 4, ly);
        pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(9); pdfDoc.setTextColor(30);
        pdfDoc.text(val, col2x + 4, ly + 6);
        ly += 13;
      });
    }
  }

  y += 44;

  // Line items table
  pdfDoc.autoTable({
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Descripcion', 'Cant.', 'Precio Unit.', 'Total']],
    body: d.items.map(item => [
      item.description || '—',
      item.quantity,
      fmtRaw(item.unit_price),
      fmtRaw(item.total),
    ]),
    headStyles: { fillColor: [20, 20, 20], textColor: 255, fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 9, textColor: [30, 30, 30] },
    alternateRowStyles: { fillColor: [242, 242, 242] },
    columnStyles: { 0: { cellWidth: 'auto' }, 1: { halign: 'center', cellWidth: 18 }, 2: { halign: 'right', cellWidth: 30 }, 3: { halign: 'right', cellWidth: 28 } },
  });

  y = pdfDoc.lastAutoTable.finalY + 6;

  // Totals
  const tw = 75;
  const tx = pageW - margin - tw;
  const totalsData = [
    ['Subtotal', fmtRaw(d.subtotal)],
    ...(d.discount > 0 ? [['Descuento', '-' + fmtRaw(d.discount)]] : []),
    ...(d.taxRate > 0 ? [[d.taxLabel + ' (' + d.taxRate + '%)', fmtRaw(d.taxAmt)]] : []),
    ...(d.tax2Rate > 0 ? [[d.tax2Label + ' (' + d.tax2Rate + '%)', fmtRaw(d.tax2Amt)]] : []),
  ];
  totalsData.forEach(([label, value]) => {
    pdfDoc.setFontSize(9);
    pdfDoc.setFont('helvetica', 'normal');
    pdfDoc.setTextColor(80);
    pdfDoc.text(label, tx + 4, y + 5);
    pdfDoc.text(value, tx + tw - 4, y + 5, { align: 'right' });
    pdfDoc.setDrawColor(226, 232, 240);
    pdfDoc.line(tx, y + 8, tx + tw, y + 8);
    y += 9;
  });
  // Grand total
  pdfDoc.setFillColor(20, 20, 20);
  pdfDoc.roundedRect(tx, y, tw, 12, 2, 2, 'F');
  pdfDoc.setFontSize(10.5);
  pdfDoc.setFont('helvetica', 'bold');
  pdfDoc.setTextColor(255, 255, 255);
  pdfDoc.text('TOTAL', tx + 4, y + 8);
  pdfDoc.text(fmtRaw(d.total), tx + tw - 4, y + 8, { align: 'right' });

  y += 18;

  // Notes
  if (d.notes) {
    pdfDoc.setFontSize(8.5);
    pdfDoc.setFont('helvetica', 'bold');
    pdfDoc.setTextColor(0, 0, 0);
    pdfDoc.text('NOTAS', margin, y);
    pdfDoc.setFont('helvetica', 'normal');
    pdfDoc.setTextColor(80);
    pdfDoc.text(pdfDoc.splitTextToSize(d.notes, pageW - margin * 2), margin, y + 6);
    y += 6 + pdfDoc.splitTextToSize(d.notes, pageW - margin * 2).length * 5;
  }

  // Policies
  if (d.includePolicies && comp.policy_text) {
    y += 4;
    pdfDoc.setFillColor(245, 245, 245);
    const policyLines = pdfDoc.splitTextToSize(comp.policy_text, pageW - margin * 2 - 8);
    pdfDoc.roundedRect(margin - 2, y, pageW - margin * 2 + 4, policyLines.length * 5 + 14, 2, 2, 'F');
    pdfDoc.setFontSize(8.5);
    pdfDoc.setFont('helvetica', 'bold');
    pdfDoc.setTextColor(0, 0, 0);
    pdfDoc.text('POLITICAS DE RECLAMACION', margin + 2, y + 8);
    pdfDoc.setFont('helvetica', 'normal');
    pdfDoc.setFontSize(7.5);
    pdfDoc.setTextColor(60);
    pdfDoc.text(policyLines, margin + 2, y + 14);
    y += policyLines.length * 5 + 18;
  }

  // Footer
  const footerY = pdfDoc.internal.pageSize.getHeight() - 12;
  pdfDoc.setFontSize(7.5);
  pdfDoc.setTextColor(150);
  pdfDoc.text(comp.name + (comp.email ? '  |  ' + comp.email : ''), margin, footerY);
  pdfDoc.text('Generado por MasterInvoice Pro', pageW - margin, footerY, { align: 'right' });

  const filename = d.number.replace(/[^a-z0-9]/gi, '-') + '.pdf';
  pdfDoc.save(filename);
  toast('PDF descargado: ' + filename, 'success');
}

async function quickPDF(id, type) {
  // Load doc and build PDF without opening editor
  const list = type === 'invoice' ? state.invoices : state.quotes;
  const doc = list.find(d => d.id === id);
  if (!doc) return;

  const { data: items } = await db.from('invoice_items').select('*').eq('invoice_id', id).order('sort_order');
  const client = state.clients.find(c => c.id === doc.client_id) || {};

  // Temporarily set state
  const prevDoc = state.currentDoc;
  const prevType = state.currentDocType;
  const prevItems = state.lineItems;

  state.currentDoc = doc;
  state.currentDocType = type;
  state.lineItems = items || [];

  // Temporarily fill form values
  setValue('editor-client', doc.client_id || '');
  setValue('editor-issue-date', doc.issue_date);
  setValue('editor-date2', type === 'invoice' ? doc.due_date : doc.valid_until);
  setValue('input-tax', doc.tax_rate);
  setValue('input-discount', doc.discount);
  setValue('editor-notes', doc.notes || '');
  setValue('editor-terms', doc.terms || '');
  document.getElementById('editor-policies').checked = doc.include_policies || false;
  document.getElementById('editor-number').textContent = doc.number;
  setValue('editor-status', doc.status);

  await downloadPDF();

  state.currentDoc = prevDoc;
  state.currentDocType = prevType;
  state.lineItems = prevItems;
}

function buildPrintCopy(html, label) {
  return `
  <div class="print-copy">
    <div class="print-copy-label">${label}</div>
    ${html}
  </div>`;
}

async function printDocument() {
  const d = await buildDocumentData();
  const html = buildHTMLPreview(d);
  document.getElementById('print-area').innerHTML =
    buildPrintCopy(html, 'Customer') +
    '<div class="print-page-break"></div>' +
    buildPrintCopy(html, 'Accounting');
  window.print();
}

// ============================================================
// EMAIL
// ============================================================
async function showEmailModal() {
  const clientId = val('editor-client');
  const client = state.clients.find(c => c.id === clientId) || {};
  const isQuote = state.currentDocType === 'quote';
  const num = document.getElementById('editor-number').textContent;
  const subtotal = state.lineItems.reduce((s, i) => s + (i.total || 0), 0);
  const taxRate = parseFloat(val('input-tax')) || 0;
  const discount = parseFloat(val('input-discount')) || 0;
  const taxAmt = Math.max(0, subtotal - discount) * (taxRate / 100);
  const total = Math.max(0, subtotal - discount) + taxAmt;

  if (client.email) setValue('email-to', client.email);
  setValue('email-subject', `${isQuote ? 'Cotizacion' : 'Factura'} ${num} de ${state.company.name}`);
  setValue('email-body',
    `Estimado/a ${client.name || 'cliente'},\n\nAdjunto encontrara ${isQuote ? 'la cotizacion' : 'la factura'} ${num} por un total de ${fmt(total)}.\n\n${val('editor-notes')}\n\nGracias por su confianza.\n\n${state.company.name}\n${state.company.phone || ''}\n${state.company.email || ''}`
  );
  openModal('modal-email');
}

async function sendEmail() {
  await downloadPDF();
  const body = val('email-body');
  const subject = val('email-subject');
  const to = val('email-to');

  // Copy message to clipboard
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(`Para: ${to}\nAsunto: ${subject}\n\n${body}`);
    toast('PDF descargado. Mensaje copiado al portapapeles.', 'success');
  } else {
    toast('PDF descargado. Adjuntalo en tu email.', 'info');
  }
  closeModal('modal-email');
}

// ============================================================
// SIDEBAR (mobile)
// ============================================================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ============================================================
// MODALS
// ============================================================
function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      m.classList.remove('open');
      document.body.style.overflow = '';
    });
  }
});

// ============================================================
// TOAST
// ============================================================
function toast(msg, type = 'info') {
  const icons = {
    success: '<svg width="18" height="18" fill="none" stroke="#34d399" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="18" height="18" fill="none" stroke="#f87171" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info: '<svg width="18" height="18" fill="none" stroke="#60a5fa" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = (icons[type] || '') + `<span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideOut .2s ease forwards';
    setTimeout(() => el.remove(), 200);
  }, 3500);
}

// ============================================================
// GLOBAL SEARCH
// ============================================================
function onGlobalSearch(query) {
  const q = query.trim().toLowerCase();
  const resultsEl = document.getElementById('global-search-results');
  if (!q) { resultsEl.classList.add('hidden'); return; }

  const invMatches = state.invoices.filter(i =>
    i.number.toLowerCase().includes(q) ||
    (i.clients?.name || '').toLowerCase().includes(q) ||
    fmt(i.total).includes(q)
  ).slice(0, 5);

  const qtMatches = state.quotes.filter(i =>
    i.number.toLowerCase().includes(q) ||
    (i.clients?.name || '').toLowerCase().includes(q)
  ).slice(0, 4);

  const clMatches = state.clients.filter(c =>
    c.name.toLowerCase().includes(q) ||
    (c.email || '').toLowerCase().includes(q) ||
    (c.phone || '').includes(q)
  ).slice(0, 4);

  if (!invMatches.length && !qtMatches.length && !clMatches.length) {
    resultsEl.innerHTML = `<div class="search-no-results">No se encontraron resultados para "<strong>${esc(query)}</strong>"</div>`;
    resultsEl.classList.remove('hidden');
    return;
  }

  let html = '';

  if (invMatches.length) {
    html += `<div class="search-result-section"><div class="search-result-label">Facturas</div>`;
    html += invMatches.map(inv => `
      <button class="search-result-item" onclick="selectSearchResult('invoice','${inv.id}')">
        <div class="sri-icon inv">INV</div>
        <div class="sri-main">
          <div class="sri-title">${esc(inv.number)} — ${esc(inv.clients?.name || '—')}</div>
          <div class="sri-sub">${fmtDate(inv.issue_date)} • ${statusLabel(inv.status)}</div>
        </div>
        <span class="sri-amount">${fmt(inv.total)}</span>
      </button>
    `).join('');
    html += `</div>`;
  }

  if (qtMatches.length) {
    html += `<div class="search-result-section"><div class="search-result-label">Cotizaciones</div>`;
    html += qtMatches.map(qt => `
      <button class="search-result-item" onclick="selectSearchResult('quote','${qt.id}')">
        <div class="sri-icon qt">QT</div>
        <div class="sri-main">
          <div class="sri-title">${esc(qt.number)} — ${esc(qt.clients?.name || '—')}</div>
          <div class="sri-sub">${fmtDate(qt.issue_date)} • ${statusLabel(qt.status)}</div>
        </div>
        <span class="sri-amount">${fmt(qt.total)}</span>
      </button>
    `).join('');
    html += `</div>`;
  }

  if (clMatches.length) {
    html += `<div class="search-result-section"><div class="search-result-label">Clientes</div>`;
    html += clMatches.map(c => `
      <button class="search-result-item" onclick="selectSearchResult('client','${c.id}')">
        <div class="sri-icon cl">${c.name.charAt(0).toUpperCase()}</div>
        <div class="sri-main">
          <div class="sri-title">${esc(c.name)}</div>
          <div class="sri-sub">${esc([c.email, c.phone].filter(Boolean).join(' • ') || 'Sin contacto')}</div>
        </div>
      </button>
    `).join('');
    html += `</div>`;
  }

  resultsEl.innerHTML = html;
  resultsEl.classList.remove('hidden');
}

function selectSearchResult(type, id) {
  hideGlobalResults();
  document.getElementById('global-search-input').value = '';
  if (type === 'client') {
    navigate('clients');
    setTimeout(() => openClientModal(id), 100);
  } else {
    navigate('invoice-editor', { type, id });
  }
}

function showGlobalResults() {
  const q = document.getElementById('global-search-input').value.trim();
  if (q) document.getElementById('global-search-results').classList.remove('hidden');
}

function hideGlobalResults() {
  document.getElementById('global-search-results').classList.add('hidden');
}

// Close search on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideGlobalResults();
  // Ctrl/Cmd + K to focus search
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    document.getElementById('global-search-input')?.focus();
  }
});

// ============================================================
// HELPERS
// ============================================================
function val(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}
function setValue(id, v) {
  const el = document.getElementById(id);
  if (el) el.value = v ?? '';
}
function show(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}
function hide(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
function setLoading(id, on) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', !on);
}
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(n) {
  return '$' + (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtRaw(n) {
  return '$' + (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('T')[0].split('-');
  const MONTHS = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${parseInt(day)} ${MONTHS[parseInt(m)-1]} ${y}`;
}
function statusLabel(s) {
  const map = { draft:'Borrador', sent:'Enviado', paid:'Pagado', cancelled:'Cancelado', accepted:'Aceptado', rejected:'Rechazado' };
  return map[s] || s;
}
function statusBadge(s) {
  return `<span class="badge badge-${s}">${statusLabel(s)}</span>`;
}
