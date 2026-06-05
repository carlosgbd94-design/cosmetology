// Global Configuration Namespace (Immutable Clinical Setup)
const CONFIG = Object.freeze({
  TURSO_URL: 'https://cosmetics-prodcts-carlos-becerra.aws-us-west-2.turso.io',
  TURSO_TOKEN: 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODAyNTc5MzEsImlkIjoiMDE5ZTdmOWUtMmEwMS03OWMxLTg3N2YtN2RkY2FkZjg1ZDk5IiwicmlkIjoiM2VhNTAwMzUtMjIwZS00MWM2LWI3NjItNTM2NjQ1NzJhM2EzIn0.7-B8dPeRempyRbJBif_dZYDmoKizAwHz9F9RTv-WGNmpniIRicU3GkcENXOi2k0n1_rKfDuL69f1cLAOyeFnBg',
  PRODUCT_MAPPING: Object.freeze({
    "ID / Clave": "id",
    "Marca": "brand",
    "Nombre del Producto": "name",
    "Categoría": "category",
    "Capacidad": "capacity",
    "Precio Esteticista (MXN)": "price_aesthetic",
    "Precio Público (MXN)": "price_public",
    "Activos Clave": "active_ingredients",
    "Biotipo / Indicación": "skin_indication"
  }),
  APPARATUS_REGISTRY: Object.freeze({
    "Alta Frecuencia (Electrodo de Neón/Argón)": {
      targets: ['cicatrizacion', 'acneica', 'bactericida', 'pustulas', 'seborrea'],
      intensityRange: "Bajo - Medio (mA / Nivel)",
      defaultTime: 10
    },
    "Corriente Galvanica (Desincrustacion/Iontoforesis)": {
      targets: ['profunda', 'seborreica', 'saponificacion', 'introduccion de activos'],
      intensityRange: "0.5 - 2.0 mA",
      defaultTime: 15
    },
    "Microcorrientes (EMS / Lifting Facial)": {
      targets: ['flacidez', 'tonificacion', 'muscular', 'madura', 'lineas de expresion'],
      intensityRange: "100 - 400 uA",
      defaultTime: 20
    },
    "Radiofrecuencia Termica": {
      targets: ['colageno', 'elastina', 'reafirmacion', 'arrugas', 'densidad'],
      intensityRange: "Nivel 1 - 5 (Térmica)",
      defaultTime: 25
    },
    "Peeling Ultrasonico / Microdermabrasion": {
      targets: ['exfoliacion mecanica', 'celulas muertas', 'pigmentada', 'poros obstruidos'],
      intensityRange: "Modo Continuo / Pulsado",
      defaultTime: 15
    }
  })
});

const TURSO_URL = CONFIG.TURSO_URL;
const TURSO_TOKEN = CONFIG.TURSO_TOKEN;
const productMapping = CONFIG.PRODUCT_MAPPING;

// Mappings and State
let signaturePadEspecialista = null;
let signaturePadPaciente = null;
let savedSignatureEsp = null;
let savedSignaturePac = null;
let allProducts = [];
let allIngredientsList = [];
let uploadDataPreview = [];
let activeRipples = [];
let currentProcedureSteps = [];

// Dexie Local Database setup
const db = new Dexie('DermatiqueLocalDB');
db.version(4).stores({
  products: 'id, brand, category, name, active_ingredients, skin_indication',
  fichas_pacientes: '++id, nombre, edad, fecha, biotipo, diagnostico, condicion, protocolo, protocolo_id, firma_especialista, firma_paciente, synced, titulo_ficha, autor_ficha, pasos_preliminares, procedimiento_json',
  expedientes_clinicos: 'folio, nombre, fecha, biotipo, synced'
});

// Fuse.js Fuzzy Search state
let fuseInstance = null;

// --- Turso Hrana-over-HTTP Decoder & Encoder ---
function encodeValue(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      return { type: "integer", value: String(v) };
    }
    return { type: "float", value: v };
  }
  return { type: "text", value: String(v) };
}

function decodeValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  return v.value;
}

function decodeResultSet(result) {
  const columns = result.cols.map(c => c.name);
  return result.rows.map(row => {
    const obj = {};
    row.forEach((val, idx) => {
      obj[columns[idx]] = decodeValue(val);
    });
    return obj;
  });
}

// Executes a single SQL statement directly via Turso HTTP API
async function executeQuery(sql, args = []) {
  const hranaArgs = args.map(encodeValue);
  
  const response = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      requests: [
        {
          type: "execute",
          stmt: { sql, args: hranaArgs }
        },
        {
          type: "close"
        }
      ]
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Turso HTTP Error: ${response.status} - ${errorText}`);
  }
  
  const data = await response.json();
  const res = data.results[0];
  
  if (res.type === 'error') {
    throw new Error(res.error.message);
  }
  
  const execResult = res.response.result;
  
  return {
    rows: decodeResultSet(execResult),
    lastInsertRowid: execResult.last_insert_rowid || null
  };
}

// Executes a batch transaction directly via Turso HTTP API
async function executeBatch(statements) {
  const requests = statements.map(stmt => ({
    type: "execute",
    stmt: {
      sql: stmt.sql,
      args: (stmt.args || []).map(encodeValue)
    }
  }));
  requests.push({ type: "close" });

  const response = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Turso HTTP Batch Error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  
  for (const res of data.results) {
    if (res.type === 'error') {
      throw new Error(res.error.message);
    }
  }
  return data.results;
}

// Pricing Sanitizer
function sanitizePrice(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const cleaned = String(value).replace(/[$\s,]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

const cleanPrice = val => parseFloat(String(val).replace(/[^0-9.-]/g, '')) || 0;

async function updateSyncBadge(status) {
  const badge = document.getElementById('sync-status-badge');
  if (!badge) return;

  const dot = badge.querySelector('.sync-dot');
  const text = badge.querySelector('.badge-text');
  if (!dot || !text) return;

  // Reset classes
  badge.className = "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase backdrop-blur-md shadow-sm ml-2 transition-all";
  dot.className = "sync-dot w-1.5 h-1.5 rounded-full";

  if (status === 'syncing') {
    badge.classList.add('border-amber-500/20', 'bg-amber-500/5', 'dark:bg-amber-500/10', 'text-amber-600', 'dark:text-amber-400');
    dot.classList.add('bg-[#D4AF37]', 'animate-pulse');
    text.textContent = 'Sincronizando...';
  } else if (!navigator.onLine) {
    const unsyncedCount = await db.fichas_pacientes.where('synced').equals(0).count();
    badge.classList.add('border-yellow-500/20', 'bg-yellow-500/5', 'dark:bg-yellow-500/10', 'text-yellow-600', 'dark:text-yellow-500');
    dot.classList.add('bg-yellow-500');
    text.textContent = `Modo Local (${unsyncedCount} pendientes)`;
  } else {
    badge.classList.add('border-emerald-500/20', 'bg-emerald-500/5', 'dark:bg-emerald-500/10', 'text-emerald-600', 'dark:text-emerald-400');
    dot.classList.add('bg-emerald-500');
    text.textContent = 'En línea';
  }
}

function formatCurrency(val) {
  if (val === null || val === undefined || val === '') return '-';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val);
}

async function initDatabaseTables() {
  if (!navigator.onLine) return;
  try {
    // Create products table if missing
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        brand TEXT,
        name TEXT,
        category TEXT,
        capacity TEXT,
        price_aesthetic REAL,
        price_public REAL,
        active_ingredients TEXT,
        skin_indication TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create fichas_pacientes table if missing
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS fichas_pacientes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT,
        edad INTEGER,
        fecha TEXT,
        biotipo TEXT,
        diagnostico TEXT,
        condicion TEXT,
        protocolo TEXT,
        protocolo_id TEXT,
        firma_especialista TEXT,
        firma_paciente TEXT
      )
    `);

    // Alter table schemas on Turso for newer clinical columns
    try { await executeQuery("ALTER TABLE fichas_pacientes ADD COLUMN titulo_ficha TEXT"); } catch(e){}
    try { await executeQuery("ALTER TABLE fichas_pacientes ADD COLUMN autor_ficha TEXT"); } catch(e){}
    try { await executeQuery("ALTER TABLE fichas_pacientes ADD COLUMN pasos_preliminares TEXT"); } catch(e){}
    try { await executeQuery("ALTER TABLE fichas_pacientes ADD COLUMN procedimiento_json TEXT"); } catch(e){}
    
    // Create expedientes_clinicos table if missing
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS expedientes_clinicos (
        folio TEXT PRIMARY KEY,
        nombre TEXT,
        fecha TEXT,
        biotipo TEXT,
        session_data TEXT,
        synced INTEGER DEFAULT 0
      )
    `);

    // Create and seed usuarios table if missing
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS usuarios (
        usuario TEXT PRIMARY KEY,
        contrasena TEXT NOT NULL,
        rol TEXT DEFAULT 'especialista'
      )
    `);
    
    // Seed default user
    await executeQuery(`
      INSERT OR REPLACE INTO usuarios (usuario, contrasena, rol)
      VALUES ('clinica_dermatique', 'Dermatique2026', 'especialista')
    `);
  } catch (err) {
    console.error("Error initializing cloud database tables:", err);
  }
}

// Session Lock & Logout Logic
window.logoutSession = function() {
  sessionStorage.removeItem('is_logged');
  window.location.reload();
};

async function handleLogin(e) {
  e.preventDefault();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorMsg = document.getElementById('login-error-msg');
  const btn = document.getElementById('btn-login-submit');
  const loginOverlay = document.getElementById('login-screen');
  const appWorkspace = document.getElementById('app-workspace');

  if (!usernameInput || !passwordInput || !btn) return;

  const originalBtnText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>Verificando estación...</span>';
  if (errorMsg) errorMsg.classList.add('hidden');

  try {
    // Authenticate direct secure query to Turso Cloud DB
    const res = await executeQuery(
      'SELECT usuario, rol FROM usuarios WHERE usuario = ? AND contrasena = ?',
      [usernameInput.value.trim(), passwordInput.value]
    );

    if (res.rows && res.rows.length > 0) {
      // Success: Save token and unlock workstation
      sessionStorage.setItem('is_logged', 'true');
      
      // Smooth fade-out and slide-in transition
      if (loginOverlay) {
        loginOverlay.classList.add('opacity-0', 'pointer-events-none');
        setTimeout(() => loginOverlay.remove(), 500);
      }

      if (appWorkspace) {
        appWorkspace.classList.remove('hidden');
        // Force reflow
        void appWorkspace.offsetWidth;
        appWorkspace.classList.remove('opacity-0', 'translate-y-3');
        appWorkspace.classList.add('opacity-100', 'translate-y-0');
      }

      // Initialize system components dynamically
      initCascadingDropdowns();
      initCheckerTool();
      initDragAndDrop();
      initPatientForm();
      initProductForm();
      initSignatures();
      initFacialCanvas();
      
      // Seed initial cloud ingestion
      loadCatalogList();
      loadIngredientsList();
      loadHistory();
      updateSyncBadge();
      
      showToast('Estación de Diagnóstico Desbloqueada.', 'success');
    } else {
      throw new Error('Credenciales incorrectas');
    }
  } catch (err) {
    console.error(err);
    if (errorMsg) errorMsg.classList.remove('hidden');
    passwordInput.value = '';
    
    // Shake card feedback
    const loginCard = loginOverlay.querySelector('.liquid-glass');
    if (loginCard) {
      loginCard.classList.remove('shake-anim');
      void loginCard.offsetWidth; // Trigger reflow
      loginCard.classList.add('shake-anim');
    }
    showToast('Acceso denegado: Credenciales no válidas.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnText;
  }
}

// Bootstrapper
document.addEventListener('DOMContentLoaded', async () => {
  // Sync theme icon state with current document class
  const isDark = document.documentElement.classList.contains('dark');
  const themeIcon = document.getElementById('theme-icon');
  const themeIconMobile = document.getElementById('theme-icon-mobile');
  if (themeIcon) themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  if (themeIconMobile) themeIconMobile.setAttribute('data-lucide', isDark ? 'sun' : 'moon');

  lucide.createIcons();
  
  // Attach login listener
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  // Create tables in Turso cloud database on startup
  await initDatabaseTables();

  const isLogged = sessionStorage.getItem('is_logged') === 'true';
  const loginOverlay = document.getElementById('login-screen');
  const appWorkspace = document.getElementById('app-workspace');

  if (isLogged) {
    // If already authenticated, bypass lock screen instantly
    if (loginOverlay) loginOverlay.remove();
    if (appWorkspace) {
      appWorkspace.classList.remove('hidden', 'opacity-0', 'translate-y-3');
      appWorkspace.classList.add('opacity-100', 'translate-y-0');
    }

    // Initialize application immediately
    initCascadingDropdowns();
    initCheckerTool();
    initDragAndDrop();
    initPatientForm();
    initProductForm();
    initSignatures();
    initFacialCanvas();
    updateSyncBadge();

    // Load database entities
    loadCatalogList();
    loadIngredientsList();
    loadHistory();
  } else {
    // Lock workspace down
    if (appWorkspace) appWorkspace.classList.add('hidden');
    if (loginOverlay) loginOverlay.classList.remove('hidden');
  }
});

// View Tabs Selector
window.switchTab = function(tabName) {
  const tabs = {
    generator: document.getElementById('tab-generator'),
    inventory: document.getElementById('tab-inventory'),
    records: document.getElementById('tab-records')
  };

  const buttons = {
    generator: document.getElementById('tab-btn-generator'),
    inventory: document.getElementById('tab-btn-inventory'),
    records: document.getElementById('tab-btn-records')
  };

  // Reset button styles
  const inactiveClass = "flex-1 md:flex-none px-5 py-2 rounded-xl text-xs font-semibold transition-all text-slate-500 dark:text-luxe-300 hover:text-slate-800 dark:hover:text-white";
  const activeClass = "flex-1 md:flex-none px-5 py-2 rounded-xl text-xs font-semibold transition-all bg-white text-slate-800 dark:bg-white/10 dark:text-white shadow-sm";

  Object.keys(buttons).forEach(key => {
    if (buttons[key]) buttons[key].className = inactiveClass;
  });

  if (buttons[tabName]) {
    buttons[tabName].className = activeClass;
  }

  // Fade out current visible tabs with slide down
  Object.keys(tabs).forEach(key => {
    const el = tabs[key];
    if (el && !el.classList.contains('hidden')) {
      el.classList.remove('opacity-100', 'translate-y-0');
      el.classList.add('opacity-0', 'translate-y-2', 'transition-all', 'duration-400', 'transform');
    }
  });

  // Delay actual hidden class swap to let fade animation complete
  setTimeout(() => {
    Object.keys(tabs).forEach(key => {
      const el = tabs[key];
      if (el) el.classList.add('hidden');
    });

    const targetEl = tabs[tabName];
    if (targetEl) {
      targetEl.classList.remove('hidden');
      // Force repaint to trigger CSS animation
      void targetEl.offsetWidth;
      targetEl.classList.add('transition-all', 'duration-400', 'transform', 'opacity-0', 'translate-y-2');
      
      // Animate to visible state
      requestAnimationFrame(() => {
        targetEl.classList.remove('opacity-0', 'translate-y-2');
        targetEl.classList.add('opacity-100', 'translate-y-0');
      });
    }

    if (tabName === 'inventory') {
      loadCatalogList();
    } else if (tabName === 'records') {
      loadRecordsList();
    }
  }, 150);
};

// Theme Toggler Logic
window.toggleTheme = function() {
  const html = document.documentElement;
  const isDark = html.classList.contains('dark');
  const newTheme = isDark ? 'light' : 'dark';
  
  if (newTheme === 'dark') {
    html.classList.add('dark');
    html.classList.remove('light');
  } else {
    html.classList.remove('dark');
    html.classList.add('light');
  }
  
  localStorage.setItem('theme', newTheme);
  
  const themeIcon = document.getElementById('theme-icon');
  const themeIconMobile = document.getElementById('theme-icon-mobile');
  if (themeIcon) themeIcon.setAttribute('data-lucide', newTheme === 'dark' ? 'sun' : 'moon');
  if (themeIconMobile) themeIconMobile.setAttribute('data-lucide', newTheme === 'dark' ? 'sun' : 'moon');
  
  lucide.createIcons();
  showToast(`Modo ${newTheme === 'dark' ? 'oscuro' : 'claro'} activado`, 'success');
};

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toast-message');
  const toastIcon = document.getElementById('toast-icon');

  toastMsg.textContent = message;
  
  if (type === 'success') {
    toastIcon.innerHTML = '<i data-lucide="check-circle" class="w-5 h-5 text-emerald-400"></i>';
    toast.className = toast.className.replace(/bg-red-950|bg-slate-900/, 'bg-slate-900');
  } else {
    toastIcon.innerHTML = '<i data-lucide="alert-triangle" class="w-5 h-5 text-red-400"></i>';
    toast.className = toast.className.replace(/bg-slate-900|bg-red-950/, 'bg-red-950');
  }

  lucide.createIcons();

  toast.classList.remove('translate-y-10', 'opacity-0', 'pointer-events-none');
  toast.classList.add('translate-y-0', 'opacity-100');

  setTimeout(() => {
    toast.classList.add('translate-y-10', 'opacity-0', 'pointer-events-none');
    toast.classList.remove('translate-y-0', 'opacity-100');
  }, 4000);
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

// --- Cascading Dropdowns ---
function initCascadingDropdowns() {
  const selMarca = document.getElementById('sel-marca');
  const selCategoria = document.getElementById('sel-categoria');
  const selProducto = document.getElementById('sel-producto');

  if (!selMarca || !selCategoria || !selProducto) return;

  selMarca.addEventListener('change', (e) => {
    const brandVal = e.target.value;

    selCategoria.innerHTML = '<option value="">Seleccione categoría...</option>';
    selCategoria.disabled = true;
    selProducto.innerHTML = '<option value="">Seleccione categoría primero...</option>';
    selProducto.disabled = true;
    clearResultsTable();

    if (!brandVal) {
      selCategoria.innerHTML = '<option value="">Seleccione marca primero...</option>';
      return;
    }

    const categories = new Set();
    allProducts.forEach(p => {
      if (p.brand === brandVal && p.category) {
        categories.add(p.category);
      }
    });

    selCategoria.innerHTML = '<option value="">Seleccionar categoría...</option>';
    Array.from(categories).sort().forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      selCategoria.appendChild(opt);
    });
    selCategoria.disabled = false;
  });

  selCategoria.addEventListener('change', (e) => {
    const brandVal = selMarca.value;
    const catVal = e.target.value;

    selProducto.innerHTML = '<option value="">Seleccione producto...</option>';
    selProducto.disabled = true;
    clearResultsTable();

    if (!catVal) {
      selProducto.innerHTML = '<option value="">Seleccione categoría primero...</option>';
      return;
    }

    const products = allProducts.filter(p => p.brand === brandVal && p.category === catVal);

    selProducto.innerHTML = '<option value="">Seleccionar producto...</option>';
    products.sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      selProducto.appendChild(opt);
    });
    selProducto.disabled = false;
  });

  selProducto.addEventListener('change', (e) => {
    const prodId = e.target.value;

    if (!prodId) {
      clearResultsTable();
      return;
    }

    const product = allProducts.find(p => p.id === prodId);
    if (product) {
      document.getElementById('step-product-name').value = product.name || '';
      document.getElementById('step-product-brand').value = product.brand || '';
      document.getElementById('step-product-actives').value = product.active_ingredients || '';
      document.getElementById('step-product-action').value = product.skin_indication || '';
      document.getElementById('step-product-application').value = '';
      
      // Update financial summary if present
      renderResultsTable(product);
    }
  });
}

