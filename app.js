// Turso Database Credentials (Direct Client-Side Connection)
const TURSO_URL = 'https://cosmetics-prodcts-carlos-becerra.aws-us-west-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODAyNTc5MzEsImlkIjoiMDE5ZTdmOWUtMmEwMS03OWMxLTg3N2YtN2RkY2FkZjg1ZDk5IiwicmlkIjoiM2VhNTAwMzUtMjIwZS00MWM2LWI3NjItNTM2NjQ1NzJhM2EzIn0.7-B8dPeRempyRbJBif_dZYDmoKizAwHz9F9RTv-WGNmpniIRicU3GkcENXOi2k0n1_rKfDuL69f1cLAOyeFnBg';

// Mappings and State
let signaturePadEspecialista = null;
let signaturePadPaciente = null;
let savedSignatureEsp = null;
let savedSignaturePac = null;
let allProducts = [];
let allIngredientsList = [];
let uploadDataPreview = [];

// Dexie Local Database setup
const db = new Dexie('DermatiqueLocalDB');
db.version(1).stores({
  products: 'id, brand, category, name, active_ingredients, skin_indication',
  fichas_pacientes: '++id, nombre, fecha, biotipo, diagnostico, condicion, protocolo_id, firma_especialista, firma_paciente, synced'
});

// Fuse.js Fuzzy Search state
let fuseInstance = null;

const productMapping = {
  "ID / Clave": "id",
  "Marca": "brand",
  "Nombre del Producto": "name",
  "Categoría": "category",
  "Capacidad": "capacity",
  "Precio Esteticista (MXN)": "price_aesthetic",
  "Precio Público (MXN)": "price_public",
  "Activos Clave": "active_ingredients",
  "Biotipo / Indicación": "skin_indication"
};

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

function formatCurrency(val) {
  if (val === null || val === undefined || val === '') return '-';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(val);
}

// Bootstrapper
document.addEventListener('DOMContentLoaded', () => {
  // Sync theme icon state with current document class
  const isDark = document.documentElement.classList.contains('dark');
  const themeIcon = document.getElementById('theme-icon');
  const themeIconMobile = document.getElementById('theme-icon-mobile');
  if (themeIcon) themeIcon.setAttribute('data-lucide', isDark ? 'sun' : 'moon');
  if (themeIconMobile) themeIconMobile.setAttribute('data-lucide', isDark ? 'sun' : 'moon');

  lucide.createIcons();
  document.getElementById('fecha').value = new Date().toISOString().substring(0, 10);

  // Initialize features
  initCascadingDropdowns();
  initCheckerTool();
  initDragAndDrop();
  initPatientForm();
  initProductForm();
  initSignatures();
  initFacialCanvas();

  // Load database entities
  loadCatalogList();
  loadIngredientsList();
  loadHistory();
});

