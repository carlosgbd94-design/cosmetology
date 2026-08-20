import Dexie, { type Table } from 'dexie';
import { Patient, Anamnesis, Product, Consultation, ConsultationStep, Prescription } from './types';

// Configuración de Turso: se toma exclusivamente de variables de entorno (nunca hardcodeada en el
// código fuente). En local, defínelas en .env; en el despliegue, como secretos de GitHub Actions.
const TURSO_URL = import.meta.env.VITE_LIBSQL_DB_URL || '';
const TURSO_TOKEN = import.meta.env.VITE_LIBSQL_DB_TOKEN || '';

if (!TURSO_URL || !TURSO_TOKEN) {
  console.warn('VITE_LIBSQL_DB_URL / VITE_LIBSQL_DB_TOKEN no están configuradas. La app funcionará solo con datos locales hasta que se configuren.');
}

// Local Dexie Database v6 setup
class LocalClinicalDB extends Dexie {
  patients!: Table<Patient, string>;
  anamnesis!: Table<Anamnesis, string>;
  products!: Table<Product, string>;
  consultations!: Table<Consultation, string>;
  consultation_steps!: Table<ConsultationStep, string>;
  prescriptions!: Table<Prescription, string>;

  constructor() {
    super('DermatiqueClinicalDB_v7');
    this.version(7).stores({
      patients: 'id, emailHashed',
      anamnesis: 'id, patientId',
      products: 'id, sku',
      consultations: 'id, patientId, visitDate',
      consultation_steps: 'id, consultationId, stepOrder',
      prescriptions: 'id, consultationId, productId'
    });
  }
}

export const db = new LocalClinicalDB();

// --- Turso Hrana-over-HTTP Decoder & Encoder ---
function encodeValue(v: any): any {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      return { type: "integer", value: String(v) };
    }
    return { type: "float", value: v };
  }
  return { type: "text", value: String(v) };
}

function decodeValue(v: any): any {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  return v.value;
}

function decodeResultSet(result: any): any[] {
  const columns = result.cols.map((c: any) => c.name);
  return result.rows.map((row: any) => {
    const obj: any = {};
    row.forEach((val: any, idx: number) => {
      obj[columns[idx]] = decodeValue(val);
    });
    return obj;
  });
}

// Multi-Tenant Dynamic Table Helper
export function getActiveLicensePrefix(): string {
  const token = (localStorage.getItem('dermatique_license_token') || '').trim().toUpperCase();
  const masterKeys = ['DERM-PRO-2026-ACTIVE', 'DERM-CLINIC-MASTER-99'];
  if (!token || masterKeys.includes(token)) {
    return ''; // Master tables without prefix (products, patients, consultations, etc.)
  }
  // Sanitize license token into a valid SQLite table prefix
  const cleanId = token.replace(/[^A-Z0-9]/g, '_').toLowerCase();
  return `usr_${cleanId}_`;
}

export function getTableName(baseName: string): string {
  const prefix = getActiveLicensePrefix();
  return prefix ? `${prefix}${baseName}` : baseName;
}