function loadBrandsLocal() {
  const selMarca = document.getElementById('sel-marca');
  if (!selMarca) return;
  const brands = new Set();
  allProducts.forEach(p => {
    if (p.brand) brands.add(p.brand);
  });
  
  selMarca.innerHTML = '<option value="">Seleccionar marca...</option>';
  Array.from(brands).sort().forEach(b => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    selMarca.appendChild(opt);
  });
}

// --- Dynamic Procedure Table Actions ---
window.handleFasePresetChange = function() {
  const preset = document.getElementById('step-fase-preset').value;
  const customInput = document.getElementById('step-fase-custom');
  if (!customInput) return;
  if (preset === 'Otro') {
    customInput.value = '';
    customInput.focus();
  } else {
    customInput.value = preset;
  }
};

window.addProcedureStep = function() {
  const presetVal = document.getElementById('step-fase-preset').value;
  const customVal = document.getElementById('step-fase-custom').value.trim();
  const fase = presetVal === 'Otro' ? customVal : (customVal || presetVal);
  
  const name = document.getElementById('step-product-name').value.trim();
  const brand = document.getElementById('step-product-brand').value.trim();
  const actives = document.getElementById('step-product-actives').value.trim();
  const action = document.getElementById('step-product-action').value.trim();
  const application = document.getElementById('step-product-application').value.trim();

  if (!fase) {
    showToast('Escriba o seleccione una Fase/Protocolo.', 'error');
    return;
  }
  if (!name) {
    showToast('El nombre del producto es obligatorio.', 'error');
    return;
  }

  const step = { fase, name, brand, actives, action, application };
  currentProcedureSteps.push(step);
  
  // Clear inputs (except custom phase if desired, but we clear it to keep workflow smooth)
  document.getElementById('step-product-name').value = '';
  document.getElementById('step-product-brand').value = '';
  document.getElementById('step-product-actives').value = '';
  document.getElementById('step-product-action').value = '';
  document.getElementById('step-product-application').value = '';
  
  // Reset cascade
  const selProd = document.getElementById('sel-producto');
  if (selProd) selProd.value = '';

  renderFormProcedureTable();
  syncPrintView();
  showToast('Paso agregado al procedimiento.', 'success');
};

window.deleteProcedureStep = function(index) {
  currentProcedureSteps.splice(index, 1);
  renderFormProcedureTable();
  syncPrintView();
  showToast('Paso eliminado.', 'info');
};

window.moveProcedureStep = function(index, direction) {
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= currentProcedureSteps.length) return;
  
  const temp = currentProcedureSteps[index];
  currentProcedureSteps[index] = currentProcedureSteps[newIndex];
  currentProcedureSteps[newIndex] = temp;
  
  renderFormProcedureTable();
  syncPrintView();
};

function renderFormProcedureTable() {
  const tbody = document.getElementById('form-procedure-tbody');
  if (!tbody) return;

  if (currentProcedureSteps.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-8 px-4 text-center text-slate-400 dark:text-luxe-400 text-xs italic">
          No se han agregado pasos al procedimiento. Use el "Diseñador de Procedimiento" de arriba para agregar productos.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  currentProcedureSteps.forEach((step, idx) => {
    // Principal Row
    const trMain = document.createElement('tr');
    trMain.className = 'border-b border-slate-200/50 dark:border-white/5 bg-slate-500/5 dark:bg-white/5';
    trMain.innerHTML = `
      <td class="py-3 px-4 font-bold text-slate-800 dark:text-white border-r border-slate-200/20">${step.fase}</td>
      <td class="py-3 px-4 text-slate-700 dark:text-luxe-100 font-semibold border-r border-slate-200/20">${step.name}</td>
      <td class="py-3 px-4 text-slate-500 dark:text-luxe-300 border-r border-slate-200/20">${step.brand || '-'}</td>
      <td class="py-3 px-4 text-slate-600 dark:text-luxe-200 border-r border-slate-200/20">${step.actives || '-'}</td>
      <td class="py-3 px-4 text-slate-700 dark:text-white font-medium border-r border-slate-200/20">${step.action || '-'}</td>
      <td class="py-3 px-4 text-center no-print">
        <div class="flex items-center justify-center gap-1.5">
          <button type="button" onclick="moveProcedureStep(${idx}, -1)" class="p-1 hover:text-bronze-500 transition-colors ${idx === 0 ? 'opacity-30 cursor-not-allowed' : ''}" ${idx === 0 ? 'disabled' : ''}>
            ▲
          </button>
          <button type="button" onclick="moveProcedureStep(${idx}, 1)" class="p-1 hover:text-bronze-500 transition-colors ${idx === currentProcedureSteps.length - 1 ? 'opacity-30 cursor-not-allowed' : ''}" ${idx === currentProcedureSteps.length - 1 ? 'disabled' : ''}>
            ▼
          </button>
          <button type="button" onclick="deleteProcedureStep(${idx})" class="p-1 text-red-500 hover:text-red-600 transition-colors ml-1" title="Eliminar paso">
            ✖
          </button>
        </div>
      </td>
    `;
    
    // Application Row
    const trApp = document.createElement('tr');
    trApp.className = 'border-b border-slate-200/50 dark:border-white/5';
    trApp.innerHTML = `
      <td colspan="6" class="py-2.5 px-4 text-xs text-slate-500 dark:text-luxe-300 bg-white/20 dark:bg-luxe-950/20">
        <strong class="text-slate-600 dark:text-luxe-400">Aplicación:</strong> ${step.application || 'No especificada.'}
      </td>
    `;
    
    tbody.appendChild(trMain);
    tbody.appendChild(trApp);
  });
}

function clearResultsTable() {
  // Reset step builder product details
  document.getElementById('step-product-name').value = '';
  document.getElementById('step-product-brand').value = '';
  document.getElementById('step-product-actives').value = '';
  document.getElementById('step-product-action').value = '';
  document.getElementById('step-product-application').value = '';

  const finCard = document.getElementById('financial-summary-card');
  if (finCard) finCard.classList.add('hidden');
}

function renderResultsTable(p) {
  const finCard = document.getElementById('financial-summary-card');
  if (!p) {
    clearResultsTable();
    return;
  }

  if (badge) {
    badge.textContent = `${p.brand} - ${p.name}`;
    badge.classList.remove('hidden');
  }

  tbody.innerHTML = `
    <tr class="border-b border-slate-200/50 dark:border-white/5">
      <td class="py-3.5 px-5 font-semibold text-slate-500 dark:text-luxe-400 w-1/3">ID / Clave</td>
      <td class="py-3.5 px-5 font-bold text-slate-800 dark:text-white">${p.id}</td>
    </tr>
    <tr class="border-b border-slate-200/50 dark:border-white/5">
      <td class="py-3.5 px-5 font-semibold text-slate-500 dark:text-luxe-400">Capacidad</td>
      <td class="py-3.5 px-5 text-slate-700 dark:text-luxe-200">${p.capacity || '-'}</td>
    </tr>
    <tr class="border-b border-slate-200/50 dark:border-white/5">
      <td class="py-3.5 px-5 font-semibold text-slate-500 dark:text-luxe-400">Precio Público (MXN)</td>
      <td class="py-3.5 px-5 text-emerald-600 dark:text-emerald-400 font-bold">${formatCurrency(p.price_public)}</td>
    </tr>
    <tr class="border-b border-slate-200/50 dark:border-white/5">
      <td class="py-3.5 px-5 font-semibold text-slate-500 dark:text-luxe-400">Biotipo / Indicación</td>
      <td class="py-3.5 px-5 text-slate-700 dark:text-luxe-200 font-medium">${p.skin_indication || '-'}</td>
    </tr>
    <tr class="border-b border-slate-200/50 dark:border-white/5">
      <td class="py-3.5 px-5 font-semibold text-slate-500 dark:text-luxe-400">Activos Clave</td>
      <td class="py-3.5 px-5 text-slate-800 dark:text-white font-semibold">${p.active_ingredients || '-'}</td>
    </tr>
  `;

  // Render financial analytics (Specialist only)
  if (finCard) {
    finCard.classList.remove('hidden');
    
    const cost = cleanPrice(p.price_aesthetic);
    const publicPrice = cleanPrice(p.price_public);
    const profit = publicPrice - cost;
    const marginPct = publicPrice > 0 ? Math.round((profit / publicPrice) * 100) : 0;
    
    document.getElementById('fin-cost').textContent = formatCurrency(cost);
    document.getElementById('fin-public').textContent = formatCurrency(publicPrice);
    document.getElementById('fin-profit').textContent = `${formatCurrency(profit)} (${marginPct}%)`;
    
    const chartContainer = document.getElementById('profit-margin-chart');
    chartContainer.innerHTML = '';
    
    const options = {
      series: [marginPct],
      chart: {
        height: 140,
        type: 'radialBar',
        sparkline: {
          enabled: true
        }
      },
      plotOptions: {
        radialBar: {
          hollow: {
            size: '60%',
          },
          dataLabels: {
            show: true,
            name: {
              show: false
            },
            value: {
              offsetY: 5,
              fontSize: '14px',
              fontWeight: 'bold',
              color: document.documentElement.classList.contains('dark') ? '#ffffff' : '#121215',
              formatter: function (val) {
                return val + "%";
              }
            }
          }
        }
      },
      colors: ['#D4AF37'],
      labels: ['Margen']
    };
    
    const chart = new ApexCharts(chartContainer, options);
    chart.render();
  }
}

// --- Levenshtein Correction Tool ---
function getLevenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          Math.min(
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          )
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

async function loadIngredientsList() {
  try {
    const res = await executeQuery("SELECT DISTINCT active_ingredients FROM products WHERE active_ingredients IS NOT NULL AND active_ingredients != ''");
    const allActives = new Set();
    
    res.rows.forEach(row => {
      row.active_ingredients.split(',').forEach(act => {
        const trimmed = act.trim();
        if (trimmed) allActives.add(trimmed);
      });
    });
    
    allIngredientsList = Array.from(allActives).map(act => ({ activo: act }));
  } catch (err) {
    console.error(err);
  }
}

function initCheckerTool() {
  const input = document.getElementById('checker-input');
  const btn = document.getElementById('btn-check-active');
  const resultsDiv = document.getElementById('checker-results');

  const check = () => {
    const val = input.value;
    if (!val || val.trim() === '') {
      resultsDiv.innerHTML = '<p class="text-slate-400 italic">Por favor, escriba un ingrediente activo o producto para comenzar.</p>';
      return;
    }

    if (fuseInstance) {
      const searchResults = fuseInstance.search(val);
      if (searchResults.length === 0) {
        resultsDiv.innerHTML = `
          <div class="p-3 bg-slate-100 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-xl">
            <div class="flex items-center gap-1.5 text-slate-700 dark:text-luxe-300 font-semibold text-sm">
              <i data-lucide="x-circle" class="w-4.5 h-4.5 text-slate-500"></i>
              <span>Sin coincidencias</span>
            </div>
            <p class="text-slate-500 dark:text-luxe-400 text-xs mt-1">No se encontraron productos o activos similares en el catálogo actual.</p>
          </div>
        `;
      } else {
        let listHtml = searchResults.map(res => {
          const p = res.item;
          const score = res.score ? Math.round((1 - res.score) * 100) : 95; // Default score if undefined
          return `
            <div class="py-2 border-b border-slate-200/50 dark:border-white/5 last:border-0 text-xs">
              <p class="text-slate-800 dark:text-white font-semibold">${p.name} <span class="text-[9px] bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-luxe-300 px-2 py-0.5 rounded-full ml-1">${score}% coincidencia</span></p>
              <p class="text-slate-500 dark:text-luxe-400 mt-0.5">Línea: ${p.brand} | Activos: ${p.active_ingredients || '-'}</p>
            </div>
          `;
        }).join('');

        resultsDiv.innerHTML = `
          <div class="space-y-3">
            <div class="flex items-center gap-1.5 text-blue-800 dark:text-luxe-200 font-bold text-sm bg-blue-50 dark:bg-white/5 border border-blue-200 dark:border-white/10 p-2.5 rounded-xl">
              <i data-lucide="info" class="w-4.5 h-4.5 text-blue-600 dark:text-bronze-500"></i>
              <span>Coincidencias Encontradas:</span>
            </div>
            <div class="max-h-40 overflow-y-auto pr-1">${listHtml}</div>
          </div>
        `;
      }
    } else {
      resultsDiv.innerHTML = '<p class="text-slate-400 italic">Cargando motor de búsqueda...</p>';
    }
    lucide.createIcons();
  };

  btn.addEventListener('click', check);
}

// --- Patient Form ---
function initPatientForm() {
  const form = document.getElementById('patient-form');
  const btnReset = document.getElementById('btn-reset');

  btnReset.addEventListener('click', () => {
    form.reset();
    document.getElementById('fecha').value = new Date().toISOString().substring(0, 10);
    document.getElementById('titulo_ficha').value = 'Limpieza piel sensible práctica 7';
    document.getElementById('autor_ficha').value = '';
    document.getElementById('pasos_preliminares').value = '';
    
    currentProcedureSteps = [];
    renderFormProcedureTable();

    document.getElementById('sel-marca').value = '';
    
    const selCat = document.getElementById('sel-categoria');
    selCat.innerHTML = '<option value="">Seleccione marca primero...</option>';
    selCat.disabled = true;

    const selProd = document.getElementById('sel-producto');
    selProd.innerHTML = '<option value="">Seleccione categoría primero...</option>';
    selProd.disabled = true;

    if (signaturePadEspecialista) signaturePadEspecialista.clear();
    if (signaturePadPaciente) signaturePadPaciente.clear();

    clearResultsTable();
    
    // Clear stepper inputs
    document.getElementById('stepper-phase-1-product').value = '';
    document.getElementById('stepper-phase-2-apparatus').value = '';
    document.getElementById('stepper-phase-2-intensity').value = '';
    document.getElementById('stepper-phase-2-time').value = '';
    document.getElementById('stepper-phase-3-product').value = '';
    document.getElementById('apparatus-recommendation-badge').classList.add('hidden');

    showToast('Ficha limpia.', 'success');
  });

  const diagInput = document.getElementById('diagnostico');
  if (diagInput) {
    diagInput.addEventListener('input', updateApparatusSuggestions);
  }
  populateApparatusDropdown();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const nombre = document.getElementById('nombre').value;
    const fecha = document.getElementById('fecha').value;
    const biotipo = document.getElementById('biotipo').value;
    const diagnostico = document.getElementById('diagnostico').value;
    const condicion = document.getElementById('condicion').value;
    
    // Read new fields
    const tituloFichaVal = document.getElementById('titulo_ficha').value.trim();
    const autorFichaVal = document.getElementById('autor_ficha').value.trim();
    const pasosPreliminaresVal = document.getElementById('pasos_preliminares').value.trim();
    const procedimientoJson = JSON.stringify(currentProcedureSteps);

    // Fallback/Backward-compatible single product ID: first product's name or empty
    const prodId = currentProcedureSteps.length > 0 ? (currentProcedureSteps[0].name || '') : '';

    const firmaEsp = signaturePadEspecialista && !signaturePadEspecialista.isEmpty() ? signaturePadEspecialista.toDataURL() : null;
    const firmaPac = signaturePadPaciente && !signaturePadPaciente.isEmpty() ? signaturePadPaciente.toDataURL() : null;

    const edadVal = parseInt(document.getElementById('edad').value) || null;
    const protocoloVal = document.getElementById('protocolo').value;

    const newRecord = {
      nombre,
      edad: edadVal,
      fecha,
      biotipo,
      diagnostico,
      condicion,
      protocolo: protocoloVal,
      protocolo_id: prodId,
      firma_especialista: firmaEsp,
      firma_paciente: firmaPac,
      titulo_ficha: tituloFichaVal,
      autor_ficha: autorFichaVal,
      pasos_preliminares: pasosPreliminaresVal,
      procedimiento_json: procedimientoJson,
      synced: 0
    };

    try {
      // Save locally to Dexie LocalDB first
      const localId = await db.fichas_pacientes.add(newRecord);

      if (navigator.onLine) {
        // Direct cloud write if online
        await executeQuery(
          'INSERT INTO fichas_pacientes (nombre, edad, fecha, biotipo, diagnostico, condicion, protocolo, protocolo_id, firma_especialista, firma_paciente, titulo_ficha, autor_ficha, pasos_preliminares, procedimiento_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [nombre, edadVal, fecha, biotipo, diagnostico, condicion, protocoloVal, prodId, firmaEsp, firmaPac, tituloFichaVal, autorFichaVal, pasosPreliminaresVal, procedimientoJson]
        );
        // Mark as synced
        await db.fichas_pacientes.update(localId, { synced: 1 });
        showToast('Ficha guardada y sincronizada con la nube.', 'success');
      } else {
        showToast('Ficha guardada localmente (pendiente de conexión).', 'warning');
      }
      
      // Also save the consolidated Expediente Clínico!
      await saveExpedienteClinico({
        nombre, edad: edadVal, fecha, biotipo, diagnostico, condicion, protocolo: protocoloVal, prodId, firmaEsp, firmaPac,
        titulo_ficha: tituloFichaVal, autor_ficha: autorFichaVal, pasos_preliminares: pasosPreliminaresVal, procedimiento_json: procedimientoJson
      });

      // Clear form inputs & current steps
      currentProcedureSteps = [];
      renderFormProcedureTable();
      
      if (signaturePadEspecialista) {
        signaturePadEspecialista.clear();
        savedSignatureEsp = null;
      }
      if (signaturePadPaciente) {
        signaturePadPaciente.clear();
        savedSignaturePac = null;
      }

      // Restore form defaults
      document.getElementById('patient-form').reset();
      document.getElementById('titulo_ficha').value = 'Limpieza piel sensible práctica 7';
      document.getElementById('fecha').value = new Date().toISOString().split('T')[0];

      loadHistory();
      scrollToSection('history-section');
    } catch (err) {
      console.error(err);
      showToast('Error al guardar la ficha de paciente.', 'error');
    }
  });
}

