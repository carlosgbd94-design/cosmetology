// Turso Database Credentials (Direct Client-Side Connection)
const TURSO_URL = 'https://cosmetics-prodcts-carlos-becerra.aws-us-west-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODAyNTc5MzEsImlkIjoiMDE5ZTdmOWUtMmEwMS03OWMxLTg3N2YtN2RkY2FkZjg1ZDk5IiwicmlkIjoiM2VhNTAwMzUtMjIwZS00MWM2LWI3NjItNTM2NjQ1NzJhM2EzIn0.7-B8dPeRempyRbJBif_dZYDmoKizAwHz9F9RTv-WGNmpniIRicU3GkcENXOi2k0n1_rKfDuL69f1cLAOyeFnBg';

// Mappings and State
let allProducts = [];
let allIngredientsList = [];
let uploadDataPreview = [];

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

  // Load database entities
  loadBrands();
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

  selMarca.addEventListener('change', async (e) => {
    const brandVal = e.target.value;

    selCategoria.innerHTML = '<option value="">Cargando categorías...</option>';
    selCategoria.disabled = true;
    selProducto.innerHTML = '<option value="">Seleccione categoría primero...</option>';
    selProducto.disabled = true;
    clearResultsTable();

    if (!brandVal) {
      selCategoria.innerHTML = '<option value="">Seleccione marca primero...</option>';
      return;
    }

    try {
      const res = await executeQuery(
        "SELECT DISTINCT category FROM products WHERE brand = ? AND category IS NOT NULL AND category != '' ORDER BY category ASC",
        [brandVal]
      );
      
      selCategoria.innerHTML = '<option value="">Seleccionar categoría...</option>';
      res.rows.forEach(row => {
        const opt = document.createElement('option');
        opt.value = row.category;
        opt.textContent = row.category;
        selCategoria.appendChild(opt);
      });
      selCategoria.disabled = false;
    } catch (err) {
      console.error(err);
      showToast('Error al cargar categorías de la base de datos.', 'error');
    }
  });

  selCategoria.addEventListener('change', async (e) => {
    const brandVal = selMarca.value;
    const catVal = e.target.value;

    selProducto.innerHTML = '<option value="">Cargando productos...</option>';
    selProducto.disabled = true;
    clearResultsTable();

    if (!catVal) {
      selProducto.innerHTML = '<option value="">Seleccione categoría primero...</option>';
      return;
    }

    try {
      const res = await executeQuery(
        "SELECT id, name FROM products WHERE brand = ? AND category = ? ORDER BY name ASC",
        [brandVal, catVal]
      );

      selProducto.innerHTML = '<option value="">Seleccionar producto...</option>';
      res.rows.forEach(row => {
        const opt = document.createElement('option');
        opt.value = row.id;
        opt.textContent = row.name;
        selProducto.appendChild(opt);
      });
      selProducto.disabled = false;
    } catch (err) {
      console.error(err);
      showToast('Error al cargar productos.', 'error');
    }
  });

  selProducto.addEventListener('change', async (e) => {
    const prodId = e.target.value;

    if (!prodId) {
      clearResultsTable();
      return;
    }

    try {
      const res = await executeQuery("SELECT * FROM products WHERE id = ?", [prodId]);
      renderResultsTable(res.rows[0]);
    } catch (err) {
      console.error(err);
      showToast('Error al cargar detalles del producto.', 'error');
    }
  });
}

async function loadBrands() {
  const selMarca = document.getElementById('sel-marca');
  try {
    const res = await executeQuery("SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != '' ORDER BY brand ASC");
    selMarca.innerHTML = '<option value="">Seleccionar marca...</option>';
    res.rows.forEach(row => {
      const opt = document.createElement('option');
      opt.value = row.brand;
      opt.textContent = row.brand;
      selMarca.appendChild(opt);
    });
  } catch (err) {
    console.error(err);
    showToast('Error al conectar a Turso desde el navegador.', 'error');
  }
}

function clearResultsTable() {
  const tbody = document.getElementById('results-table-body');
  tbody.innerHTML = `
    <tr>
      <td colspan="2" class="py-8 px-5 text-center text-slate-400 text-sm">
        Seleccione una marca, categoría y producto para poblar la ficha técnica.
      </td>
    </tr>
  `;
  const badge = document.getElementById('product-info-badge');
  badge.classList.add('hidden');
}

