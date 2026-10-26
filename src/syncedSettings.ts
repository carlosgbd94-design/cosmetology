import { executeQuery, getTableName } from './db';

// Sincronización con Turso de las ediciones de rutinas/protocolos (rutinas del catálogo editadas,
// rutinas personalizadas guardadas y productos elegidos por fase). Antes vivían solo en localStorage,
// así que no llegaban a otro dispositivo/navegador ni sobrevivían a limpiar la caché.
//
// Modelo: tabla clave-valor remota; cada clave lleva su fecha de última edición y gana la más
// reciente en ambos sentidos (misma regla que el catálogo de productos). Un valor NULL remoto es una
// eliminación (p. ej. "Restablecer original"), también sincronizada.

const META_KEY = 'dermatique_settings_meta';

const OVERRIDES_LS = 'dermatique_routine_overrides';
const OVERRIDE_PREFIX = 'routine_override:';

// Claves "planas": clave sincronizada -> clave de localStorage donde vive su JSON.
const FLAT_KEYS: Record<string, string> = {
  custom_routines: 'dermatique_custom_routines',
  routine_selections: 'dermatique_routine_selections'
};

type Meta = Record<string, string>; // clave -> updatedAt ISO de la última edición local conocida

function loadMeta(): Meta {
  try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function saveMeta(meta: Meta) {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { /* sin localStorage */ }
}

function readOverrides(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_LS) || '{}') || {}; } catch (e) { return {}; }
}

// Valor local de una clave como string JSON, o null si no existe.
function readLocal(key: string): string | null {
  if (key.startsWith(OVERRIDE_PREFIX)) {
    const v = readOverrides()[key.slice(OVERRIDE_PREFIX.length)];
    return v === undefined ? null : JSON.stringify(v);
  }
  const ls = FLAT_KEYS[key];
  return ls ? localStorage.getItem(ls) : null;
}

function writeLocal(key: string, value: string | null) {
  try {
    if (key.startsWith(OVERRIDE_PREFIX)) {
      const all = readOverrides();
      const k = key.slice(OVERRIDE_PREFIX.length);
      if (value === null) delete all[k]; else all[k] = JSON.parse(value);
      localStorage.setItem(OVERRIDES_LS, JSON.stringify(all));
      return;
    }
    const ls = FLAT_KEYS[key];
    if (!ls) return;
    if (value === null) localStorage.removeItem(ls); else localStorage.setItem(ls, value);
  } catch (e) { /* valor remoto corrupto o sin localStorage: se ignora */ }
}

let tableReady = false;
async function ensureTable(): Promise<string> {
  const tbl = getTableName('app_settings');
  if (!tableReady) {
    await executeQuery(`CREATE TABLE IF NOT EXISTS ${tbl} (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL)`);
    tableReady = true;
  }
  return tbl;
}

type AppliedListener = (keys: string[]) => void;
const listeners = new Set<AppliedListener>();
// Se avisa cuando una sincronización trajo cambios remotos a localStorage, para que la UI recargue.
export function onSettingsApplied(cb: AppliedListener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

let running: Promise<void> | null = null;
let rerun = false;

export function syncSettings(): Promise<void> {
  if (!navigator.onLine) return Promise.resolve();
  if (running) { rerun = true; return running; }
  running = (async () => {
    try {
      do {
        rerun = false;
        await syncOnce();
      } while (rerun);
    } catch (e) {
      console.warn('No se pudo sincronizar la configuración de rutinas con Turso; se reintentará:', e);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce() {
  const tbl = await ensureTable();
  const res = await executeQuery(`SELECT key, value, updated_at FROM ${tbl}`);
  const remote = new Map<string, { value: string | null; updatedAt: string }>(
    (res.rows || []).map((r: any) => [String(r.key), { value: r.value === null ? null : String(r.value), updatedAt: String(r.updated_at) }])
  );
  const meta = loadMeta();

  // Datos locales anteriores a esta función (sin fecha): si el servidor no los tiene, se suben;
  // si el servidor sí tiene esa clave, manda el servidor.
  const localKeys = [
    ...Object.keys(FLAT_KEYS),
    ...Object.keys(readOverrides()).map(k => OVERRIDE_PREFIX + k)
  ];
  for (const k of localKeys) {
    if (!meta[k] && !remote.has(k) && readLocal(k) !== null) meta[k] = new Date().toISOString();
  }

  const applied: string[] = [];
  const allKeys = new Set<string>([...remote.keys(), ...Object.keys(meta)]);
  for (const key of allKeys) {
    const r = remote.get(key);
    const localTs = meta[key] || '';
    if (r && r.updatedAt > localTs) {
      writeLocal(key, r.value);
      meta[key] = r.updatedAt;
      applied.push(key);
    } else if (localTs && (!r || localTs > r.updatedAt)) {
      await executeQuery(
        `INSERT INTO ${tbl} (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE excluded.updated_at > ${tbl}.updated_at`,
        [key, readLocal(key), localTs]
      );
    }
  }
  saveMeta(meta);
  if (applied.length > 0) listeners.forEach(cb => cb(applied));
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Llamar DESPUÉS de escribir el valor en localStorage. Estampa la edición y la sube (con una
// pequeña espera para no enviar una petición por cada tecla). Si no hay conexión queda pendiente y
// el siguiente syncSettings (al iniciar o al reconectar) la sube.
export function markSettingChanged(key: string) {
  const meta = loadMeta();
  meta[key] = new Date().toISOString();
  saveMeta(meta);
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void syncSettings(); }, 800);
}

export function overrideSettingKey(routineKey: string): string {
  return OVERRIDE_PREFIX + routineKey;
}