async function loadHistory() {
  const tbody = document.getElementById('history-table-body');
  try {
    const res = await executeQuery(
      "SELECT f.*, p.name as producto, p.brand as linea, p.category as protocolo FROM fichas_pacientes f LEFT JOIN products p ON f.protocolo_id = p.id ORDER BY f.id DESC"
    );

    if (!res.rows || res.rows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-8 px-6 text-center text-slate-400 text-sm">
            No hay fichas históricas guardadas.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = '';
    res.rows.forEach(f => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-200/60 hover:bg-slate-50/50 transition-colors text-sm';
      
      const linked = f.producto
        ? `<span class="font-semibold text-slate-800">${f.producto}</span><span class="text-xs text-slate-400 block">${f.linea} (${f.protocolo})</span>`
        : '<span class="text-slate-400 italic">No especificado</span>';

      tr.innerHTML = `
        <td class="py-3.5 px-6 font-semibold text-slate-800">${f.nombre}</td>
        <td class="py-3.5 px-6 text-slate-500">${f.fecha}</td>
        <td class="py-3.5 px-6 text-slate-600">${f.biotipo || '-'}</td>
        <td class="py-3.5 px-6 text-slate-500 max-w-xs truncate" title="${f.diagnostico || ''}">${f.diagnostico || '-'}</td>
        <td class="py-3.5 px-6">${linked}</td>
        <td class="py-3.5 px-6 text-right">
          <button onclick="loadFichaToForm(${JSON.stringify(f).replace(/"/g, '&quot;')})" 
            class="text-medical-600 hover:text-medical-700 font-semibold flex items-center gap-1 ml-auto text-xs">
            <i data-lucide="eye" class="w-3.5 h-3.5"></i> Cargar y Ver
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    lucide.createIcons();
    updateBiotypeChart(res.rows);
  } catch (err) {
    console.error(err);
  }
}

window.loadFichaToForm = function(f) {
  document.getElementById('nombre').value = f.nombre;
  document.getElementById('edad').value = f.edad || '';
  document.getElementById('fecha').value = f.fecha;
  document.getElementById('biotipo').value = f.biotipo || '';
  document.getElementById('diagnostico').value = f.diagnostico || '';
  document.getElementById('condicion').value = f.condicion || '';
  document.getElementById('protocolo').value = f.protocolo || '';
  
  // Hydrate new fields
  document.getElementById('titulo_ficha').value = f.titulo_ficha || 'Limpieza piel sensible práctica 7';
  document.getElementById('autor_ficha').value = f.autor_ficha || '';
  document.getElementById('pasos_preliminares').value = f.pasos_preliminares || '';
  document.getElementById('current-doc-id').textContent = `Ficha Nº ${f.id} (Historial)`;

  // Parse procedure steps
  if (f.procedimiento_json) {
    try {
      currentProcedureSteps = JSON.parse(f.procedimiento_json);
    } catch (e) {
      currentProcedureSteps = [];
    }
  } else if (f.producto) {
    currentProcedureSteps = [{
      fase: f.protocolo || 'Fase Única',
      name: f.producto,
      brand: f.linea || '',
      actives: '',
      action: '',
      application: ''
    }];
  } else {
    currentProcedureSteps = [];
  }
  renderFormProcedureTable();

  if (signaturePadEspecialista) signaturePadEspecialista.clear();
  if (signaturePadPaciente) signaturePadPaciente.clear();

  if (f.firma_especialista && signaturePadEspecialista) {
    signaturePadEspecialista.fromDataURL(f.firma_especialista);
  }
  if (f.firma_paciente && signaturePadPaciente) {
    signaturePadPaciente.fromDataURL(f.firma_paciente);
  }

  switchTab('generator');
  scrollToSection('clinical-sheet-card');

  if (f.linea) {
    const selMarca = document.getElementById('sel-marca');
    selMarca.value = f.linea;
    const event = new Event('change');
    selMarca.dispatchEvent(event);

    setTimeout(() => {
      const selCat = document.getElementById('sel-categoria');
      selCat.value = f.protocolo;
      selCat.dispatchEvent(event);

      setTimeout(() => {
        const selProd = document.getElementById('sel-producto');
        selProd.value = f.protocolo_id;
        selProd.dispatchEvent(event);
        showToast('Ficha de historial cargada exitosamente.', 'success');
      }, 300);
    }, 300);
  }
};

// --- Catalog Operations (CRUD) ---
window.toggleProductForm = function() {
  const formCard = document.getElementById('product-mutation-card');
  const isHidden = formCard.classList.contains('hidden');
  
  if (isHidden) {
    formCard.classList.remove('hidden');
    document.getElementById('prod-id').disabled = false;
    document.getElementById('mutation-form-title').textContent = 'Crear Nuevo Producto';
    document.getElementById('is_edit').value = 'false';
    document.getElementById('product-form').reset();
  } else {
    formCard.classList.add('hidden');
  }
};

function updateFuseIndex() {
  if (typeof Fuse !== 'undefined' && allProducts.length > 0) {
    fuseInstance = new Fuse(allProducts, {
      keys: ['name', 'active_ingredients', 'skin_indication'],
      threshold: 0.4,
      ignoreLocation: true
    });
  }
}

async function loadCatalogList() {
  const tbody = document.getElementById('catalog-table-body');
  try {
    if (navigator.onLine) {
      const res = await executeQuery("SELECT * FROM products ORDER BY name ASC");
      allProducts = res.rows;
      
      // Mirror to Dexie LocalDB
      await db.products.clear();
      await db.products.bulkPut(allProducts);
    } else {
      allProducts = await db.products.toArray();
      showToast('Modo Offline: cargando catálogo local.', 'warning');
    }
    
    updateFuseIndex();
    renderCatalogTable(allProducts);
    populateFilterSelects(allProducts);
    loadBrandsLocal();
    populateStepperDropdowns(allProducts);
  } catch (err) {
    console.error(err);
    try {
      allProducts = await db.products.toArray();
      updateFuseIndex();
      renderCatalogTable(allProducts);
      populateFilterSelects(allProducts);
      loadBrandsLocal();
      populateStepperDropdowns(allProducts);
      showToast('Cargados datos locales tras fallo de conexión.', 'warning');
    } catch (localErr) {
      tbody.innerHTML = '<tr><td colspan="9" class="py-8 px-4 text-center text-red-500">Error al consultar catálogo.</td></tr>';
    }
  }
}

function populateFilterSelects(products) {
  const brands = new Set();
  const cats = new Set();
  
  products.forEach(p => {
    if (p.brand) brands.add(p.brand);
    if (p.category) cats.add(p.category);
  });

  const filterBrand = document.getElementById('filter-brand');
  const filterCat = document.getElementById('filter-category');

  const selectedBrand = filterBrand.value;
  const selectedCat = filterCat.value;

  filterBrand.innerHTML = '<option value="">Todas las marcas</option>';
  Array.from(brands).sort().forEach(b => {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    filterBrand.appendChild(opt);
  });
  filterBrand.value = selectedBrand;

  filterCat.innerHTML = '<option value="">Todas las categorías</option>';
  Array.from(cats).sort().forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    filterCat.appendChild(opt);
  });
  filterCat.value = selectedCat;
}

function renderCatalogTable(products, limit = 15) {
  const tbody = document.getElementById('catalog-table-body');
  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="py-8 px-4 text-center text-slate-400">No se encontraron productos.</td></tr>';
    const oldBtn = document.getElementById('catalog-show-more-btn');
    if (oldBtn) oldBtn.remove();
    return;
  }

  tbody.innerHTML = '';
  const visibleProducts = products.slice(0, limit);
  visibleProducts.forEach(p => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200/60 dark:border-white/5 hover:bg-slate-50/50 dark:hover:bg-white/[0.02] transition-colors';
    tr.innerHTML = `
      <td class="py-3 px-4 font-bold text-slate-900 dark:text-white">${p.id}</td>
      <td class="py-3 px-4 font-semibold text-slate-800 dark:text-luxe-100">${p.name}</td>
      <td class="py-3 px-4 text-slate-600 dark:text-luxe-300">${p.brand}</td>
      <td class="py-3 px-4 text-slate-600 dark:text-luxe-300">${p.category}</td>
      <td class="py-3 px-4 text-slate-500 dark:text-luxe-400">${p.capacity || '-'}</td>
      <td class="py-3 px-4 text-slate-700 dark:text-luxe-200 font-medium">${formatCurrency(p.price_aesthetic)}</td>
      <td class="py-3 px-4 text-emerald-700 dark:text-emerald-400 font-bold">${formatCurrency(p.price_public)}</td>
      <td class="py-3 px-4 text-slate-500 dark:text-luxe-400 truncate max-w-xs" title="${p.active_ingredients || ''}">${p.active_ingredients || '-'}</td>
      <td class="py-3 px-4 text-right flex justify-end gap-2">
        <button onclick="editProduct(${JSON.stringify(p).replace(/"/g, '&quot;')})" 
          class="text-medical-600 hover:text-medical-700 dark:text-bronze-500 dark:hover:text-bronze-400 font-semibold text-xs flex items-center gap-1">
          <i data-lucide="edit-2" class="w-3.5 h-3.5"></i> Editar
        </button>
        <button onclick="deleteProduct('${p.id}')" 
          class="text-red-600 hover:text-red-700 dark:text-red-500 dark:hover:text-red-400 font-semibold text-xs flex items-center gap-1 ml-2">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  lucide.createIcons();

  const oldBtn = document.getElementById('catalog-show-more-btn');
  if (oldBtn) oldBtn.remove();

  if (products.length > limit) {
    const parentContainer = tbody.closest('.border');
    const btn = document.createElement('button');
    btn.id = 'catalog-show-more-btn';
    btn.className = 'w-full py-3 bg-white/40 dark:bg-luxe-900/40 hover:bg-white/60 dark:hover:bg-luxe-900/60 border-t border-slate-200/50 dark:border-white/5 text-xs font-semibold text-slate-600 dark:text-luxe-300 transition-all flex items-center justify-center gap-2';
    btn.innerHTML = 'Mostrar más resultados <i data-lucide="chevron-down" class="w-4 h-4"></i>';
    btn.onclick = () => {
      renderCatalogTable(products, limit + 15);
    };
    parentContainer.appendChild(btn);
    lucide.createIcons();
  }
}

window.filterCatalog = function() {
  const queryText = document.getElementById('catalog-search').value;
  const brandVal = document.getElementById('filter-brand').value;
  const catVal = document.getElementById('filter-category').value;

  let results = allProducts;

  if (queryText && queryText.trim() !== '') {
    if (fuseInstance) {
      results = fuseInstance.search(queryText).map(res => res.item);
    } else {
      const normQuery = normalizeText(queryText);
      results = allProducts.filter(p => 
        normalizeText(p.name).includes(normQuery) ||
        normalizeText(p.id).includes(normQuery) ||
        normalizeText(p.active_ingredients).includes(normQuery) ||
        normalizeText(p.skin_indication).includes(normQuery)
      );
    }
  }

  const filtered = results.filter(p => {
    const matchBrand = !brandVal || p.brand === brandVal;
    const matchCat = !catVal || p.category === catVal;
    return matchBrand && matchCat;
  });

  renderCatalogTable(filtered);
};