// View Tabs Selector
window.switchTab = function(tabName) {
  const tabGen = document.getElementById('tab-generator');
  const tabInv = document.getElementById('tab-inventory');
  const btnGen = document.getElementById('tab-btn-generator');
  const btnInv = document.getElementById('tab-btn-inventory');

  if (tabName === 'generator') {
    tabGen.classList.remove('hidden');
    tabInv.classList.add('hidden');
    btnGen.className = "px-4 py-2 rounded-lg text-sm font-semibold transition-all bg-white text-slate-900 shadow-sm";
    btnInv.className = "px-4 py-2 rounded-lg text-sm font-semibold transition-all text-slate-600 hover:text-slate-900";
  } else {
    tabGen.classList.add('hidden');
    tabInv.classList.remove('hidden');
    btnInv.className = "px-4 py-2 rounded-lg text-sm font-semibold transition-all bg-white text-slate-900 shadow-sm";
    btnGen.className = "px-4 py-2 rounded-lg text-sm font-semibold transition-all text-slate-600 hover:text-slate-900";
    loadCatalogList();
  }
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
    renderResultsTable(product);
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

function clearResultsTable() {
  const tbody = document.getElementById('results-table-body');
  tbody.innerHTML = `
    <tr>
      <td colspan="2" class="py-8 px-5 text-center text-slate-400 dark:text-luxe-400 text-sm">
        Seleccione una marca, categoría y producto para poblar la ficha técnica.
      </td>
    </tr>
  `;
  const badge = document.getElementById('product-info-badge');
  if (badge) badge.classList.add('hidden');
  const finCard = document.getElementById('financial-summary-card');
  if (finCard) finCard.classList.add('hidden');
}

function renderResultsTable(p) {
  const tbody = document.getElementById('results-table-body');
  const badge = document.getElementById('product-info-badge');
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
    
    const cost = p.price_aesthetic || 0;
    const publicPrice = p.price_public || 0;
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
    showToast('Ficha limpia.', 'success');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const nombre = document.getElementById('nombre').value;
    const fecha = document.getElementById('fecha').value;
    const biotipo = document.getElementById('biotipo').value;
    const diagnostico = document.getElementById('diagnostico').value;
    const condicion = document.getElementById('condicion').value;
    const prodId = document.getElementById('sel-producto').value;

    if (!prodId) {
      showToast('Debe asignar un producto para guardar la ficha.', 'error');
      return;
    }

    const firmaEsp = signaturePadEspecialista && !signaturePadEspecialista.isEmpty() ? signaturePadEspecialista.toDataURL() : null;
    const firmaPac = signaturePadPaciente && !signaturePadPaciente.isEmpty() ? signaturePadPaciente.toDataURL() : null;

    const newRecord = {
      nombre,
      fecha,
      biotipo,
      diagnostico,
      condicion,
      protocolo_id: prodId,
      firma_especialista: firmaEsp,
      firma_paciente: firmaPac,
      synced: 0
    };

    try {
      // Save locally to Dexie LocalDB first
      const localId = await db.fichas_pacientes.add(newRecord);

      if (navigator.onLine) {
        // Direct cloud write if online
        await executeQuery(
          'INSERT INTO fichas_pacientes (nombre, fecha, biotipo, diagnostico, condicion, protocolo_id, firma_especialista, firma_paciente) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [nombre, fecha, biotipo, diagnostico, condicion, prodId, firmaEsp, firmaPac]
        );
        // Mark as synced
        await db.fichas_pacientes.update(localId, { synced: 1 });
        showToast('Ficha guardada y sincronizada con la nube.', 'success');
      } else {
        showToast('Ficha guardada localmente (pendiente de conexión).', 'warning');
      }

      if (signaturePadEspecialista) {
        signaturePadEspecialista.clear();
        savedSignatureEsp = null;
      }
      if (signaturePadPaciente) {
        signaturePadPaciente.clear();
        savedSignaturePac = null;
      }

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
  document.getElementById('fecha').value = f.fecha;
  document.getElementById('biotipo').value = f.biotipo || '';
  document.getElementById('diagnostico').value = f.diagnostico || '';
  document.getElementById('condicion').value = f.condicion || '';
  document.getElementById('current-doc-id').textContent = `Ficha Nº ${f.id} (Historial)`;

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
  } catch (err) {
    console.error(err);
    try {
      allProducts = await db.products.toArray();
      updateFuseIndex();
      renderCatalogTable(allProducts);
      populateFilterSelects(allProducts);
      loadBrandsLocal();
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

function renderCatalogTable(products) {
  const tbody = document.getElementById('catalog-table-body');
  if (!products || products.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="py-8 px-4 text-center text-slate-400">No se encontraron productos.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  products.forEach(p => {
    const tr = document.createElement('tr');
    tr.className = 'border-b border-slate-200/60 hover:bg-slate-50/50 transition-colors';
    tr.innerHTML = `
      <td class="py-3 px-4 font-bold text-slate-900">${p.id}</td>
      <td class="py-3 px-4 font-semibold text-slate-800">${p.name}</td>
      <td class="py-3 px-4 text-slate-600">${p.brand}</td>
      <td class="py-3 px-4 text-slate-600">${p.category}</td>
      <td class="py-3 px-4 text-slate-500">${p.capacity || '-'}</td>
      <td class="py-3 px-4 text-slate-700 font-medium">${formatCurrency(p.price_aesthetic)}</td>
      <td class="py-3 px-4 text-emerald-700 font-bold">${formatCurrency(p.price_public)}</td>
      <td class="py-3 px-4 text-slate-500 truncate max-w-xs" title="${p.active_ingredients || ''}">${p.active_ingredients || '-'}</td>
      <td class="py-3 px-4 text-right flex justify-end gap-2">
        <button onclick="editProduct(${JSON.stringify(p).replace(/"/g, '&quot;')})" 
          class="text-medical-600 hover:text-medical-700 font-semibold text-xs flex items-center gap-1">
          <i data-lucide="edit-2" class="w-3.5 h-3.5"></i> Editar
        </button>
        <button onclick="deleteProduct('${p.id}')" 
          class="text-red-600 hover:text-red-700 font-semibold text-xs flex items-center gap-1 ml-2">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  lucide.createIcons();
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
  document.getElementById('print-val-nombre').textContent = document.getElementById('nombre').value || '__________________________________';
  document.getElementById('print-val-fecha').textContent = document.getElementById('fecha').value || '__________________';
  document.getElementById('print-val-biotipo').textContent = document.getElementById('biotipo').value || '__________________';
  
  document.getElementById('print-val-diagnostico').textContent = document.getElementById('diagnostico').value || 'No especificado.';
  document.getElementById('print-val-condicion').textContent = document.getElementById('condicion').value || 'Ninguna.';
  
  const currentDocText = document.getElementById('current-doc-id').textContent;
  document.getElementById('print-doc-id').textContent = currentDocText || 'Prescripción de Activos';

  const mainTableBody = document.getElementById('results-table-body');
  const printTableBody = document.getElementById('print-results-body');
  
  if (mainTableBody && printTableBody) {
    printTableBody.innerHTML = mainTableBody.innerHTML;
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
  leftCheek: false,
  rightCheek: false,
  chin: false
};

function drawFacialSilhouette(ctx, width, height, activeZones) {
  ctx.clearRect(0, 0, width, height);

  const isDark = document.documentElement.classList.contains('dark');
  const strokeColor = isDark ? 'rgba(212, 175, 55, 0.75)' : 'rgba(15, 23, 42, 0.55)';
  const gridColor = isDark ? 'rgba(212, 175, 55, 0.15)' : 'rgba(15, 23, 42, 0.1)';
  const accentColor = '#D4AF37';

  ctx.lineCap = 'round';

  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.31;
  const ry = height * 0.40;

  // Draw medical grid / clinical alignment guides (dashed lines)
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  
  // Vertical axis
  ctx.beginPath();
  ctx.moveTo(cx, cy - ry * 1.1);
  ctx.lineTo(cx, cy + ry * 1.1);
  ctx.stroke();

  // Horizontal guides
  const browY = cy - ry * 0.35;
  const eyesY = cy - ry * 0.15;
  const noseY = cy + ry * 0.15;
  const mouthY = cy + ry * 0.42;

  // Brow line
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.9, browY);
  ctx.lineTo(cx + rx * 0.9, browY);
  ctx.stroke();

  // Nose base line
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.8, noseY);
  ctx.lineTo(cx + rx * 0.8, noseY);
  ctx.stroke();

  // Reset line dash for face details
  ctx.setLineDash([]);
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;

  // 1. Draw head outline
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  ctx.stroke();

  // 2. Ears (minimalist curves)
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Left ear
  ctx.arc(cx - rx - 2, cy - ry * 0.05, rx * 0.18, -Math.PI * 0.6, Math.PI * 0.6);
  ctx.stroke();
  // Right ear
  ctx.beginPath();
  ctx.arc(cx + rx + 2, cy - ry * 0.05, rx * 0.18, -Math.PI * 0.4, Math.PI * 0.4, true);
  ctx.stroke();

  // 3. Eyebrows (elegant clinical arches)
  ctx.lineWidth = 2;
  const browWidth = rx * 0.32;
  const browOffset = rx * 0.48;
  // Left brow
  ctx.beginPath();
  ctx.moveTo(cx - browOffset, browY);
  ctx.quadraticCurveTo(cx - browOffset + browWidth/2, browY - 6, cx - browOffset + browWidth, browY);
  ctx.stroke();
  // Right brow
  ctx.beginPath();
  ctx.moveTo(cx + browOffset, browY);
  ctx.quadraticCurveTo(cx + browOffset - browWidth/2, browY - 6, cx + browOffset - browWidth, browY);
  ctx.stroke();

  // 4. Eyes (elegant minimalist almonds, closed/resting)
  ctx.lineWidth = 1.5;
  const eyeOffset = rx * 0.44;
  const eyeWidth = rx * 0.28;
  // Left eye
  ctx.beginPath();
  ctx.arc(cx - eyeOffset, eyesY, eyeWidth/2, 0, Math.PI, true);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - eyeOffset, eyesY, eyeWidth/2, 0.1, Math.PI - 0.1, false);
  ctx.stroke();

  // Right eye
  ctx.beginPath();
  ctx.arc(cx + eyeOffset, eyesY, eyeWidth/2, 0, Math.PI, true);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + eyeOffset, eyesY, eyeWidth/2, 0.1, Math.PI - 0.1, false);
  ctx.stroke();

  // 5. Nose (refined bridge and nostrils)
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  // Bridge
  ctx.moveTo(cx, browY + 2);
  ctx.lineTo(cx, noseY - 4);
  // Tip and nostrils
  ctx.quadraticCurveTo(cx, noseY, cx - rx * 0.08, noseY);
  ctx.moveTo(cx, noseY - 4);
  ctx.quadraticCurveTo(cx, noseY, cx + rx * 0.08, noseY);
  ctx.stroke();

  // 6. Lips (structured lips outline)
  ctx.lineWidth = 1.5;
  const mouthWidth = rx * 0.35;
  ctx.beginPath();
  // Center line of mouth (cupid's bow detail)
  ctx.moveTo(cx - mouthWidth/2, mouthY);
  ctx.quadraticCurveTo(cx - mouthWidth/4, mouthY - 2, cx, mouthY + 1);
  ctx.quadraticCurveTo(cx + mouthWidth/4, mouthY - 2, cx + mouthWidth/2, mouthY);
  // Bottom lip curve
  ctx.quadraticCurveTo(cx, mouthY + 8, cx - mouthWidth/2, mouthY);
  ctx.stroke();

  // Neck and collar lines
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.45, cy + ry * 0.88);
  ctx.quadraticCurveTo(cx - rx * 0.45, cy + ry, cx - rx * 0.6, height);
  ctx.moveTo(cx + rx * 0.45, cy + ry * 0.88);
  ctx.quadraticCurveTo(cx + rx * 0.45, cy + ry, cx + rx * 0.6, height);
  ctx.stroke();

  // Hotspots definitions
  const zones = {
    forehead: { x: cx, y: cy - ry * 0.64 },
    nose: { x: cx, y: cy + ry * 0.05 },
    leftCheek: { x: cx - rx * 0.46, y: cy + ry * 0.10 },
    rightCheek: { x: cx + rx * 0.46, y: cy + ry * 0.10 },
    chin: { x: cx, y: cy + ry * 0.70 }
  };

  // Draw active indicators
  for (const [key, val] of Object.entries(zones)) {
    const active = activeZones[key];
    ctx.beginPath();
    ctx.arc(val.x, val.y, 8, 0, 2 * Math.PI);
    if (active) {
      ctx.shadowBlur = 18;
      ctx.shadowColor = accentColor;
      ctx.fillStyle = accentColor;
      ctx.fill();
      
      ctx.shadowBlur = 0;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(val.x, val.y, 15, 0, 2 * Math.PI);
      ctx.stroke();
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(15, 23, 42, 0.08)';
      ctx.fill();
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.35)' : 'rgba(15, 23, 42, 0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
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
    forehead: '[Zona T: Grasa]',
    nose: '[Zona T: Grasa]',
    leftCheek: '[Mejilla Izq: Deshidratada]',
    rightCheek: '[Mejilla Der: Deshidratada]',
    chin: '[Mentón: Seca]'
  };

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const rx = canvas.width * 0.33;
    const ry = canvas.height * 0.41;

    const zones = {
      forehead: { x: cx, y: cy - ry * 0.62 },
      nose: { x: cx, y: cy + ry * 0.02 },
      leftCheek: { x: cx - rx * 0.48, y: cy + ry * 0.08 },
      rightCheek: { x: cx + rx * 0.48, y: cy + ry * 0.08 },
      chin: { x: cx, y: cy + ry * 0.68 }
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

    if (closestZone && minDist < 45) {
      activeFacialZones[closestZone] = !activeFacialZones[closestZone];
      drawFacialSilhouette(ctx, canvas.width, canvas.height, activeFacialZones);

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
          grid-template-columns: repeat(3, 1fr);
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
            <div class="pdf-logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C12 2 6 8.5 6 13C6 16.3137 8.68629 19 12 19C15.3137 19 18 16.3137 18 13C18 8.5 12 2 12 2Z" />
                <path d="M12 8V15" stroke-linecap="round" />
                <path d="M8.5 11.5H15.5" stroke-linecap="round" />
              </svg>
            </div>
            <div>
              <h1 class="pdf-brand-name">Dermatique Pro</h1>
              <p class="pdf-brand-sub">Clinical Diagnostics & Prescriptions</p>
            </div>
          </div>
          <div class="pdf-header-right">
            <h2 class="pdf-doc-title">${docTitle}</h2>
            <p class="pdf-doc-sub">Clínica de Estética Especializada</p>
          </div>
        </div>

        <!-- Demographics -->
        <div class="pdf-demo-grid">
          <div class="pdf-demo-item">
            <span class="pdf-demo-label">Paciente</span>
            <span class="pdf-demo-value">${nombre}</span>
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
      const zNames = { forehead: 'Frente', nose: 'Nariz', leftCheek: 'Mejilla Izq', rightCheek: 'Mejilla Der', chin: 'Mentón' };
      return zNames[k] || k;
    }).join(', ');

  // Format products context
  const productsCtx = allProducts.map(p => `- ID: ${p.id} | Marca: ${p.brand} | Nombre: ${p.name} | Activos: ${p.active_ingredients} | Indicación: ${p.skin_indication}`).join('\n');

  const prompt = `Eres un experto Cosmiatra y Cosmetólogo Médico.
Analiza la siguiente información del paciente:
- Biotipo Cutáneo: ${biotipo}
- Diagnóstico Clínico: ${diagnostico}
- Condición / Contraindicaciones: ${condicion}
- Zonas faciales con afecciones activas: ${activeZonesList || 'Ninguna específica'}

El catálogo de productos disponibles en inventario es el siguiente:
${productsCtx}

Tu tarea:
1. Diseña una rutina de Skincare de Mañana (Morning) y Noche (Night) estructurada.
2. Utiliza ÚNICAMENTE los productos que existen en el catálogo de productos anterior. No inventes productos.
3. Para cada producto prescrito, justifica su uso mencionando sus ingredientes activos clave en relación con la zona facial afectada o el diagnóstico.
4. Mantén la respuesta con formato limpio, claro, y profesional en español. No uses negritas Markdown (asteriscos).

Escribe la respuesta directamente.`;

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

    // Show AI recommendation container
    const container = document.getElementById('ai-recommendation-container');
    const content = document.getElementById('ai-recommendation-content');
    const printContent = document.getElementById('ai-recommendation-print-content');
    const printContainer = document.getElementById('ai-recommendation-print');

    if (content) content.innerText = resultText;
    if (container) container.classList.remove('hidden');

    if (printContent && printContainer) {
      printContent.innerText = resultText;
      printContainer.classList.remove('hidden');
    }

    showToast('Prescripción con IA generada con éxito.', 'success');
  } catch (error) {
    console.error(error);
    showToast('Error al conectar con la IA de Gemini.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
};

window.addEventListener('online', async () => {
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
        'INSERT INTO fichas_pacientes (nombre, fecha, biotipo, diagnostico, condicion, protocolo_id, firma_especialista, firma_paciente) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [record.nombre, record.fecha, record.biotipo, record.diagnostico, record.condicion, record.protocolo_id, record.firma_especialista, record.firma_paciente]
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
  }
});