function renderResultsTable(p) {
  const tbody = document.getElementById('results-table-body');
  const badge = document.getElementById('product-info-badge');

  if (!p) {
    clearResultsTable();
    return;
  }

  badge.textContent = `${p.brand} - ${p.name}`;
  badge.classList.remove('hidden');

  tbody.innerHTML = `
    <tr class="border-b border-slate-100">
      <td class="py-3.5 px-5 font-semibold text-slate-500 w-1/3">ID / Clave</td>
      <td class="py-3.5 px-5 font-bold text-slate-800">${p.id}</td>
    </tr>
    <tr class="border-b border-slate-100">
      <td class="py-3.5 px-5 font-semibold text-slate-500">Capacidad</td>
      <td class="py-3.5 px-5 text-slate-700">${p.capacity || '-'}</td>
    </tr>
    <tr class="border-b border-slate-100">
      <td class="py-3.5 px-5 font-semibold text-slate-500">Precio Público (MXN)</td>
      <td class="py-3.5 px-5 text-emerald-700 font-bold">${formatCurrency(p.price_public)}</td>
    </tr>
    <tr class="border-b border-slate-100">
      <td class="py-3.5 px-5 font-semibold text-slate-500">Biotipo / Indicación</td>
      <td class="py-3.5 px-5 text-slate-700 font-medium">${p.skin_indication || '-'}</td>
    </tr>
    <tr class="border-b border-slate-100">
      <td class="py-3.5 px-5 font-semibold text-slate-500">Activos Clave</td>
      <td class="py-3.5 px-5 text-slate-800 font-semibold">${p.active_ingredients || '-'}</td>
    </tr>
  `;
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
    const normInput = normalizeText(val);

    if (!normInput) {
      resultsDiv.innerHTML = '<p class="text-slate-400 italic">Por favor, escriba un ingrediente activo para comenzar.</p>';
      return;
    }

    let exactMatch = null;
    let matches = [];

    allIngredientsList.forEach(item => {
      const normDb = normalizeText(item.activo);
      
      if (normDb === normInput) {
        exactMatch = item;
      }

      const dist = getLevenshteinDistance(normInput, normDb);
      const maxLen = Math.max(normInput.length, normDb.length);
      const similarity = maxLen === 0 ? 1 : 1 - dist / maxLen;

      if (similarity > 0.8) {
        matches.push({
          activo: item.activo,
          similarity: similarity
        });
      }
    });

    matches.sort((a, b) => b.similarity - a.similarity);

    if (exactMatch) {
      resultsDiv.innerHTML = `
        <div class="p-3 bg-emerald-50 border border-emerald-200 rounded-xl">
          <div class="flex items-center gap-1.5 text-emerald-800 font-bold text-sm">
            <i data-lucide="check-circle" class="w-4.5 h-4.5 text-emerald-600"></i>
            <span>Coincidencia Exacta Encontrada:</span>
          </div>
          <p class="text-slate-800 font-semibold mt-1">${exactMatch.activo}</p>
        </div>
      `;
    } else if (matches.length > 0) {
      let listHtml = matches.map(m => `
        <div class="py-1.5 border-b border-slate-100 last:border-0 text-xs">
          <p class="text-slate-800 font-semibold">${m.activo} <span class="text-xs bg-slate-100 text-slate-500 font-medium px-2 py-0.5 rounded-full ml-1">${Math.round(m.similarity * 100)}% similitud</span></p>
        </div>
      `).join('');

      resultsDiv.innerHTML = `
        <div class="space-y-3">
          <div class="flex items-center gap-1.5 text-blue-800 font-bold text-sm bg-blue-50 border border-blue-200 p-2.5 rounded-xl">
            <i data-lucide="info" class="w-4.5 h-4.5 text-blue-600"></i>
            <span>Sugerencias (>80% Similitud):</span>
          </div>
          <div class="max-h-40 overflow-y-auto pr-1">${listHtml}</div>
        </div>
      `;
    } else {
      resultsDiv.innerHTML = `
        <div class="p-3 bg-slate-100 border border-slate-200 rounded-xl">
          <div class="flex items-center gap-1.5 text-slate-700 font-semibold text-sm">
            <i data-lucide="x-circle" class="w-4.5 h-4.5 text-slate-500"></i>
            <span>Sin coincidencias</span>
          </div>
          <p class="text-slate-500 text-xs mt-1">No se encontraron activos similares en el catálogo actual.</p>
        </div>
      `;
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

    try {
      await executeQuery(
        'INSERT INTO fichas_pacientes (nombre, fecha, biotipo, diagnostico, condicion, protocolo_id) VALUES (?, ?, ?, ?, ?, ?)',
        [nombre, fecha, biotipo, diagnostico, condicion, prodId]
      );

      showToast('Ficha guardada con éxito.', 'success');
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

async function loadCatalogList() {
  const tbody = document.getElementById('catalog-table-body');
  try {
    const res = await executeQuery("SELECT * FROM products ORDER BY name ASC");
    allProducts = res.rows;
    renderCatalogTable(allProducts);
    populateFilterSelects(allProducts);
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="9" class="py-8 px-4 text-center text-red-500">Error al consultar catálogo.</td></tr>';
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
  const queryText = normalizeText(document.getElementById('catalog-search').value);
  const brandVal = document.getElementById('filter-brand').value;
  const catVal = document.getElementById('filter-category').value;

  const filtered = allProducts.filter(p => {
    const matchQuery = !queryText || 
      normalizeText(p.name).includes(queryText) ||
      normalizeText(p.id).includes(queryText) ||
      normalizeText(p.active_ingredients).includes(queryText) ||
      normalizeText(p.skin_indication).includes(queryText);

    const matchBrand = !brandVal || p.brand === brandVal;
    const matchCat = !catVal || p.category === catVal;

    return matchQuery && matchBrand && matchCat;
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