window.editProduct = function(p) {
  const formCard = document.getElementById('product-mutation-card');
  formCard.classList.remove('hidden');
  
  document.getElementById('mutation-form-title').textContent = 'Editar Producto';
  document.getElementById('is_edit').value = 'true';
  
  document.getElementById('prod-id').value = p.id;
  document.getElementById('prod-id').disabled = true;
  
  document.getElementById('prod-name').value = p.name;
  document.getElementById('prod-brand').value = p.brand;
  document.getElementById('prod-category').value = p.category;
  document.getElementById('prod-capacity').value = p.capacity || '';
  document.getElementById('prod-price-aesthetic').value = p.price_aesthetic ? `$${p.price_aesthetic}` : '';
  document.getElementById('prod-price-public').value = p.price_public ? `$${p.price_public}` : '';
  document.getElementById('prod-actives').value = p.active_ingredients || '';
  document.getElementById('prod-indication').value = p.skin_indication || '';

  scrollToSection('product-mutation-card');
};

window.deleteProduct = async function(id) {
  if (!confirm(`¿Está seguro de eliminar el producto '${id}'?`)) return;

  try {
    await executeQuery("DELETE FROM products WHERE id = ?", [id]);
    showToast('Producto eliminado.', 'success');
    loadCatalogList();
    loadBrands();
  } catch (err) {
    console.error(err);
    showToast('Error al eliminar producto.', 'error');
  }
};

function initProductForm() {
  const form = document.getElementById('product-form');
  const catSelect = document.getElementById('prod-category');
  
  const categoryPrefixes = {
    "Limpiador": "LIM",
    "Exfoliante": "EXF",
    "Regulador pH": "RPH",
    "Corporal": "COR",
    "Serum/Vial": "SRM",
    "Mascarilla": "MAS",
    "Loción": "LOC",
    "Crema/Gel": "CRM",
    "Específico": "ESP",
    "Alternative": "ALT",
    "Rosa Mosq.": "RMQ",
    "Mulike": "MUL",
    "Oro": "ORO",
    "Clásica": "CLA",
    "Diamante": "DIA",
    "Biohelicina": "HEL",
    "Biobotulina": "BOT",
    "Black Allium": "ALL",
    "Colágeno": "COL",
    "Venom Ther.": "VNM",
    "Rosa Negra": "RNG",
    "Geles/Nuev.": "GEL",
    "Ojos/Labios": "EYE",
    "Biotecnopl.": "TEC"
  };

  catSelect.addEventListener('change', () => {
    const isEdit = document.getElementById('is_edit').value === 'true';
    if (isEdit) return; // Do not overwrite ID during edits

    const catVal = catSelect.value;
    if (!catVal) return;

    const prefix = categoryPrefixes[catVal] || catVal.substring(0, 3).toUpperCase();
    
    // Find next sequence number
    let maxNum = 0;
    const regex = new RegExp(`^${prefix}-(\\d+)$`, 'i');
    
    allProducts.forEach(p => {
      const match = String(p.id).match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNum) maxNum = num;
      }
    });

    const nextNum = maxNum + 1;
    const paddedNum = String(nextNum).padStart(3, '0');
    document.getElementById('prod-id').value = `${prefix}-${paddedNum}`;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const id = document.getElementById('prod-id').value;
    const name = document.getElementById('prod-name').value;
    const brand = document.getElementById('prod-brand').value;
    const category = document.getElementById('prod-category').value;
    const capacity = document.getElementById('prod-capacity').value;
    const price_aesthetic = document.getElementById('prod-price-aesthetic').value;
    const price_public = document.getElementById('prod-price-public').value;
    const active_ingredients = document.getElementById('prod-actives').value;
    const skin_indication = document.getElementById('prod-indication').value;
    const is_edit = document.getElementById('is_edit').value === 'true';

    try {
      const priceAes = sanitizePrice(price_aesthetic);
      const pricePub = sanitizePrice(price_public);

      if (is_edit) {
        await executeQuery(
          `UPDATE products SET brand = ?, name = ?, category = ?, capacity = ?, 
           price_aesthetic = ?, price_public = ?, active_ingredients = ?, skin_indication = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [brand, name, category, capacity || null, priceAes, pricePub, active_ingredients || null, skin_indication || null, id]
        );
        showToast('Producto actualizado.', 'success');
      } else {
        const check = await executeQuery("SELECT id FROM products WHERE id = ?", [id]);
        if (check.rows.length > 0) {
          showToast(`El ID/Clave '${id}' ya está registrado.`, 'error');
          return;
        }

        await executeQuery(
          `INSERT INTO products (id, brand, name, category, capacity, price_aesthetic, price_public, active_ingredients, skin_indication) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, brand, name, category, capacity || null, priceAes, pricePub, active_ingredients || null, skin_indication || null]
        );
        showToast('Producto creado.', 'success');
      }

      document.getElementById('product-mutation-card').classList.add('hidden');
      loadCatalogList();
      loadBrands();
      loadIngredientsList();
    } catch (err) {
      console.error(err);
      showToast('Error al guardar producto.', 'error');
    }
  });
}