export async function executeQuery(sql: string, args: any[] = []): Promise<{ rows: any[]; lastInsertRowid: any }> {
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

export async function executeBatch(statements: { sql: string; args?: any[] }[]): Promise<any> {
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

// Transactional Clinical Save (ACID atomic remote + local)
export async function saveConsultationTransaction(
  consultation: Consultation,
  steps: ConsultationStep[],
  prescriptions: Prescription[]
): Promise<void> {
  // 1. Save locally to Dexie (Atomic transactions locally)
  await db.transaction('rw', [db.consultations, db.consultation_steps, db.prescriptions], async () => {
    await db.consultations.put(consultation);
    await db.consultation_steps.where('consultationId').equals(consultation.id).delete();
    for (const step of steps) {
      await db.consultation_steps.put(step);
    }
    await db.prescriptions.where('consultationId').equals(consultation.id).delete();
    for (const pres of prescriptions) {
      await db.prescriptions.put(pres);
    }
  });

  // 2. Save remotely to Turso in a pipeline transaction block
  if (navigator.onLine) {
    const stmts: { sql: string; args: any[] }[] = [];
    
    const tblConsultations = getTableName('consultations');
    const tblSteps = getTableName('consultation_steps');
    const tblPrescriptions = getTableName('prescriptions');

    // Explicit SQLite transaction block
    stmts.push({ sql: "BEGIN TRANSACTION", args: [] });

    // UPSERT (no INSERT OR REPLACE): un REPLACE borra y reinserta la fila, así que cualquier
    // columna no listada (como created_at) vuelve a su DEFAULT y se pierde la fecha original de
    // creación en cada edición. Con ON CONFLICT DO UPDATE, created_at nunca se toca en una edición.
    stmts.push({
      sql: `INSERT INTO ${tblConsultations} (id, patient_id, provider_id, visit_date, skin_biotype, fitzpatrick_scale, skin_conditions, medical_diagnosis, clinical_notes, state, allergies, medical_conditions, recommendations, consent_accepted, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET
              patient_id = excluded.patient_id,
              provider_id = excluded.provider_id,
              visit_date = excluded.visit_date,
              skin_biotype = excluded.skin_biotype,
              fitzpatrick_scale = excluded.fitzpatrick_scale,
              skin_conditions = excluded.skin_conditions,
              medical_diagnosis = excluded.medical_diagnosis,
              clinical_notes = excluded.clinical_notes,
              state = excluded.state,
              allergies = excluded.allergies,
              medical_conditions = excluded.medical_conditions,
              recommendations = excluded.recommendations,
              consent_accepted = excluded.consent_accepted,
              updated_at = CURRENT_TIMESTAMP`,
      args: [
        consultation.id,
        consultation.patientId,
        consultation.providerId,
        consultation.visitDate,
        consultation.skinBiotype,
        consultation.fitzpatrickScale,
        consultation.skinConditions,
        consultation.medicalDiagnosis || null,
        consultation.clinicalNotes,
        consultation.state,
        consultation.allergies || null,
        consultation.medicalConditions || null,
        consultation.recommendations || null,
        consultation.consentAccepted ? 1 : 0
      ]
    });

    stmts.push({
      sql: `DELETE FROM ${tblSteps} WHERE consultation_id = ?`,
      args: [consultation.id]
    });

    for (const step of steps) {
      stmts.push({
        sql: `INSERT INTO ${tblSteps} (id, consultation_id, step_order, step_name, product_id, custom_product_name, custom_brand, custom_active_ingredients, custom_actions, application_description, aparatology_settings)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          step.id,
          step.consultationId,
          step.stepOrder,
          step.stepName,
          step.productId || null,
          step.customProductName || null,
          step.customBrand || null,
          step.customActiveIngredients || null,
          step.customActions || null,
          step.applicationDescription || null,
          step.aparatologySettings || null
        ]
      });
    }

    stmts.push({
      sql: `DELETE FROM ${tblPrescriptions} WHERE consultation_id = ?`,
      args: [consultation.id]
    });

    for (const pres of prescriptions) {
      stmts.push({
        sql: `INSERT INTO ${tblPrescriptions} (id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          pres.id,
          pres.consultationId,
          pres.productId || null,
          pres.timeOfDay,
          pres.dosageInstructions,
          pres.applicationFrequency,
          pres.stepName || null,
          pres.customProductName || null,
          pres.customBrand || null,
          pres.customActiveIngredients || null,
          pres.customActions || null
        ]
      });
    }

    stmts.push({ sql: "COMMIT", args: [] });

    try {
      await executeBatch(stmts);
    } catch (e) {
      // Attempt rollback if pipeline fails
      try {
        await executeQuery("ROLLBACK");
      } catch(re) {
        console.error("Failed to rollback remote transaction:", re);
      }
      throw e;
    }
  }
}

async function tableHasColumn(tableName: string, columnName: string): Promise<boolean> {
  try {
    const res = await executeQuery(`PRAGMA table_info(${tableName})`);
    return res.rows.some((r: any) => String(r.name).toLowerCase() === columnName.toLowerCase());
  } catch (e) {
    // Si no se puede inspeccionar el esquema, asumir que ya está migrado para evitar reconstrucciones destructivas.
    return true;
  }
}

// Evita que llamadas concurrentes (p. ej. React StrictMode invocando el mismo efecto dos veces)
// disparen dos migraciones destructivas en paralelo contra la misma tabla remota.
let seedTablesInFlight: Promise<void> | null = null;

export async function seedTables(): Promise<void> {
  if (!navigator.onLine) return;
  if (seedTablesInFlight) return seedTablesInFlight;
  seedTablesInFlight = seedTablesImpl();
  try {
    await seedTablesInFlight;
  } finally {
    seedTablesInFlight = null;
  }
}

async function seedTablesImpl(): Promise<void> {
  try {
    const tblPatients = getTableName('patients');
    const tblAnamnesis = getTableName('anamnesis');
    const tblProducts = getTableName('products');
    const tblConsultations = getTableName('consultations');
    const tblSteps = getTableName('consultation_steps');
    const tblPrescriptions = getTableName('prescriptions');

    // 1. Setup tables (Isolated per License Key or Master) — un solo request en lote en vez de
    // 6 idas y vueltas de red secuenciales, para que la app no se quede colgada en "Sincronizando...".
    await executeBatch([
      { sql: `
        CREATE TABLE IF NOT EXISTS ${tblPatients} (
          id TEXT PRIMARY KEY,
          first_name_encrypted TEXT NOT NULL,
          last_name_encrypted TEXT NOT NULL,
          date_of_birth TEXT NOT NULL,
          email_hashed TEXT UNIQUE NOT NULL,
          phone_encrypted TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      ` },
      { sql: `
        CREATE TABLE IF NOT EXISTS ${tblAnamnesis} (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL UNIQUE,
          medical_diagnosis TEXT,
          surgical_history TEXT,
          allergies_cosmetics TEXT NOT NULL DEFAULT '',
          current_medications TEXT NOT NULL DEFAULT '',
          lifestyle_metrics TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      ` },
      { sql: `
        CREATE TABLE IF NOT EXISTS ${tblProducts} (
          id TEXT PRIMARY KEY,
          sku TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          brand_line TEXT NOT NULL,
          active_ingredients TEXT NOT NULL DEFAULT '',
          physiological_actions TEXT NOT NULL DEFAULT '',
          retail_price REAL NOT NULL,
          is_professional_use INTEGER DEFAULT 1 CHECK (is_professional_use IN (0, 1, 2)),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      ` },
      { sql: `
        CREATE TABLE IF NOT EXISTS ${tblConsultations} (
          id TEXT PRIMARY KEY,
          patient_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          visit_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          skin_biotype TEXT NOT NULL,
          fitzpatrick_scale INTEGER CHECK (fitzpatrick_scale BETWEEN 1 AND 6),
          skin_conditions TEXT NOT NULL DEFAULT '',
          medical_diagnosis TEXT,
          clinical_notes TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'Borrador' CHECK (state IN ('Borrador', 'Admision', 'Consentimiento', 'Tratamiento', 'Evaluacion')),
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          recommendations TEXT
        )
      ` },
      { sql: `
        CREATE TABLE IF NOT EXISTS ${tblSteps} (
          id TEXT PRIMARY KEY,
          consultation_id TEXT NOT NULL,
          step_order INTEGER NOT NULL,
          step_name TEXT NOT NULL,
          product_id TEXT,
          custom_product_name TEXT,
          custom_brand TEXT,
          custom_active_ingredients TEXT,
          custom_actions TEXT,
          application_description TEXT,
          aparatology_settings TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (consultation_id, step_order)
        )
      ` },
      { sql: `
        CREATE TABLE IF NOT EXISTS ${tblPrescriptions} (
          id TEXT PRIMARY KEY,
          consultation_id TEXT NOT NULL,
          product_id TEXT,
          time_of_day TEXT NOT NULL CHECK (time_of_day IN ('Dia', 'Noche', 'Dia y Noche')),
          dosage_instructions TEXT NOT NULL,
          application_frequency TEXT NOT NULL,
          step_name TEXT,
          custom_product_name TEXT,
          custom_brand TEXT,
          custom_active_ingredients TEXT,
          custom_actions TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      ` }
    ]);
    // Hot migration (una sola vez): agrega skin_biotypes reconstruyendo la tabla solo si aún no existe la columna.
    // IMPORTANTE: esta reconstrucción es destructiva (DROP + RENAME), por eso se protege con la
    // verificación de esquema de abajo para que nunca vuelva a ejecutarse una vez migrada la tabla.
    if (!(await tableHasColumn('products', 'skin_biotypes'))) {
      try {
        await executeQuery(`PRAGMA foreign_keys = OFF`);
        await executeQuery(`
          CREATE TABLE IF NOT EXISTS products_new (
            id TEXT PRIMARY KEY,
            sku TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            brand_line TEXT NOT NULL,
            active_ingredients TEXT NOT NULL DEFAULT '',
            physiological_actions TEXT NOT NULL DEFAULT '',
            retail_price REAL NOT NULL,
            is_professional_use INTEGER DEFAULT 1 CHECK (is_professional_use IN (0, 1, 2)),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            skin_biotypes TEXT DEFAULT '[]'
          )
        `);
        await executeQuery(`
          INSERT OR IGNORE INTO products_new (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use, created_at, skin_biotypes)
          SELECT id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use, created_at, COALESCE(skin_biotypes, '[]') FROM products
        `);
        await executeQuery(`DROP TABLE IF EXISTS products`);
        await executeQuery(`ALTER TABLE products_new RENAME TO products`);
        await executeQuery(`PRAGMA foreign_keys = ON`);
        console.log("Hot migration of products table completed successfully with foreign keys bypassed.");
      } catch(err) {
        console.warn("Hot migration of products table warning/skipped:", err);
        try {
          await executeQuery(`PRAGMA foreign_keys = ON`);
        } catch(e) {}
      }
    }

    // Hot migration (una sola vez): relaja product_id a NULL y agrega columnas nuevas, reconstruyendo
    // la tabla solo si el esquema todavía no está migrado. Misma protección que arriba: sin esta
    // verificación, esta reconstrucción destructiva se repetiría en cada carga de la app.
    if (!(await tableHasColumn('prescriptions', 'custom_active_ingredients'))) {
      try {
        await executeQuery(`PRAGMA foreign_keys = OFF`);
        await executeQuery(`
          CREATE TABLE IF NOT EXISTS prescriptions_new (
            id TEXT PRIMARY KEY,
            consultation_id TEXT NOT NULL,
            product_id TEXT,
            time_of_day TEXT NOT NULL CHECK (time_of_day IN ('Dia', 'Noche', 'Dia y Noche')),
            dosage_instructions TEXT NOT NULL,
            application_frequency TEXT NOT NULL,
            step_name TEXT,
            custom_product_name TEXT,
            custom_brand TEXT,
            custom_active_ingredients TEXT,
            custom_actions TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
          )
        `);
        // We will perform table schema check/migration by selecting whatever exists and mapping it
        // Let's check which columns are in the old table and insert them or fallback to NULL
        try {
          await executeQuery(`
            INSERT OR IGNORE INTO prescriptions_new (id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency)
            SELECT id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency FROM prescriptions
          `);
        } catch(insErr) {
          // Old columns might differ or we already have the new columns. Let's do a complete copy of existing fields
          try {
            await executeQuery(`
              INSERT OR IGNORE INTO prescriptions_new (id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions)
              SELECT id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions FROM prescriptions
            `);
          } catch(insErr2) {}
        }
        await executeQuery(`DROP TABLE IF EXISTS prescriptions`);
        await executeQuery(`ALTER TABLE prescriptions_new RENAME TO prescriptions`);
        await executeQuery(`PRAGMA foreign_keys = ON`);
        console.log("Hot migration of prescriptions table completed successfully.");
      } catch(err) {
        console.warn("Hot migration of prescriptions table warning/skipped:", err);
        try {
          await executeQuery(`PRAGMA foreign_keys = ON`);
        } catch(e) {}
      }
    }

    // Add new columns to existing tables if missing. En un solo lote: cada ALTER que falle porque
    // la columna ya existe no interrumpe a los demás (Turso ejecuta cada statement del pipeline de
    // forma independiente), así que es seguro ignorar el error del lote completo.
    try {
      await executeBatch([
        { sql: `ALTER TABLE consultations ADD COLUMN allergies TEXT` },
        { sql: `ALTER TABLE consultations ADD COLUMN medical_conditions TEXT` },
        { sql: `ALTER TABLE consultations ADD COLUMN recommendations TEXT` },
        { sql: `ALTER TABLE products ADD COLUMN skin_biotypes TEXT DEFAULT '[]'` },
        { sql: `ALTER TABLE products ADD COLUMN product_type TEXT DEFAULT 'General'` },
        { sql: `ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 10` },
        { sql: `ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0` },
        { sql: `ALTER TABLE products ADD COLUMN reorder_point INTEGER DEFAULT 3` },
        { sql: `ALTER TABLE consultations ADD COLUMN before_image_url TEXT` },
        { sql: `ALTER TABLE consultations ADD COLUMN after_image_url TEXT` },
        { sql: `ALTER TABLE consultations ADD COLUMN consent_accepted INTEGER DEFAULT 0` },
        { sql: `ALTER TABLE consultations ADD COLUMN deleted_at TEXT` },
        { sql: `ALTER TABLE patients ADD COLUMN deleted_at TEXT` },
        // Ensure all custom step columns exist
        { sql: `ALTER TABLE consultation_steps ADD COLUMN custom_product_name TEXT` },
        { sql: `ALTER TABLE consultation_steps ADD COLUMN custom_brand TEXT` },
        { sql: `ALTER TABLE consultation_steps ADD COLUMN custom_active_ingredients TEXT` },
        { sql: `ALTER TABLE consultation_steps ADD COLUMN custom_actions TEXT` },
        { sql: `ALTER TABLE consultation_steps ADD COLUMN application_description TEXT` },
        { sql: `ALTER TABLE consultation_steps ADD COLUMN aparatology_settings TEXT` }
      ]);
    } catch (e) {}

    // Create default users table if missing
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS usuarios (
        usuario TEXT PRIMARY KEY,
        contrasena TEXT NOT NULL,
        rol TEXT DEFAULT 'especialista'
      )
    `);

    await executeQuery(`
      INSERT OR REPLACE INTO usuarios (usuario, contrasena, rol)
      VALUES ('clinica_dermatique', 'Dermatique2026', 'especialista')
    `);

    // Seed default products
    const defaultProducts = [
      ['MIG-ARM01', 'SKU-MIG-ARM01', 'Ambar', 'Miguett', '["Vetiveria zizanioides", "Santalum album", "Rosmarinus officinalis"]', '["Antioxidante", "calmante", "antiinflamatorio"]', 450.00, 1],
      ['CAS-ARM01', 'SKU-CAS-ARM01', 'Harmonizing Balance Cream', 'Casmara', '["Extracto de Flor de Loto", "Goji Berries", "Alantoína"]', '["Equilibrante", "calmante", "antioxidante"]', 980.00, 1],
      ['GDC-ARM02', 'SKU-GDC-ARM02', 'Royal Jelly Comforting Harmonizing Emulsion', 'Germaine de Capuccini', '["Jalea Real", "Extracto de Poria Cocos", "Pantenol"]', '["Nutritiva", "armonizadora", "revitalizante"]', 1160.00, 1],
      ['MES-ARM03', 'SKU-MES-ARM03', 'Balancing & Harmonizing Skin Repair', 'Mesoestetic', '["Centella Asiática", "Extracto de Caléndula", "Alfa-bisabolol"]', '["Reparador", "desensibilizante"]', 1300.00, 1],
      ['SKE-ARM04', 'SKU-SKE-ARM04', 'Aquatherm Harmonizing Cream F1', 'Skeyndor', '["Agua Termal", "Prebióticos azucarados", "Ceramidas"]', '["Calmante", "restaurador de barrera"]', 1040.00, 1],
      ['LID-ARM05', 'SKU-LID-ARM05', 'Sense Control Harmonizing Treatment', 'Lidherma', '["Péptidos desensibilizantes", "Aloe Vera", "Extracto de Avena"]', '["Disminuye la rojez", "descongestiona"]', 620.00, 0]
    ];

    await executeBatch(defaultProducts.map(prod => ({
      sql: `INSERT OR IGNORE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: prod
    })));

    // Migrate legacy productos_activos to products if the table exists and contains records
    try {
      const existing = await executeQuery("SELECT * FROM productos_activos");
      if (existing && existing.rows && existing.rows.length > 0) {
        const grouped: Record<string, {
          name: string;
          brand: string;
          actives: string[];
          actions: string[];
          protocol: string;
        }> = {};

        for (const row of existing.rows) {
          const key = `${row.linea}_${row.producto}`.toLowerCase();
          if (!grouped[key]) {
            grouped[key] = {
              name: row.producto,
              brand: row.linea,
              actives: [],
              actions: [],
              protocol: row.protocolo || ''
            };
          }
          if (row.activo && !grouped[key].actives.includes(row.activo)) {
            grouped[key].actives.push(row.activo);
          }
          if (row.accion && !grouped[key].actions.includes(row.accion)) {
            grouped[key].actions.push(row.accion);
          }
        }

        // Traer de una sola vez todos los pares nombre+marca ya existentes, en vez de hacer un SELECT
        // por cada grupo (podían ser decenas de idas y vueltas de red en cada carga de la app).
        const existingNames = await executeQuery("SELECT name, brand_line FROM products");
        const existingKeys = new Set(
          (existingNames.rows || []).map((r: any) => `${String(r.name).toLowerCase()}_${String(r.brand_line).toLowerCase()}`)
        );

        let idx = 10; // offset so default ids don't collide
        const insertStmts: { sql: string; args: any[] }[] = [];
        for (const key of Object.keys(grouped)) {
          const item = grouped[key];
          const lookupKey = `${item.name.toLowerCase()}_${(item.brand || 'General').toLowerCase()}`;
          if (existingKeys.has(lookupKey)) {
            continue;
          }

          const id = `MIG-${idx.toString().padStart(4, '0')}`;
          const brandCode = item.brand ? item.brand.substring(0, 3).toUpperCase() : 'GEN';
          const sku = `SKU-${brandCode}-${idx.toString().padStart(4, '0')}`;
          const activeJSON = JSON.stringify(item.actives);
          const actionJSON = JSON.stringify(item.actions);
          const isProfessional = item.protocol === 'Apoyo en Casa' ? 0 : 1;

          insertStmts.push({
            sql: `INSERT OR IGNORE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [id, sku, item.name, item.brand || 'General', activeJSON, actionJSON, 500.00, isProfessional]
          });
          idx++;
        }
        if (insertStmts.length > 0) {
          await executeBatch(insertStmts);
        }
      }
    } catch (migErr) {
      console.warn("Skip legacy productos_activos migration:", migErr);
    }
  } catch(e) {
    console.error("Database seeding failed:", e);
  }
}

// Automatic recovery of legacy user products and data from previous IndexedDB databases
export async function restoreLegacyIndexedDBData(): Promise<void> {
  const legacyDBNames = [
    'DermatiqueClinicalDB_v6',
    'DermatiqueClinicalDB_v5',
    'DermatiqueClinicalDB_v4',
    'DermatiqueClinicalDB_v3',
    'DermatiqueClinicalDB_v2',
    'DermatiqueClinicalDB',
    'ClinicalDB',
    'DermatiqueDB'
  ];

  for (const dbName of legacyDBNames) {
    try {
      const exists = await Dexie.exists(dbName);
      if (exists) {
        const oldDb = new Dexie(dbName);
        await oldDb.open();
        
        // Recover products
        if (oldDb.tables.some(t => t.name === 'products')) {
          const oldProducts = await oldDb.table('products').toArray();
          for (const prod of oldProducts) {
            await db.products.put(prod);
            if (navigator.onLine) {
              try {
                await executeQuery(
                  `INSERT OR IGNORE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use, skin_biotypes)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                  [prod.id, prod.sku, prod.name, prod.brandLine, prod.activeIngredients, prod.physiologicalActions, prod.retailPrice, typeof prod.isProfessionalUse === 'boolean' ? (prod.isProfessionalUse ? 1 : 0) : Number(prod.isProfessionalUse), prod.skinBiotypes || '[]']
                );
              } catch(e) {}
            }
          }
        }
        
        // Recover patients
        if (oldDb.tables.some(t => t.name === 'patients')) {
          const oldPatients = await oldDb.table('patients').toArray();
          for (const pat of oldPatients) {
            await db.patients.put(pat);
          }
        }
        oldDb.close();
      }
    } catch(e) {
      console.warn(`Attempt to restore from legacy DB ${dbName} skipped:`, e);
    }
  }
}