// --- Excel Bulk Loader ---
function initDragAndDrop() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const previewContainer = document.getElementById('ingestion-preview-container');
  const previewTableBody = document.getElementById('preview-table-body');
  const previewRowCount = document.getElementById('preview-row-count');
  const btnCancel = document.getElementById('btn-cancel-upload');
  const btnConfirm = document.getElementById('btn-confirm-upload');

  dropzone.addEventListener('click', () => fileInput.click());

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eName => {
    dropzone.addEventListener(eName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ['dragenter', 'dragover'].forEach(eName => {
    dropzone.addEventListener(eName, () => dropzone.classList.add('border-medical-500', 'bg-medical-50/10'), false);
  });

  ['dragleave', 'drop'].forEach(eName => {
    dropzone.addEventListener(eName, () => dropzone.classList.remove('border-medical-500', 'bg-medical-50/10'), false);
  });

  dropzone.addEventListener('drop', (e) => {
    handleFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
  });

  function handleFiles(files) {
    if (files.length === 0) return;
    const file = files[0];
    const ext = file.name.split('.').pop().toLowerCase();
    
    if (!['csv', 'xlsx', 'xls'].includes(ext)) {
      showToast('Formato inválido. Debe ser CSV o Excel.', 'error');
      return;
    }

    const reader = new FileReader();

    if (ext === 'csv') {
      reader.onload = (e) => {
        Papa.parse(e.target.result, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => processParsedData(results.data),
          error: (err) => showToast('Error parsing CSV: ' + err.message, 'error')
        });
      };
      reader.readAsText(file, 'UTF-8');
    } else {
      reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const json = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        processParsedData(json);
      };
      reader.readAsArrayBuffer(file);
    }
  }

  function processParsedData(data) {
    if (!data || data.length === 0) {
      showToast('El archivo está vacío.', 'error');
      return;
    }

    const mappedRows = [];
    
    for (const rawRow of data) {
      const keys = Object.keys(rawRow);
      const rowNormalized = {};
      keys.forEach(k => {
        rowNormalized[k.trim().toUpperCase()] = rawRow[k];
      });

      const dbRow = {};
      let hasKeys = false;

      Object.keys(productMapping).forEach(excelKey => {
        const dbKey = productMapping[excelKey];
        const normalizedKey = excelKey.toUpperCase();
        
        if (normalizedKey in rowNormalized) {
          dbRow[dbKey] = rowNormalized[normalizedKey];
          hasKeys = true;
        }
      });

      if (hasKeys && dbRow.id && dbRow.brand && dbRow.name && dbRow.category) {
        dbRow.price_aesthetic = sanitizePrice(dbRow.price_aesthetic);
        dbRow.price_public = sanitizePrice(dbRow.price_public);
        mappedRows.push(dbRow);
      }
    }

    if (mappedRows.length === 0) {
      showToast('No se encontraron productos válidos en el archivo.', 'error');
      return;
    }

    uploadDataPreview = mappedRows;
    previewRowCount.textContent = `${mappedRows.length} productos identificados`;
    
    previewTableBody.innerHTML = '';
    const showCount = Math.min(mappedRows.length, 10);
    
    for (let i = 0; i < showCount; i++) {
      const r = mappedRows[i];
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-100';
      tr.innerHTML = `
        <td class="py-2 px-4 font-bold text-slate-800">${r.id}</td>
        <td class="py-2 px-4 font-semibold text-slate-700">${r.name}</td>
        <td class="py-2 px-4 text-slate-600">${r.brand}</td>
        <td class="py-2 px-4 text-slate-600">${r.category}</td>
        <td class="py-2 px-4 text-slate-600 font-medium">${formatCurrency(r.price_aesthetic)}</td>
        <td class="py-2 px-4 text-emerald-700 font-bold">${formatCurrency(r.price_public)}</td>
      `;
      previewTableBody.appendChild(tr);
    }

    if (mappedRows.length > 10) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td colspan="6" class="py-2.5 text-center text-slate-400 bg-slate-50 italic font-medium">
          ... y ${mappedRows.length - 10} productos más.
        </td>
      `;
      previewTableBody.appendChild(tr);
    }

    previewContainer.classList.remove('hidden');
    scrollToSection('dropzone');
  }

  btnCancel.addEventListener('click', () => {
    uploadDataPreview = [];
    previewContainer.classList.add('hidden');
    fileInput.value = '';
  });

  btnConfirm.addEventListener('click', async () => {
    btnConfirm.disabled = true;
    btnConfirm.textContent = 'Procesando catálogo...';

    try {
      const insertStatements = [];

      for (const r of uploadDataPreview) {
        insertStatements.push({
          sql: `
            INSERT INTO products (id, brand, name, category, capacity, price_aesthetic, price_public, active_ingredients, skin_indication)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              brand = excluded.brand,
              name = excluded.name,
              category = excluded.category,
              capacity = excluded.capacity,
              price_aesthetic = excluded.price_aesthetic,
              price_public = excluded.price_public,
              active_ingredients = excluded.active_ingredients,
              skin_indication = excluded.skin_indication,
              updated_at = CURRENT_TIMESTAMP
          `,
          args: [
            r.id,
            r.brand,
            r.name,
            r.category,
            r.capacity || null,
            r.price_aesthetic,
            r.price_public,
            r.active_ingredients || null,
            r.skin_indication || null
          ]
        });
      }

      // Execute batch query transaction directly from browser over HTTP
      if (insertStatements.length > 0) {
        await executeBatch(insertStatements);
      }

      showToast(`Catálogo cargado con éxito. Se importaron ${uploadDataPreview.length} registros.`, 'success');
      previewContainer.classList.add('hidden');
      uploadDataPreview = [];
      fileInput.value = '';

      loadBrands();
      loadCatalogList();
      loadIngredientsList();
    } catch (err) {
      console.error(err);
      showToast('Error al guardar catálogo en Turso.', 'error');
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.textContent = 'Confirmar e Importar Catálogo';
    }
  });
}

function normalizeText(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Automatically sync the interactive form values into the high-contrast clean printable template before print dialog launches.
function syncPrintView() {
  document.getElementById('print-val-titulo').textContent = document.getElementById('titulo_ficha').value || 'Limpieza piel sensible práctica 7';
  document.getElementById('print-val-autor').textContent = document.getElementById('autor_ficha').value || 'Especialista';
  document.getElementById('print-val-pasos-preliminares').textContent = document.getElementById('pasos_preliminares').value || 'No especificado.';

  document.getElementById('print-val-nombre').textContent = document.getElementById('nombre').value || '__________________________________';
  document.getElementById('print-val-edad').textContent = (document.getElementById('edad').value ? document.getElementById('edad').value + ' años' : '___');
  document.getElementById('print-val-fecha').textContent = document.getElementById('fecha').value || '__________________';
  document.getElementById('print-val-biotipo').textContent = document.getElementById('biotipo').value || '__________________';
  
  // Combine Diagnosis and Conditions/Contraindications into one Conditions box for print Cabecera
  const diag = document.getElementById('diagnostico').value || '';
  const cond = document.getElementById('condicion').value || '';
  let condCompleto = '';
  if (diag) condCompleto += `Diagnóstico: ${diag}\n`;
  if (cond) condCompleto += `Condiciones: ${cond}`;
  document.getElementById('print-val-condiciones-completo').textContent = condCompleto || 'Ninguna.';

  // Render Procedure Steps in Print Template
  const printProcedureTableBody = document.getElementById('print-procedure-table-body');
  if (printProcedureTableBody) {
    if (currentProcedureSteps.length === 0) {
      printProcedureTableBody.innerHTML = `
        <tr>
          <td colspan="5" class="py-6 px-3 text-center text-slate-400 italic">
            Ningún paso añadido al protocolo.
          </td>
        </tr>
      `;
    } else {
      printProcedureTableBody.innerHTML = '';
      currentProcedureSteps.forEach(step => {
        const trMain = document.createElement('tr');
        trMain.className = 'border-b border-slate-300';
        trMain.innerHTML = `
          <td class="py-2 px-3 font-bold text-slate-800 border-r border-slate-300">${step.fase}</td>
          <td class="py-2 px-3 font-semibold border-r border-slate-300">${step.name}</td>
          <td class="py-2 px-3 text-slate-600 border-r border-slate-300">${step.brand || '-'}</td>
          <td class="py-2 px-3 text-slate-650 border-r border-slate-300">${step.actives || '-'}</td>
          <td class="py-2 px-3 text-slate-700">${step.action || '-'}</td>
        `;
        
        const trApp = document.createElement('tr');
        trApp.className = 'border-b border-slate-300 bg-slate-50';
        trApp.innerHTML = `
          <td colspan="5" class="py-1.5 px-3 text-[9px] text-slate-500 italic">
            <strong>Descripción de aplicación:</strong> ${step.application || 'No especificada.'}
          </td>
        `;
        
        printProcedureTableBody.appendChild(trMain);
        printProcedureTableBody.appendChild(trApp);
      });
    }
  }

  // Handle signature images rendering in print view
  const imgEsp = document.getElementById('print-val-firma-especialista');
  const imgPac = document.getElementById('print-val-firma-paciente');

  if (signaturePadEspecialista && !signaturePadEspecialista.isEmpty()) {
    imgEsp.src = signaturePadEspecialista.toDataURL();
    imgEsp.classList.remove('hidden');
  } else {
    imgEsp.classList.add('hidden');
  }

  if (signaturePadPaciente && !signaturePadPaciente.isEmpty()) {
    imgPac.src = signaturePadPaciente.toDataURL();
    imgPac.classList.remove('hidden');
  } else {
    imgPac.classList.add('hidden');
  }
}

window.addEventListener('beforeprint', syncPrintView);

// Initialize Interactive Signature Canvas Pads
function initSignatures() {
  const canvasEsp = document.getElementById('canvas-firma-especialista');
  const canvasPac = document.getElementById('canvas-firma-paciente');
  
  if (canvasEsp && canvasPac) {
    signaturePadEspecialista = new SignaturePad(canvasEsp, {
      backgroundColor: 'rgba(0,0,0,0)',
      penColor: 'rgb(18, 18, 21)'
    });
    signaturePadPaciente = new SignaturePad(canvasPac, {
      backgroundColor: 'rgba(0,0,0,0)',
      penColor: 'rgb(18, 18, 21)'
    });

    // Listen to changes to save state
    signaturePadEspecialista.onEnd = () => {
      savedSignatureEsp = canvasEsp.toDataURL();
    };
    signaturePadPaciente.onEnd = () => {
      savedSignaturePac = canvasPac.toDataURL();
    };

    const resizeCanvas = () => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      
      const wEsp = canvasEsp.offsetWidth;
      const hEsp = canvasEsp.offsetHeight;
      canvasEsp.width = wEsp * ratio;
      canvasEsp.height = hEsp * ratio;
      canvasEsp.getContext("2d").scale(ratio, ratio);

      const wPac = canvasPac.offsetWidth;
      const hPac = canvasPac.offsetHeight;
      canvasPac.width = wPac * ratio;
      canvasPac.height = hPac * ratio;
      canvasPac.getContext("2d").scale(ratio, ratio);

      signaturePadEspecialista.clear();
      signaturePadPaciente.clear();

      if (savedSignatureEsp) {
        const img = new Image();
        img.src = savedSignatureEsp;
        img.onload = () => {
          canvasEsp.getContext("2d").drawImage(img, 0, 0, wEsp, hEsp);
        };
      }
      if (savedSignaturePac) {
        const img = new Image();
        img.src = savedSignaturePac;
        img.onload = () => {
          canvasPac.getContext("2d").drawImage(img, 0, 0, wPac, hPac);
        };
      }
    };

    window.addEventListener("resize", resizeCanvas);
    setTimeout(resizeCanvas, 300);
  }
}

window.clearSignature = function(who) {
  if (who === 'especialista' && signaturePadEspecialista) {
    signaturePadEspecialista.clear();
    savedSignatureEsp = null;
  } else if (who === 'paciente' && signaturePadPaciente) {
    signaturePadPaciente.clear();
    savedSignaturePac = null;
  }
};

// --- Interactive Facial Canvas functions ---
let activeFacialZones = {
  forehead: false,
  nose: false,
  chin: false,
  rightCheek: false,
  leftCheek: false,
  rightEye: false,
  leftEye: false,
  lips: false,
  neck: false
};

let canvasAnimationId = null;

function animateCanvas() {
  const canvas = document.getElementById('facial-diagnostic-canvas');
  if (!canvas) {
    canvasAnimationId = null;
    return;
  }
  const ctx = canvas.getContext('2d');

  // Redraw face silhouette and active markers first
  drawFacialSilhouette(ctx, canvas.width, canvas.height, activeFacialZones);

  if (activeRipples.length === 0) {
    canvasAnimationId = null;
    return;
  }

  // Render and update each ripple ring
  activeRipples = activeRipples.filter(ripple => {
    ctx.save();
    ctx.strokeStyle = `rgba(212, 175, 55, ${ripple.opacity})`;
    ctx.lineWidth = 2.0;
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#D4AF37';
    ctx.beginPath();
    ctx.arc(ripple.x, ripple.y, ripple.radius, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    ripple.radius += 1.3;
    ripple.opacity -= 0.025;

    return ripple.opacity > 0;
  });

  canvasAnimationId = requestAnimationFrame(animateCanvas);
}

// Keep track of the hovered zone key
let hoveredZoneKey = null;
let canvasMouseX = 0;
let canvasMouseY = 0;

function drawFacialSilhouette(ctx, width, height, activeZones) {
  ctx.clearRect(0, 0, width, height);

  const isDark = document.documentElement.classList.contains('dark');
  const accentColor = '#D4AF37';

  // Adaptive palette
  const strokeColor = isDark ? 'rgba(212, 175, 55, 0.25)' : 'rgba(71, 85, 105, 0.3)';
  const activeGlow = isDark ? 'rgba(212, 175, 55, 0.15)' : 'rgba(212, 175, 55, 0.08)';
  const hoverGlow = isDark ? 'rgba(212, 175, 55, 0.08)' : 'rgba(212, 175, 55, 0.04)';
  const pinOutline = isDark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(15, 23, 42, 0.45)';

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const cx = width / 2;
  const cy = height / 2;
  const scaleX = width / 250;
  const scaleY = height / 250;

  const p = (x, y) => ({
    x: cx + x * scaleX,
    y: cy + y * scaleY
  });

  // Name map for tooltip display
  const zoneNamesFriendly = {
    forehead: 'Frente',
    nose: 'Nariz',
    chin: 'Mentón',
    rightCheek: 'Mejilla Derecha',
    leftCheek: 'Mejilla Izquierda',
    rightEye: 'Contorno de Ojos Derecho',
    leftEye: 'Contorno de Ojos Izquierdo',
    lips: 'Contorno de Labios',
    neck: 'Cuello y Escote'
  };

  // Define polygons for all 9 zones
  const zonePolygons = {
    forehead: [p(-50, -85), p(-45, -75), p(-25, -77), p(25, -77), p(45, -75), p(50, -85), p(40, -92), p(0, -95), p(-40, -92)],
    nose: [p(-9, -23), p(9, -23), p(12, 10), p(0, 18), p(-12, 10)],
    chin: [p(-18, 48), p(18, 48), p(28, 62), p(15, 82), p(-15, 82), p(-28, 62)],
    rightCheek: [p(9, -23), p(25, -23), p(42, -10), p(62, -10), p(45, 55), p(18, 48), p(12, 10)],
    leftCheek: [p(-9, -23), p(-25, -23), p(-42, -10), p(-62, -10), p(-45, 55), p(-18, 48), p(-12, 10)],
    rightEye: [p(10, -28), p(40, -28), p(40, -18), p(10, -18)],
    leftEye: [p(-10, -28), p(-40, -28), p(-40, -18), p(-10, -18)],
    lips: [p(-22, 30), p(22, 30), p(22, 48), p(-22, 48)],
    neck: [p(-35, 58), p(35, 58), p(60, 110), p(55, 115), p(5, 122), p(-5, 122), p(-55, 115), p(-60, 110)]
  };

  // 1. Draw Glassmorphic Fills for zones (hover / active states)
  Object.keys(zonePolygons).forEach(key => {
    const poly = zonePolygons[key];
    const active = activeZones[key];
    const hovered = (key === hoveredZoneKey);

    if (active || hovered) {
      ctx.save();
      ctx.fillStyle = active ? activeGlow : hoverGlow;
      ctx.strokeStyle = active ? accentColor : 'transparent';
      ctx.lineWidth = 1;
      
      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i].x, poly[i].y);
      }
      ctx.closePath();
      ctx.fill();
      if (active) ctx.stroke();
      ctx.restore();
    }
  });

  // 2. Draw Diagnostic Wireframe Paths (Face Contour lines)
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.2;

  // Face Silhouette
  ctx.beginPath();
  const start = p(-40, -85);
  ctx.moveTo(start.x, start.y);
  ctx.bezierCurveTo(p(-15, -95).x, p(-15, -95).y, p(15, -95).x, p(15, -95).y, p(40, -85).x, p(40, -85).y);
  ctx.bezierCurveTo(p(50, -78).x, p(50, -78).y, p(55, -70).x, p(55, -70).y, p(55, -60).x, p(55, -60).y);
  ctx.bezierCurveTo(p(55, -45).x, p(55, -45).y, p(62, -28).x, p(62, -28).y, p(62, -10).x, p(62, -10).y);
  ctx.bezierCurveTo(p(62, 15).x, p(62, 15).y, p(58, 38).x, p(58, 38).y, p(45, 55).x, p(45, 55).y);
  ctx.bezierCurveTo(p(35, 70).x, p(35, 70).y, p(25, 80).x, p(25, 80).y, p(15, 82).x, p(15, 82).y);
  ctx.bezierCurveTo(p(0, 85).x, p(0, 85).y, p(-5, 85).x, p(-5, 85).y, p(-15, 82).x, p(-15, 82).y);
  ctx.bezierCurveTo(p(-25, 80).x, p(-25, 80).y, p(-35, 70).x, p(-35, 70).y, p(-45, 55).x, p(-45, 55).y);
  ctx.bezierCurveTo(p(-58, 38).x, p(-58, 38).y, p(-62, 15).x, p(-62, 15).y, p(-62, -10).x, p(-62, -10).y);
  ctx.bezierCurveTo(p(-62, -28).x, p(-62, -28).y, p(-55, -45).x, p(-55, -45).y, p(-55, -60).x, p(-55, -60).y);
  ctx.bezierCurveTo(p(-55, -70).x, p(-55, -70).y, p(-50, -78).x, p(-50, -78).y, start.x, start.y);
  ctx.closePath();
  ctx.stroke();

  // Neck lines
  ctx.beginPath();
  ctx.moveTo(p(-35, 58).x, p(-35, 58).y);
  ctx.bezierCurveTo(p(-38, 80).x, p(-38, 80).y, p(-48, 95).x, p(-48, 95).y, p(-60, 110).x, p(-60, 110).y);
  ctx.moveTo(p(35, 58).x, p(35, 58).y);
  ctx.bezierCurveTo(p(38, 80).x, p(38, 80).y, p(48, 95).x, p(48, 95).y, p(60, 110).x, p(60, 110).y);
  ctx.stroke();

  // Eyes (Simple diagnostic wireframe representation)
  const drawWireframeEye = (s) => {
    ctx.beginPath();
    ctx.moveTo(p(40 * s, -23).x, p(40 * s, -23).y);
    ctx.bezierCurveTo(p(32 * s, -28).x, p(32 * s, -28).y, p(22 * s, -28).x, p(22 * s, -28).y, p(14 * s, -23).x, p(14 * s, -23).y);
    ctx.bezierCurveTo(p(22 * s, -18).x, p(22 * s, -18).y, p(32 * s, -18).x, p(32 * s, -18).y, p(40 * s, -23).x, p(40 * s, -23).y);
    ctx.closePath();
    ctx.stroke();

    // Pupil
    ctx.beginPath();
    ctx.arc(p(27 * s, -23).x, p(27 * s, -23).y, 2.5, 0, 2 * Math.PI);
    ctx.stroke();
  };
  drawWireframeEye(-1);
  drawWireframeEye(1);

  // Eyebrows
  ctx.beginPath();
  ctx.moveTo(p(-43, -34).x, p(-43, -34).y);
  ctx.quadraticCurveTo(p(-27, -39).x, p(-27, -39).y, p(-12, -31).x, p(-12, -31).y);
  ctx.moveTo(p(43, -34).x, p(43, -34).y);
  ctx.quadraticCurveTo(p(27, -39).x, p(27, -39).y, p(12, -31).x, p(12, -31).y);
  ctx.stroke();

  // Nose Bridge & Flares
  ctx.beginPath();
  ctx.moveTo(p(-6, -23).x, p(-6, -23).y);
  ctx.lineTo(p(-5, 8).x, p(-5, 8).y);
  ctx.bezierCurveTo(p(-5, 14).x, p(-5, 14).y, p(5, 14).x, p(5, 14).y, p(5, 8).x, p(5, 8).y);
  ctx.lineTo(p(6, -23).x, p(6, -23).y);
  ctx.stroke();

  // Lips
  ctx.beginPath();
  ctx.moveTo(p(-20, 36).x, p(-20, 36).y);
  ctx.quadraticCurveTo(p(0, 30).x, p(0, 30).y, p(20, 36).x, p(20, 36).y);
  ctx.quadraticCurveTo(p(0, 44).x, p(0, 44).y, p(-20, 36).x, p(-20, 36).y);
  ctx.closePath();
  ctx.stroke();

  // 3. Render Active Diagnostic Indicators (Pins & Circles)
  const pinCenters = {
    forehead: p(0, -60),
    nose: p(0, 0),
    chin: p(0, 62),
    rightCheek: p(31, 8),
    leftCheek: p(-31, 8),
    rightEye: p(27, -23),
    leftEye: p(-27, -23),
    lips: p(0, 36),
    neck: p(0, 95)
  };

  for (const [key, val] of Object.entries(pinCenters)) {
    const active = activeZones[key];
    
    if (active) {
      ctx.save();
      // Glowing focus indicator core
      ctx.shadowBlur = 15;
      ctx.shadowColor = accentColor;
      ctx.fillStyle = accentColor;
      ctx.beginPath();
      ctx.arc(val.x, val.y, 6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();

      // Sharp accent outer ring
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(val.x, val.y, 11, 0, 2 * Math.PI);
      ctx.stroke();
    } else {
      // Neutral glassmorphic indicator
      ctx.save();
      ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(15, 23, 42, 0.08)';
      ctx.beginPath();
      ctx.arc(val.x, val.y, 5, 0, 2 * Math.PI);
      ctx.fill();

      ctx.strokeStyle = pinOutline;
      ctx.lineWidth = 1.0;
      ctx.stroke();
      ctx.restore();
    }
  }

  // 4. Render Dynamic Hovered Tooltip Tag
  if (hoveredZoneKey && zoneNamesFriendly[hoveredZoneKey]) {
    ctx.save();
    const tooltipText = zoneNamesFriendly[hoveredZoneKey];
    ctx.font = '10px Urbanist, sans-serif';
    const textWidth = ctx.measureText(tooltipText).width;
    
    const tx = canvasMouseX + 12;
    const ty = canvasMouseY - 12;

    // Draw glass card background
    ctx.fillStyle = isDark ? 'rgba(18, 18, 21, 0.85)' : 'rgba(255, 255, 255, 0.9)';
    ctx.strokeStyle = isDark ? 'rgba(212, 175, 55, 0.4)' : 'rgba(71, 85, 105, 0.25)';
    ctx.lineWidth = 1;
    
    ctx.beginPath();
    ctx.roundRect(tx - 6, ty - 15, textWidth + 12, 20, 6);
    ctx.fill();
    ctx.stroke();

    // Draw text
    ctx.fillStyle = isDark ? '#FAF9F6' : '#1E293B';
    ctx.fillText(tooltipText, tx, ty - 1);
    ctx.restore();
  }
}

function initFacialCanvas() {
  const canvas = document.getElementById('facial-diagnostic-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  
  const resizeAndDraw = () => {
    const parent = canvas.parentElement;
    let size = Math.min(parent.clientWidth - 32, parent.clientHeight - 32, 230);
    if (size <= 100) {
      size = 230; // Safeguard if parent collapsed on init
    }
    canvas.width = size;
    canvas.height = size;
    drawFacialSilhouette(ctx, canvas.width, canvas.height, activeFacialZones);
  };

  window.addEventListener('resize', resizeAndDraw);
  setTimeout(resizeAndDraw, 100);

  const themeObserver = new MutationObserver(() => {
    resizeAndDraw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  const zoneTags = {
    forehead: '[Frente: Línea Frontal]',
    nose: '[Nariz: Cresta Nasal]',
    leftCheek: '[Mejilla Derecha: Zona Malar]',
    rightCheek: '[Mejilla Izquierda: Zona Malar]',
    chin: '[Mentón: Región Mental]',
    leftEye: '[Contorno de Ojos Izquierdo: Rim Orbital]',
    rightEye: '[Contorno de Ojos Derecho: Rim Orbital]',
    lips: '[Contorno de Labios: Zona Perioral]',
    neck: '[Cuello y Escote: Región Cervical]'
  };

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const scaleX = canvas.width / 250;
    const scaleY = canvas.height / 250;

    const zones = {
      forehead: { x: cx + 0 * scaleX, y: cy - 60 * scaleY },
      nose: { x: cx + 0 * scaleX, y: cy + 0 * scaleY },
      chin: { x: cx + 0 * scaleX, y: cy + 62 * scaleY },
      rightCheek: { x: cx + 31 * scaleX, y: cy + 8 * scaleY },
      leftCheek: { x: cx - 31 * scaleX, y: cy + 8 * scaleY },
      rightEye: { x: cx + 27 * scaleX, y: cy - 23 * scaleY },
      leftEye: { x: cx - 27 * scaleX, y: cy - 23 * scaleY },
      lips: { x: cx + 0 * scaleX, y: cy + 36 * scaleY },
      neck: { x: cx + 0 * scaleX, y: cy + 95 * scaleY }
    };

    let closestZone = null;
    let minDist = Infinity;

    for (const [key, val] of Object.entries(zones)) {
      const d = Math.hypot(x - val.x, y - val.y);
      if (d < minDist) {
        minDist = d;
        closestZone = key;
      }
    }

    if (closestZone && minDist < 25) {
      activeFacialZones[closestZone] = !activeFacialZones[closestZone];
      
      // Push hardware-accelerated scanning pulse ripple
      const targetPt = zones[closestZone];
      if (typeof activeRipples === 'undefined') {
        window.activeRipples = [];
      }
      activeRipples.push({
        x: targetPt.x,
        y: targetPt.y,
        radius: 8,
        opacity: 0.6
      });

      if (!canvasAnimationId) {
        canvasAnimationId = requestAnimationFrame(animateCanvas);
      }

      const textarea = document.getElementById('diagnostico');
      if (textarea) {
        const tag = zoneTags[closestZone];
        let currentText = textarea.value;
        if (activeFacialZones[closestZone]) {
          if (!currentText.includes(tag)) {
            textarea.value = currentText ? `${currentText} ${tag}` : tag;
          }
        } else {
          textarea.value = currentText.replace(new RegExp('\\s*' + escapeRegExp(tag), 'g'), '').trim();
        }
        textarea.dispatchEvent(new Event('input'));
      }
    }
  });

  // Track hover state for polygonal highlighting and tooltips
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    canvasMouseX = x;
    canvasMouseY = y;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const scaleX = canvas.width / 250;
    const scaleY = canvas.height / 250;

    const p = (x, y) => ({
      x: cx + x * scaleX,
      y: cy + y * scaleY
    });

    const zones = {
      forehead: { x: cx + 0 * scaleX, y: cy - 60 * scaleY },
      nose: { x: cx + 0 * scaleX, y: cy + 0 * scaleY },
      chin: { x: cx + 0 * scaleX, y: cy + 62 * scaleY },
      rightCheek: { x: cx + 31 * scaleX, y: cy + 8 * scaleY },
      leftCheek: { x: cx - 31 * scaleX, y: cy + 8 * scaleY },
      rightEye: { x: cx + 27 * scaleX, y: cy - 23 * scaleY },
      leftEye: { x: cx - 27 * scaleX, y: cy - 23 * scaleY },
      lips: { x: cx + 0 * scaleX, y: cy + 36 * scaleY },
      neck: { x: cx + 0 * scaleX, y: cy + 95 * scaleY }
    };

    let closestZone = null;
    let minDist = Infinity;

    for (const [key, val] of Object.entries(zones)) {
      const d = Math.hypot(x - val.x, y - val.y);
      if (d < minDist) {
        minDist = d;
        closestZone = key;
      }
    }

    const prevHovered = hoveredZoneKey;
    if (closestZone && minDist < 25) {
      hoveredZoneKey = closestZone;
      canvas.style.cursor = 'pointer';
    } else {
      hoveredZoneKey = null;
      canvas.style.cursor = 'default';
    }

    if (hoveredZoneKey !== prevHovered || hoveredZoneKey !== null) {
      drawFacialSilhouette(ctx, canvas.width, canvas.height, activeFacialZones);
    }
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredZoneKey = null;
    drawFacialSilhouette(ctx, canvas.width, canvas.height, activeFacialZones);
  });
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Export to Premium PDF via html2pdf
window.exportToPDF = function() {
  const nombre = document.getElementById('nombre').value || '__________________________________';
  const fecha = document.getElementById('fecha').value || '__________________';
  const biotipo = document.getElementById('biotipo').value || '__________________';
  const diagnostico = document.getElementById('diagnostico').value || 'No especificado.';
  const condicion = document.getElementById('condicion').value || 'Ninguna.';
  const edad = document.getElementById('edad').value || '___';
  const protocolo = document.getElementById('protocolo').value || 'No especificado.';
  const docTitle = document.getElementById('current-doc-id').textContent || 'Prescripción de Activos';
  
  const mainTableBody = document.getElementById('results-table-body');
  let tableRowsHtml = '';
  if (mainTableBody) {
    tableRowsHtml = mainTableBody.innerHTML;
  }

  let aiRoutineHtml = '';
  const aiContent = document.getElementById('ai-recommendation-content');
  const aiContainer = document.getElementById('ai-recommendation-container');
  if (aiContent && aiContainer && !aiContainer.classList.contains('hidden') && aiContent.textContent.trim() !== '') {
    aiRoutineHtml = `
      <div style="margin-top: 10px; padding: 10px; background: #fafaf9; border: 1px solid #e5e5e0; border-radius: 8px;">
        <span class="pdf-specs-title" style="margin-bottom: 4px; display: block;">Recomendación Inteligente de la IA</span>
        <p style="font-size: 8px; color: #333; line-height: 1.25; margin: 0; white-space: pre-wrap; font-weight: 500;">${aiContent.innerText}</p>
      </div>
    `;
  }

  let signatureEspImg = '';
  let signaturePacImg = '';
  if (signaturePadEspecialista && !signaturePadEspecialista.isEmpty()) {
    signatureEspImg = `<img class="signature-img" src="${signaturePadEspecialista.toDataURL()}" alt="Firma Especialista">`;
  }
  if (signaturePadPaciente && !signaturePadPaciente.isEmpty()) {
    signaturePacImg = `<img class="signature-img" src="${signaturePadPaciente.toDataURL()}" alt="Firma Paciente">`;
  }

  const filename = `Ficha_Estetica_${nombre.trim().replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.pdf`;

  // Create isolated sandbox container for PDF generation to bypass any browser zoom or responsive screen dimensions
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.style.width = '800px';
  container.style.height = '1000px';
  container.style.zIndex = '-99999';

  container.innerHTML = `
    <div style="
      width: 800px;
      height: 1000px !important;
      padding: 25px 40px;
      background: #ffffff;
      color: #121215;
      font-family: 'Urbanist', sans-serif;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      overflow: hidden !important;
    ">
      <!-- Embedded custom styling independent of tailwind or print media query -->
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=Urbanist:wght@400;500;600;700&display=swap');
        .pdf-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 2px solid #D4AF37;
          padding-bottom: 8px;
          margin-bottom: 12px;
        }
        .pdf-header-left {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .pdf-logo {
          width: 32px;
          height: 32px;
          border-radius: 6px;
          background: #121215;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pdf-logo svg {
          width: 18px;
          height: 18px;
          color: #D4AF37;
        }
        .pdf-brand-name {
          font-family: 'Sora', sans-serif;
          font-size: 16px;
          font-weight: 700;
          margin: 0;
          color: #121215;
        }
        .pdf-brand-sub {
          font-size: 8px;
          text-transform: uppercase;
          letter-spacing: 1px;
          color: #666;
          margin: 1px 0 0 0;
          font-weight: 600;
        }
        .pdf-header-right {
          text-align: right;
        }
        .pdf-doc-title {
          font-family: 'Sora', sans-serif;
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1.5px;
          color: #121215;
          margin: 0;
        }
        .pdf-doc-sub {
          font-size: 8px;
          color: #666;
          margin: 1px 0 0 0;
        }
        .pdf-demo-grid {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 12px;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid #e2e8f0;
        }
        .pdf-demo-item {
          display: flex;
          flex-direction: column;
        }
        .pdf-demo-label {
          font-size: 7.5px;
          font-weight: 750;
          color: #999;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 2px;
        }
        .pdf-demo-value {
          font-size: 10.5px;
          font-weight: 700;
          color: #121215;
        }
        .pdf-details-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
          margin-bottom: 12px;
        }
        .pdf-detail-card {
          background: #fafaf9;
          border: 1px solid #e5e5e0;
          border-radius: 8px;
          padding: 10px;
          min-height: 70px;
        }
        .pdf-detail-title {
          font-size: 7.5px;
          font-weight: 750;
          color: #999;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 3px;
          display: block;
        }
        .pdf-detail-content {
          font-size: 10px;
          color: #333;
          line-height: 1.3;
          margin: 0;
          white-space: pre-wrap;
          font-weight: 500;
        }
        .pdf-specs-section {
          margin-bottom: 12px;
        }
        .pdf-specs-title {
          font-size: 7.5px;
          font-weight: 750;
          color: #999;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin-bottom: 4px;
          display: block;
        }
        .pdf-specs-table-wrapper {
          border: 1px solid #e2e8f0;
          border-radius: 8px;
          overflow: hidden;
        }
        .pdf-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 10px;
        }
        .pdf-table th {
          background-color: #fafaf9;
          border-bottom: 1px solid #e2e8f0;
          color: #666;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 1px;
          font-size: 8px;
          padding: 6px 12px;
          text-align: left;
        }
        .pdf-table td {
          padding: 6px 12px !important;
          border-bottom: 1px solid #e2e8f0 !important;
          color: #333333 !important;
          font-size: 10px !important;
          font-weight: 500 !important;
          background: transparent !important;
        }
        .pdf-table tr:last-child td {
          border-bottom: none !important;
        }
        .pdf-footer {
          border-top: 1px solid #e2e8f0;
          padding-top: 10px;
          page-break-inside: avoid !important;
        }
        .pdf-consent {
          font-size: 7px;
          color: #999;
          line-height: 1.25;
          font-style: italic;
          margin-bottom: 12px;
        }
        .pdf-sigs-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 40px;
          page-break-inside: avoid !important;
        }
        .pdf-sig-col {
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          page-break-inside: avoid !important;
        }
        .pdf-sig-box {
          width: 180px;
          height: 40px;
          border-bottom: 1px solid #999;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          margin-bottom: 4px;
        }
        .pdf-sig-box img {
          max-height: 100%;
          max-width: 100%;
          object-fit: contain;
          margin-bottom: 4px;
        }
        .pdf-sig-title {
          font-size: 8px;
          font-weight: 700;
          color: #333;
          text-transform: uppercase;
          letter-spacing: 1px;
          margin: 0;
        }
        .pdf-sig-sub {
          font-size: 7px;
          color: #999;
          margin: 1px 0 0 0;
        }
      </style>

      <div>
        <!-- Header -->
        <div class="pdf-header">
          <div class="pdf-header-left">
            <img src="https://raw.githubusercontent.com/carlosgbd94-design/Logos/refs/heads/main/logo_xarixuri_cosmetolog_a-removebg-preview.png" style="height: 38px; width: auto; object-fit: contain;">
          </div>
          <div class="pdf-header-right">
            <h2 class="pdf-doc-title">${docTitle}</h2>
            <p class="pdf-doc-sub">Clínica de Estética Especializada</p>
          </div>
        </div>

        <!-- Demographics -->
        <div class="pdf-demo-grid">
          <div class="pdf-demo-item" style="grid-column: span 2">
            <span class="pdf-demo-label">Paciente</span>
            <span class="pdf-demo-value">${nombre}</span>
          </div>
          <div class="pdf-demo-item">
            <span class="pdf-demo-label">Edad</span>
            <span class="pdf-demo-value">${edad} años</span>
          </div>
          <div class="pdf-demo-item">
            <span class="pdf-demo-label">Fecha de Consulta</span>
            <span class="pdf-demo-value">${fecha}</span>
          </div>
          <div class="pdf-demo-item">
            <span class="pdf-demo-label">Biotipo Cutáneo</span>
            <span class="pdf-demo-value">${biotipo}</span>
          </div>
        </div>

        <!-- Protocolo -->
        <div style="margin-bottom: 12px; padding: 10px; background: #fafaf9; border: 1px solid #e5e5e0; border-radius: 8px;">
          <span class="pdf-demo-label" style="display:block; margin-bottom: 2px;">Protocolo / Objetivo Recomendado</span>
          <span class="pdf-demo-value" style="font-size: 11px;">${protocolo}</span>
        </div>

        <!-- Details -->
        <div class="pdf-details-grid">
          <div class="pdf-detail-card">
            <span class="pdf-detail-title">Diagnóstico Clínico</span>
            <p class="pdf-detail-content">${diagnostico}</p>
          </div>
          <div class="pdf-detail-card">
            <span class="pdf-detail-title">Condición / Contraindicaciones</span>
            <p class="pdf-detail-content">${condicion}</p>
          </div>
        </div>

        <!-- Product Specs -->
        <div class="pdf-specs-section">
          <span class="pdf-specs-title">Detalles Técnicos del Producto Prescrito</span>
          <div class="pdf-specs-table-wrapper">
            <table class="pdf-table">
              <thead>
                <tr>
                  <th style="width: 33%">Parámetro</th>
                  <th>Valor Técnico</th>
                </tr>
              </thead>
              <tbody>
                ${tableRowsHtml}
              </tbody>
            </table>
          </div>
        </div>
        ${aiRoutineHtml}
      </div>

      <!-- Footer -->
      <div class="pdf-footer">
        <p class="pdf-consent">
          *Nota de Consentimiento Clínico: Al firmar esta ficha, el especialista confirma haber valorado clínicamente el biotipo cutáneo del paciente y haber seleccionado los activos recomendados. El paciente certifica estar de acuerdo con las recomendaciones cosméticas detalladas y declara no poseer alergias conocidas a los ingredientes descritos.
        </p>
        <div class="pdf-sigs-grid">
          <div class="pdf-sig-col">
            <div class="pdf-sig-box">
              ${signatureEspImg}
            </div>
            <h3 class="pdf-sig-title">Firma del Especialista</h3>
            <span class="pdf-sig-sub">Cédula y Diagnóstico Técnico</span>
          </div>
          <div class="pdf-sig-col">
            <div class="pdf-sig-box">
              ${signaturePacImg}
            </div>
            <h3 class="pdf-sig-title">Firma del Paciente</h3>
            <span class="pdf-sig-sub">Consentimiento de Aplicación</span>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(container);

  const opt = {
    margin:       0,
    filename:     filename,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { 
      scale: 2.5, 
      useCORS: true, 
      logging: false,
      width: 800,
      height: 1000
    },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' },
    pagebreak:    { mode: 'avoid-all' }
  };

  html2pdf().set(opt).from(container.firstElementChild).save().then(() => {
    showToast('Ficha PDF descargada con éxito.', 'success');
  }).catch(err => {
    console.error(err);
    showToast('Error al generar PDF.', 'error');
  }).finally(() => {
    container.remove();
  });
};

// --- ApexCharts Patient Diagnostics Analytics Dashboard ---
let biotypeChartInstance = null;

function updateBiotypeChart(records) {
  const counts = {
    "Eudérmica / Normal": 0,
    "Seca / Alípica": 0,
    "Grasa deshidratada": 0,
    "Grasa seborreica": 0,
    "Mixta": 0,
    "Sensible / Rosácea": 0
  };
  
  let total = 0;
  records.forEach(r => {
    if (r.biotipo && r.biotipo in counts) {
      counts[r.biotipo]++;
      total++;
    }
  });

  document.getElementById('stats-total-patients').textContent = total;
  
  // Find predominant biotype
  let maxVal = -1;
  let maxBiotipo = 'Ninguno';
  Object.keys(counts).forEach(k => {
    if (counts[k] > maxVal && counts[k] > 0) {
      maxVal = counts[k];
      maxBiotipo = k;
    }
  });
  document.getElementById('stats-predominant-biotype').textContent = maxBiotipo;

  const categories = Object.keys(counts);
  const data = Object.values(counts);

  const options = {
    chart: {
      type: 'donut',
      height: '100%',
      fontFamily: 'Urbanist, sans-serif'
    },
    colors: ['#D4AF37', '#B5902B', '#E5C453', '#121215', '#444444', '#8C6E20'],
    series: data,
    labels: categories,
    stroke: {
      show: true,
      colors: ['#FAF9F6'],
      width: 2
    },
    legend: {
      position: 'right',
      labels: {
        colors: '#666666'
      }
    },
    responsive: [{
      breakpoint: 480,
      options: {
        legend: {
          position: 'bottom'
        }
      }
    }]
  };

  const chartContainer = document.getElementById('biotype-chart');
  if (chartContainer) {
    if (biotypeChartInstance) {
      biotypeChartInstance.destroy();
    }
    biotypeChartInstance = new ApexCharts(chartContainer, options);
    biotypeChartInstance.render();
  }
}

// --- Public Cosmetics API Lookup & Ingestion (Makeup API) ---
let apiIngestionData = [];

window.fetchFromPublicAPI = async function() {
  const brandSelect = document.getElementById('api-brand-select');
  const selectedBrand = brandSelect.value;
  
  if (!selectedBrand) {
    showToast('Por favor, selecciona una marca de cosméticos.', 'error');
    return;
  }

  showToast('Consultando base de datos de cosméticos...', 'success');
  
  try {
    const response = await fetch(`https://makeup-api.herokuapp.com/api/v1/products.json?brand=${selectedBrand}`);
    if (!response.ok) throw new Error('API Error');
    const data = await response.json();

    if (!data || data.length === 0) {
      showToast('No se encontraron productos para esta marca.', 'error');
      return;
    }

    const previewContainer = document.getElementById('api-preview-container');
    const previewTableBody = document.getElementById('api-preview-table-body');
    const apiRowCount = document.getElementById('api-row-count');

    // Filter and map to local format
    apiIngestionData = data.slice(0, 15).map((item, idx) => {
      // Map API categories to local categories
      let cat = 'Crema/Gel';
      if (item.product_type === 'mascara' || item.product_type === 'eyeshadow') cat = 'Ojos/Labios';
      else if (item.product_type === 'eyebrow' || item.product_type === 'eyeliner') cat = 'Ojos/Labios';
      else if (item.product_type === 'cleanser') cat = 'Limpiador';
      else if (item.product_type === 'lipstick' || item.product_type === 'lip_liner') cat = 'Ojos/Labios';

      // Generate sequence code
      const prefix = cat.substring(0, 3).toUpperCase();
      const code = `${prefix}-API-${idx + 100}`;

      const price = parseFloat(item.price) || 0.0;

      return {
        id: code,
        name: item.name || 'Producto Cosmético',
        brand: item.brand ? item.brand.charAt(0).toUpperCase() + item.brand.slice(1) : 'Genérica',
        category: cat,
        capacity: '50 ml',
        price_aesthetic: price * 0.7, // wholesale discount
        price_public: price,
        active_ingredients: (item.tag_list && item.tag_list.length > 0) ? item.tag_list.join(', ') : 'Extractos Naturales',
        skin_indication: 'Todo tipo de piel'
      };
    });

    previewTableBody.innerHTML = '';
    apiIngestionData.forEach(r => {
      const tr = document.createElement('tr');
      tr.className = 'border-b border-slate-100 dark:border-white/5';
      tr.innerHTML = `
        <td class="py-2 px-4 font-bold text-slate-800 dark:text-white">${r.id}</td>
        <td class="py-2 px-4 font-semibold text-slate-700 dark:text-luxe-300">${r.name}</td>
        <td class="py-2 px-4 text-slate-600 dark:text-luxe-400">${r.brand}</td>
        <td class="py-2 px-4 text-slate-600 dark:text-luxe-400">${r.category}</td>
        <td class="py-2 px-4 text-emerald-700 font-bold">${formatCurrency(r.price_public)}</td>
      `;
      previewTableBody.appendChild(tr);
    });

    apiRowCount.textContent = `${apiIngestionData.length} productos listos`;
    previewContainer.classList.remove('hidden');
  } catch (err) {
    console.error(err);
    showToast('Error al conectar con la base de datos pública.', 'error');
  }
};

window.confirmAPIImport = async function() {
  if (apiIngestionData.length === 0) return;
  
  const btn = document.querySelector('#api-lookup-section button[onclick="confirmAPIImport()"]');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Importando...';
  }

  try {
    const insertStatements = [];

    for (const r of apiIngestionData) {
      insertStatements.push({
        sql: `
          INSERT INTO products (id, brand, name, category, capacity, price_aesthetic, price_public, active_ingredients, skin_indication)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            brand = excluded.brand,
            name = excluded.name,
            category = excluded.category,
            capacity = excluded.capacity,
            price_aesthetic = excluded.price_aesthetic,
            price_public = excluded.price_public,
            active_ingredients = excluded.active_ingredients,
            skin_indication = excluded.skin_indication,
            updated_at = CURRENT_TIMESTAMP
        `,
        args: [
          r.id,
          r.brand,
          r.name,
          r.category,
          r.capacity,
          r.price_aesthetic,
          r.price_public,
          r.active_ingredients,
          r.skin_indication
        ]
      });
    }

    if (insertStatements.length > 0) {
      await executeBatch(insertStatements);
    }

    showToast(`Se importaron ${apiIngestionData.length} productos de la API de cosméticos.`, 'success');
    document.getElementById('api-preview-container').classList.add('hidden');
    apiIngestionData = [];

    loadBrands();
    loadCatalogList();
  } catch (err) {
    console.error(err);
    showToast('Error al guardar datos de la API en Turso.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Importar Productos a la Base de Datos';
    }
  }
};

// --- Clinical AI Prescription & Offline synchronization ---
window.generarPrescripcionIA = async function() {
  const diagnostico = document.getElementById('diagnostico').value;
  const condicion = document.getElementById('condicion').value || 'Ninguna';
  const biotipo = document.getElementById('biotipo').value || 'No especificado';
  
  if (!diagnostico) {
    showToast('Por favor ingrese un diagnóstico para que la IA genere la recomendación.', 'error');
    return;
  }

  const btn = document.getElementById('btn-generar-ia');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span>✨ Generando recomendación con IA...</span>';

  // Get active face zones from global state
  const activeZonesList = Object.keys(activeFacialZones)
    .filter(k => activeFacialZones[k])
    .map(k => {
      const zNames = { 
        forehead: 'Frente', 
        nose: 'Nariz', 
        leftCheek: 'Mejilla Derecha', // Map to Mejilla Derecha / Izquierda as per 9-zone spec
        rightCheek: 'Mejilla Izquierda',
        chin: 'Mentón',
        leftEye: 'Contorno de Ojos Izquierdo',
        rightEye: 'Contorno de Ojos Derecho',
        lips: 'Contorno de Labios',
        neck: 'Cuello y Escote'
      };
      return zNames[k] || k;
    }).join(', ');

  // Check if forehead, nose, or chin are selected to set background flag for Zona T profile
  const hasZonaT = activeFacialZones.forehead || activeFacialZones.nose || activeFacialZones.chin;
  const zonaTFlag = hasZonaT ? "\n[BACKGROUND FLAG: El paciente presenta afecciones activas en la Zona T (Frente, Nariz o Mentón), considera este perfil en las recomendaciones de equilibrio de sebo.]" : "";

  // Format products context
  const productsCtx = allProducts.map(p => `- ID: ${p.id} | Marca: ${p.brand} | Nombre: ${p.name} | Activos: ${p.active_ingredients} | Indicación: ${p.skin_indication}`).join('\n');

  const prompt = `Eres un experto Cosmiatra y Cosmetólogo Médico.
Analiza la siguiente información del paciente:
- Biotipo Cutáneo: ${biotipo}
- Diagnóstico Clínico: ${diagnostico}
- Condición / Contraindicaciones: ${condicion}
- Zonas faciales con afecciones activas: ${activeZonesList || 'Ninguna específica'}${zonaTFlag}

El catálogo de productos disponibles en inventario es el siguiente:
${productsCtx}

Tu tarea:
1. Diseña una rutina de Skincare de Mañana (Morning) y Noche (Night) estructurada.
2. Utiliza ÚNICAMENTE los productos que existen en el catálogo de productos anterior. No inventes productos.
3. Para cada producto prescrito, justifica su uso mencionando sus ingredientes activos clave en relación con la zona facial afectada o el diagnóstico.
4. Mantén la respuesta con formato limpio, claro, y profesional en español. No uses negritas Markdown (asteriscos).

Escribe la respuesta directamente.`;

  // Get target containers and render skeleton loader
  const container = document.getElementById('ai-recommendation-container');
  const content = document.getElementById('ai-recommendation-content');
  const printContent = document.getElementById('ai-recommendation-print-content');
  const printContainer = document.getElementById('ai-recommendation-print');

  if (container) container.classList.remove('hidden');
  if (content) {
    content.innerHTML = `
      <div class="space-y-3">
        <div class="h-4 skeleton-shimmer rounded w-3/4"></div>
        <div class="h-4 skeleton-shimmer rounded w-5/6"></div>
        <div class="h-4 skeleton-shimmer rounded w-1/2"></div>
        <div class="h-4 skeleton-shimmer rounded w-2/3"></div>
      </div>
    `;
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=AIzaSyCSHrOfPNKR62SZ7X2TsIvDr1WUFEQ8ySo`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          temperature: 0.2
        }
      })
    });

    if (!response.ok) {
      throw new Error(`API response error: ${response.status}`);
    }

    const data = await response.json();
    const resultText = data.candidates[0].content.parts[0].text;

    if (content) content.innerText = resultText;

    if (printContent && printContainer) {
      printContent.innerText = resultText;
      printContainer.classList.remove('hidden');
    }

    showToast('Prescripción con IA generada con éxito.', 'success');
  } catch (error) {
    console.error(error);
    showToast('Error al conectar con la IA de Gemini.', 'error');
    if (content) {
      content.innerHTML = `
        <div class="p-4 rounded-xl border border-red-500/20 bg-red-500/5 dark:bg-red-500/10 text-red-600 dark:text-red-400 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div class="flex items-center gap-2 text-xs font-semibold">
            <i data-lucide="alert-circle" class="w-4 h-4"></i>
            <span>La conexión con la IA ha fallado o se agotó el tiempo.</span>
          </div>
          <button onclick="generarPrescripcionIA()" class="px-4 py-2 bg-red-600 dark:bg-red-500 hover:brightness-110 text-white dark:text-luxe-950 font-bold rounded-lg text-xs transition-all shadow-sm">
            Reintentar generación
          </button>
        </div>
      `;
      lucide.createIcons();
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.addEventListener('online', async () => {
  updateSyncBadge('syncing');
  showToast('Conexión restablecida. Sincronizando datos...', 'success');
  
  // Sync products from Turso to Dexie
  try {
    const res = await executeQuery("SELECT * FROM products ORDER BY name ASC");
    allProducts = res.rows;
    await db.products.clear();
    await db.products.bulkPut(allProducts);
    updateFuseIndex();
    renderCatalogTable(allProducts);
    populateFilterSelects(allProducts);
    loadBrandsLocal();
  } catch (err) {
    console.error('Error syncing products: ', err);
  }

  // Sync unsynced patient sheets to Turso
  try {
    const unsynced = await db.fichas_pacientes.where('synced').equals(0).toArray();
    for (const record of unsynced) {
      await executeQuery(
        'INSERT INTO fichas_pacientes (nombre, edad, fecha, biotipo, diagnostico, condicion, protocolo, protocolo_id, firma_especialista, firma_paciente, titulo_ficha, autor_ficha, pasos_preliminares, procedimiento_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [record.nombre, record.edad, record.fecha, record.biotipo, record.diagnostico, record.condicion, record.protocolo, record.protocolo_id, record.firma_especialista, record.firma_paciente, record.titulo_ficha, record.autor_ficha, record.pasos_preliminares, record.procedimiento_json]
      );
      await db.fichas_pacientes.update(record.id, { synced: 1 });
    }
    if (unsynced.length > 0) {
      showToast(`${unsynced.length} fichas pendientes sincronizadas con éxito.`, 'success');
      loadHistory();
    }
  } catch (err) {
    console.error('Error syncing patient sheets: ', err);
    showToast('Error al sincronizar fichas pendientes.', 'error');
  } finally {
    updateSyncBadge();
  }
});

window.addEventListener('offline', () => {
  showToast('Modo sin conexión activado.', 'warning');
  updateSyncBadge();
});

// --- Enterprise-Grade Clinical Apparatus Modules ---

const APPARATUS_REGISTRY = CONFIG.APPARATUS_REGISTRY;

function updateApparatusSuggestions() {
  const diagText = document.getElementById('diagnostico').value;
  if (!diagText) {
    const badge = document.getElementById('apparatus-recommendation-badge');
    if (badge) badge.classList.add('hidden');
    return;
  }

  const matched = [];
  
  // Flatten registry to a searchable structure for Fuse.js
  const searchList = [];
  for (const [key, details] of Object.entries(APPARATUS_REGISTRY)) {
    details.targets.forEach(target => {
      searchList.push({
        apparatus: key,
        target: target
      });
    });
  }

  // Use Fuse.js if available
  if (typeof Fuse !== 'undefined') {
    const fuse = new Fuse(searchList, {
      keys: ['target'],
      threshold: 0.4
    });
    
    // Split diagnostics into words/segments to search
    const words = diagText.split(/[\s,.:;()]+/);
    words.forEach(word => {
      if (word.length > 3) {
        const results = fuse.search(word);
        results.forEach(res => {
          if (!matched.includes(res.item.apparatus)) {
            matched.push(res.item.apparatus);
          }
        });
      }
    });
  } else {
    // Fallback direct match
    const normalizedDiag = normalizeText(diagText);
    for (const [key, details] of Object.entries(APPARATUS_REGISTRY)) {
      for (const target of details.targets) {
        if (normalizedDiag.includes(normalizeText(target))) {
          matched.push(key);
          break;
        }
      }
    }
  }

  const badge = document.getElementById('apparatus-recommendation-badge');
  if (!badge) return;

  if (matched.length > 0) {
    badge.innerHTML = `Recomendado: ${matched.join(', ')}`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function generateClinicalFolio(patientName) {
  const datePart = new Date().toISOString().slice(0, 7).replace('-', '');
  const hex = Math.floor(Date.now() % 65536).toString(16).toUpperCase().padStart(4, '0');
  return `DP-${datePart}-${hex}`;
}

function populateStepperDropdowns(products) {
  const select1 = document.getElementById('stepper-phase-1-product');
  const select3 = document.getElementById('stepper-phase-3-product');
  if (!select1 || !select3) return;

  select1.innerHTML = '<option value="">Seleccione fórmula limpiadora...</option>';
  select3.innerHTML = '<option value="">Seleccione sellador / protector...</option>';

  products.forEach(p => {
    const opt1 = document.createElement('option');
    opt1.value = p.id;
    opt1.textContent = `[${p.brand}] ${p.name}`;
    select1.appendChild(opt1);

    const opt3 = document.createElement('option');
    opt3.value = p.id;
    opt3.textContent = `[${p.brand}] ${p.name}`;
    select3.appendChild(opt3);
  });
}

function populateApparatusDropdown() {
  const select2 = document.getElementById('stepper-phase-2-apparatus');
  if (!select2) return;
  select2.innerHTML = '<option value="">Seleccione aparatología...</option>';
  Object.keys(APPARATUS_REGISTRY).forEach(key => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    select2.appendChild(opt);
  });
}

window.updateApparatusSettings = function() {
  const val = document.getElementById('stepper-phase-2-apparatus').value;
  const intensity = document.getElementById('stepper-phase-2-intensity');
  const time = document.getElementById('stepper-phase-2-time');
  if (val && APPARATUS_REGISTRY[val]) {
    intensity.value = APPARATUS_REGISTRY[val].intensityRange;
    time.value = APPARATUS_REGISTRY[val].defaultTime;
  } else {
    intensity.value = '';
    time.value = '';
  }
};

// Global redraw handler for canvas
window.resizeAndDrawFacial = function() {
  const canvas = document.getElementById('facial-diagnostic-canvas');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    drawFacialSilhouette(ctx, canvas.width, canvas.height, activeFacialZones);
  }
};

async function saveExpedienteClinico(p) {
  const folio = generateClinicalFolio(p.nombre);
  const phase1 = document.getElementById('stepper-phase-1-product').value;
  const phase2 = document.getElementById('stepper-phase-2-apparatus').value;
  const phase2Intensity = document.getElementById('stepper-phase-2-intensity').value;
  const phase2Time = document.getElementById('stepper-phase-2-time').value;
  const phase3 = document.getElementById('stepper-phase-3-product').value;

  const activeHotspots = { ...activeFacialZones };
  
  const prod = allProducts.find(pr => pr.id === p.prodId);
  const cost = prod ? cleanPrice(prod.price_aesthetic) : 0;
  const publicPrice = prod ? cleanPrice(prod.price_public) : 0;
  const profit = publicPrice - cost;
  const marginPct = publicPrice > 0 ? Math.round((profit / publicPrice) * 100) : 0;

  const sessionState = {
    folio,
    nombre: p.nombre,
    edad: p.edad,
    fecha: p.fecha,
    biotipo: p.biotipo,
    diagnostico: p.diagnostico,
    condicion: p.condicion,
    protocolo: p.protocolo,
    producto_vinculado: p.prodId,
    fases: {
      fase1: { producto: phase1 },
      fase2: { aparato: phase2, intensidad: phase2Intensity, tiempo: phase2Time },
      fase3: { producto: phase3 }
    },
    hotspots: activeHotspots,
    firmas: {
      especialista: p.firmaEsp,
      paciente: p.firmaPac
    },
    financiero: {
      costo: cost,
      publico: publicPrice,
      ganancia: profit,
      margen: marginPct
    }
  };

  const jsonStr = JSON.stringify(sessionState);

  const dbRecord = {
    folio,
    nombre: p.nombre,
    fecha: p.fecha,
    biotipo: p.biotipo,
    session_data: jsonStr,
    synced: 0
  };

  try {
    await db.expedientes_clinicos.put(dbRecord);

    if (navigator.onLine) {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS expedientes_clinicos (
          folio TEXT PRIMARY KEY,
          nombre TEXT,
          fecha TEXT,
          biotipo TEXT,
          session_data TEXT,
          synced INTEGER DEFAULT 0
        )
      `);

      await executeQuery(`
        INSERT INTO expedientes_clinicos (folio, nombre, fecha, biotipo, session_data) 
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(folio) DO UPDATE SET
          nombre=excluded.nombre,
          fecha=excluded.fecha,
          biotipo=excluded.biotipo,
          session_data=excluded.session_data
      `, [folio, p.nombre, p.fecha, p.biotipo, jsonStr]);

      await db.expedientes_clinicos.update(folio, { synced: 1 });
    }
    
    // Clear stepper inputs
    document.getElementById('stepper-phase-1-product').value = '';
    document.getElementById('stepper-phase-2-apparatus').value = '';
    document.getElementById('stepper-phase-2-intensity').value = '';
    document.getElementById('stepper-phase-2-time').value = '';
    document.getElementById('stepper-phase-3-product').value = '';
    document.getElementById('apparatus-recommendation-badge').classList.add('hidden');
    
    Object.keys(activeFacialZones).forEach(k => activeFacialZones[k] = false);
    if (window.resizeAndDrawFacial) window.resizeAndDrawFacial();
    updateSyncBadge();
    loadRecordsList();
  } catch (err) {
    console.error("Error in saveExpedienteClinico:", err);
  }
}

let allRecords = [];

async function loadRecordsList() {
  const tbody = document.getElementById('records-table-body');
  if (!tbody) return;

  try {
    if (navigator.onLine) {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS expedientes_clinicos (
          folio TEXT PRIMARY KEY,
          nombre TEXT,
          fecha TEXT,
          biotipo TEXT,
          session_data TEXT,
          synced INTEGER DEFAULT 0
        )
      `);
      const res = await executeQuery("SELECT * FROM expedientes_clinicos ORDER BY fecha DESC");
      allRecords = res.rows.map(r => ({
        folio: r.folio,
        nombre: r.nombre,
        fecha: r.fecha,
        biotipo: r.biotipo,
        session_data: r.session_data,
        synced: 1
      }));
      
      // Update IndexedDB
      await db.expedientes_clinicos.clear();
      for (const rec of allRecords) {
        await db.expedientes_clinicos.put({
          folio: rec.folio,
          nombre: rec.nombre,
          fecha: rec.fecha,
          biotipo: rec.biotipo,
          session_data: rec.session_data,
          synced: 1
        });
      }
    } else {
      allRecords = await db.expedientes_clinicos.toArray();
    }
  } catch (err) {
    console.error("Error loading records: ", err);
    try {
      allRecords = await db.expedientes_clinicos.toArray();
    } catch (e) {}
  }

  renderRecordsTable(allRecords);
}

function renderRecordsTable(records) {
  const tbody = document.getElementById('records-table-body');
  if (!tbody) return;

  if (!records || records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 px-4 text-center text-slate-400">No hay expedientes clínicos guardados.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  records.forEach(r => {
    let appUsed = '-';
    try {
      const data = JSON.parse(r.session_data);
      appUsed = data.fases?.fase2?.aparato || '-';
    } catch (e) {}

    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200/50 dark:border-white/5 hover:bg-slate-50/50 dark:hover:bg-white/[0.02] transition-colors';
    tr.innerHTML = `
      <td class="py-3.5 px-4 font-bold text-slate-900 dark:text-white">${r.folio}</td>
      <td class="py-3.5 px-4 font-semibold text-slate-800 dark:text-luxe-100">${r.nombre}</td>
      <td class="py-3.5 px-4 text-slate-600 dark:text-luxe-300">${r.fecha}</td>
      <td class="py-3.5 px-4 text-slate-600 dark:text-luxe-300">${r.biotipo}</td>
      <td class="py-3.5 px-4 text-slate-500 dark:text-luxe-400 font-medium">${appUsed}</td>
      <td class="py-3.5 px-4">
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold ${
          r.synced ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-yellow-500/10 text-yellow-600'
        }">
          ${r.synced ? 'Nube' : 'Local'}
        </span>
      </td>
      <td class="py-3.5 px-4 text-right flex justify-end gap-2.5">
        <button onclick="rehydrateRecord('${r.folio}')" class="text-medical-600 dark:text-bronze-500 hover:brightness-110 font-bold flex items-center gap-1" title="Visualizar y Rehidratar">
          👁️ Ver
        </button>
        <button onclick="exportRecordPDF('${r.folio}')" class="text-emerald-600 dark:text-emerald-400 hover:brightness-110 font-bold flex items-center gap-1" title="Exportar PDF">
          📥 PDF
        </button>
        <button onclick="archiveRecord('${r.folio}')" class="text-red-500 hover:brightness-110 font-bold flex items-center gap-1" title="Archivar">
          🗑️ Borrar
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

window.filterRecords = function() {
  const query = normalizeText(document.getElementById('records-search').value);
  if (!query) {
    renderRecordsTable(allRecords);
    return;
  }
  const filtered = allRecords.filter(r => 
    normalizeText(r.folio).includes(query) || 
    normalizeText(r.nombre).includes(query)
  );
  renderRecordsTable(filtered);
};

window.rehydrateRecord = async function(folio) {
  try {
    const rec = await db.expedientes_clinicos.get(folio);
    if (!rec) return;
    const data = JSON.parse(rec.session_data);

    // Rehydrate Patient Info
    document.getElementById('nombre').value = data.nombre || '';
    document.getElementById('fecha').value = data.fecha || '';
    document.getElementById('biotipo').value = data.biotipo || '';
    document.getElementById('diagnostico').value = data.diagnostico || '';
    document.getElementById('condicion').value = data.condicion || '';

    // Rehydrate Product
    if (data.producto_vinculado) {
      const prod = allProducts.find(pr => pr.id === data.producto_vinculado);
      if (prod) {
        document.getElementById('sel-marca').value = prod.brand;
        // Trigger cascading updates
        const selCat = document.getElementById('sel-categoria');
        const selProd = document.getElementById('sel-producto');
        
        selCat.innerHTML = `<option value="${prod.category}">${prod.category}</option>`;
        selCat.disabled = false;
        selProd.innerHTML = `<option value="${prod.id}">${prod.name}</option>`;
        selProd.disabled = false;
        
        selCat.value = prod.category;
        selProd.value = prod.id;
        
        renderResultsTable(prod);
      }
    }

    // Rehydrate Stepper Fases
    if (data.fases) {
      document.getElementById('stepper-phase-1-product').value = data.fases.fase1?.producto || '';
      document.getElementById('stepper-phase-2-apparatus').value = data.fases.fase2?.aparato || '';
      document.getElementById('stepper-phase-2-intensity').value = data.fases.fase2?.intensidad || '';
      document.getElementById('stepper-phase-2-time').value = data.fases.fase2?.tiempo || '';
      document.getElementById('stepper-phase-3-product').value = data.fases.fase3?.producto || '';
      updateApparatusSuggestions();
    }

    // Rehydrate canvas
    if (data.hotspots) {
      Object.assign(activeFacialZones, data.hotspots);
      if (window.resizeAndDrawFacial) window.resizeAndDrawFacial();
    }

    // Rehydrate signatures
    if (data.firmas) {
      if (signaturePadEspecialista && data.firmas.especialista) {
        signaturePadEspecialista.fromDataURL(data.firmas.especialista);
      }
      if (signaturePadPaciente && data.firmas.paciente) {
        signaturePadPaciente.fromDataURL(data.firmas.paciente);
      }
    }

    showToast(`Expediente ${folio} cargado y rehidratado en la Ficha.`, 'success');
    switchTab('generator');
  } catch (err) {
    console.error("Error rehydrating record: ", err);
    showToast("Error al rehidratar expediente clínico.", "error");
  }
};

window.exportRecordPDF = async function(folio) {
  try {
    const rec = await db.expedientes_clinicos.get(folio);
    if (!rec) return;
    const data = JSON.parse(rec.session_data);

    const name = data.nombre || '________________';
    const date = data.fecha || '________________';
    const biotipo = data.biotipo || '________________';
    const diag = data.diagnostico || 'No especificado.';
    const cond = data.condicion || 'Ninguna.';
    
    let appUsed = data.fases?.fase2?.aparato || 'Ninguno';
    let phaseDetailsHtml = `
      <div style="margin-top: 15px; padding: 12px; background: #fafaf9; border: 1px solid #e5e5e0; border-radius: 8px; font-size: 8px;">
        <span style="font-weight: bold; color: #121215; display: block; margin-bottom: 5px; text-transform: uppercase; tracking-wider">Protocolo de Fases Clínicas</span>
        <p style="margin: 2px 0;"><strong>Fase 1:</strong> Limpieza y Preparación: ${data.fases?.fase1?.producto || '-'}</p>
        <p style="margin: 2px 0;"><strong>Fase 2:</strong> Aparatología (${appUsed}) - Intensidad: ${data.fases?.fase2?.intensidad || '-'}, Tiempo: ${data.fases?.fase2?.tiempo || '-'} min</p>
        <p style="margin: 2px 0;"><strong>Fase 3:</strong> Sellado y Protección: ${data.fases?.fase3?.producto || '-'}</p>
      </div>
    `;

    // Re-create the isolated sandbox element for PDF compile
    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.width = '800px';
    container.style.height = '1000px';
    container.style.zIndex = '-99999';

    container.innerHTML = `
      <div style="
        width: 800px;
        height: 1000px !important;
        padding: 25px 40px;
        background: #ffffff;
        color: #121215;
        font-family: 'Urbanist', sans-serif;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        overflow: hidden !important;
      ">
        <style>
          @import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=Urbanist:wght@400;500;600;700&display=swap');
          .pdf-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid #D4AF37;
            padding-bottom: 8px;
            margin-bottom: 12px;
          }
          .pdf-logo-img {
            height: 38px;
            width: auto;
          }
          .pdf-demo-grid {
            display: grid;
            grid-template-columns: repeat(5, 1fr);
            gap: 15px;
            background: #fafaf9;
            border: 1px solid #e5e5e0;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 15px;
          }
          .pdf-demo-col {
            font-size: 8px;
          }
          .pdf-demo-label {
            color: #666;
            font-weight: bold;
            text-transform: uppercase;
            font-size: 7px;
            display: block;
          }
          .pdf-demo-val {
            color: #121215;
            font-weight: 600;
          }
        </style>

        <div>
          <div class="pdf-header">
            <div>
              <img src="https://raw.githubusercontent.com/carlosgbd94-design/Logos/refs/heads/main/logo_xarixuri_cosmetolog_a-removebg-preview.png" class="pdf-logo-img">
            </div>
            <div style="text-align: right;">
              <span style="font-weight: bold; font-size: 10px; color: #D4AF37;">EXPEDIENTE DE TRATAMIENTO</span>
              <p style="font-size: 7px; color: #666; margin: 2px 0;">Folio: ${data.folio}</p>
            </div>
          </div>

          <div class="pdf-demo-grid">
            <div class="pdf-demo-col" style="grid-column: span 2">
              <span class="pdf-demo-label">Paciente</span>
              <span class="pdf-demo-val">${name}</span>
            </div>
            <div class="pdf-demo-col">
              <span class="pdf-demo-label">Edad</span>
              <span class="pdf-demo-val">${data.edad || '___'} años</span>
            </div>
            <div class="pdf-demo-col">
              <span class="pdf-demo-label">Fecha</span>
              <span class="pdf-demo-val">${date}</span>
            </div>
            <div class="pdf-demo-col">
              <span class="pdf-demo-label">Biotipo Cutáneo</span>
              <span class="pdf-demo-val">${biotipo}</span>
            </div>
          </div>

          <div style="margin-bottom: 12px; padding: 10px; background: #fafaf9; border: 1px solid #e5e5e0; border-radius: 8px; font-size: 8px;">
            <span class="pdf-demo-label" style="display:block; margin-bottom: 2px;">Protocolo / Objetivo Recomendado</span>
            <span class="pdf-demo-val" style="font-size: 10px;">${data.protocolo || 'No especificado.'}</span>
          </div>

          <div style="font-size: 8px; line-height: 1.3;">
            <p><strong>Diagnóstico Clínico:</strong> ${diag}</p>
            <p><strong>Condiciones / Contraindicaciones:</strong> ${cond}</p>
          </div>

          ${phaseDetailsHtml}

          <div style="margin-top: 15px; text-align: center;">
            <p style="font-size: 7.5px; color: #666; font-style: italic;">*Nota de Consentimiento Clínico: Valoración cutánea autorizada y aceptada por el paciente.</p>
          </div>

          <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 40px; margin-top: 30px; text-align: center;">
            <div>
              <div style="border-b: 1px solid #ccc; height: 35px;">
                ${data.firmas?.especialista ? `<img src="${data.firmas.especialista}" style="height: 35px; max-width: 100%;">` : ''}
              </div>
              <span style="font-size: 8px; font-weight: bold; display: block; margin-top: 5px;">Firma del Especialista</span>
            </div>
            <div>
              <div style="border-b: 1px solid #ccc; height: 35px;">
                ${data.firmas?.paciente ? `<img src="${data.firmas.paciente}" style="height: 35px; max-width: 100%;">` : ''}
              </div>
              <span style="font-size: 8px; font-weight: bold; display: block; margin-top: 5px;">Firma del Paciente</span>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(container);
    
    const opt = {
      margin:       0,
      filename:     `Expediente_${folio}.pdf`,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true },
      jsPDF:        { unit: 'mm', format: 'letter', orientation: 'portrait' }
    };

    await html2pdf().from(container).set(opt).save();
    container.remove();
    showToast(`PDF del expediente ${folio} exportado.`, 'success');
  } catch (err) {
    console.error("Error exporting PDF: ", err);
    showToast("Error al exportar PDF.", "error");
  }
};

window.archiveRecord = async function(folio) {
  if (!confirm(`¿Está seguro de archivar/eliminar permanentemente el expediente ${folio}?`)) {
    return;
  }
  try {
    await db.expedientes_clinicos.delete(folio);
    if (navigator.onLine) {
      await executeQuery("DELETE FROM expedientes_clinicos WHERE folio = ?", [folio]);
    }
    showToast(`Expediente ${folio} eliminado con éxito.`, 'success');
    loadRecordsList();
  } catch (err) {
    console.error("Error deleting record:", err);
    showToast("Error al eliminar expediente.", "error");
  }
};

// Sync background transactions for expedientes_clinicos
async function syncExpedientesOffline() {
  if (!navigator.onLine) return;
  try {
    const unsynced = await db.expedientes_clinicos.where('synced').equals(0).toArray();
    if (unsynced.length === 0) return;

    for (const record of unsynced) {
      await executeQuery(`
        CREATE TABLE IF NOT EXISTS expedientes_clinicos (
          folio TEXT PRIMARY KEY,
          nombre TEXT,
          fecha TEXT,
          biotipo TEXT,
          session_data TEXT,
          synced INTEGER DEFAULT 0
        )
      `);

      await executeQuery(`
        INSERT INTO expedientes_clinicos (folio, nombre, fecha, biotipo, session_data) 
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(folio) DO UPDATE SET
          nombre=excluded.nombre,
          fecha=excluded.fecha,
          biotipo=excluded.biotipo,
          session_data=excluded.session_data
      `, [record.folio, record.nombre, record.fecha, record.biotipo, record.session_data]);

      await db.expedientes_clinicos.update(record.folio, { synced: 1 });
    }
    showToast(`${unsynced.length} expedientes clínicos offline sincronizados con éxito.`, 'success');
    loadRecordsList();
  } catch (err) {
    console.error("Error syncing expedientes:", err);
  }
}

// Hook offline synchronization
window.addEventListener('online', async () => {
  await syncExpedientesOffline();
});

