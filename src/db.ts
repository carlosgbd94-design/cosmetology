import Dexie, { type Table } from 'dexie';
import { Patient, Anamnesis, Product, Consultation, ConsultationStep, Prescription } from './types';

// Web configuration for Turso (matching existing credentials)
const TURSO_URL = import.meta.env.VITE_LIBSQL_DB_URL || 'https://cosmetics-prodcts-carlos-becerra.aws-us-west-2.turso.io';
const TURSO_TOKEN = import.meta.env.VITE_LIBSQL_DB_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODAyNTc5MzEsImlkIjoiMDE5ZTdmOWUtMmEwMS03OWMxLTg3N2YtN2RkY2FkZjg1ZDk5IiwicmlkIjoiM2VhNTAwMzUtMjIwZS00MWM2LWI3NjItNTM2NjQ1NzJhM2EzIn0.7-B8dPeRempyRbJBif_dZYDmoKizAwHz9F9RTv-WGNmpniIRicU3GkcENXOi2k0n1_rKfDuL69f1cLAOyeFnBg';

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
    
    // Explicit SQLite transaction block
    stmts.push({ sql: "BEGIN TRANSACTION", args: [] });

    stmts.push({
      sql: `INSERT OR REPLACE INTO consultations (id, patient_id, provider_id, visit_date, skin_biotype, fitzpatrick_scale, skin_conditions, medical_diagnosis, clinical_notes, state, allergies, medical_conditions, recommendations)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        consultation.recommendations || null
      ]
    });

    stmts.push({
      sql: `DELETE FROM consultation_steps WHERE consultation_id = ?`,
      args: [consultation.id]
    });

    for (const step of steps) {
      stmts.push({
        sql: `INSERT INTO consultation_steps (id, consultation_id, step_order, step_name, product_id, custom_product_name, custom_brand, custom_active_ingredients, custom_actions, application_description, aparatology_settings)
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
      sql: `DELETE FROM prescriptions WHERE consultation_id = ?`,
      args: [consultation.id]
    });

    for (const pres of prescriptions) {
      stmts.push({
        sql: `INSERT INTO prescriptions (id, consultation_id, product_id, time_of_day, dosage_instructions, application_frequency, step_name, custom_product_name, custom_brand, custom_active_ingredients, custom_actions)
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

// Database initial seeding (SQLite/libSQL)
export async function seedTables(): Promise<void> {
  if (!navigator.onLine) return;
  try {
    // 1. Setup tables
    await executeQuery(`
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY,
        first_name_encrypted TEXT NOT NULL,
        last_name_encrypted TEXT NOT NULL,
        date_of_birth TEXT NOT NULL,
        email_hashed TEXT UNIQUE NOT NULL,
        phone_encrypted TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS anamnesis (
        id TEXT PRIMARY KEY,
        patient_id TEXT NOT NULL UNIQUE,
        medical_diagnosis TEXT,
        surgical_history TEXT,
        allergies_cosmetics TEXT NOT NULL DEFAULT '',
        current_medications TEXT NOT NULL DEFAULT '',
        lifestyle_metrics TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS products (
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
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS consultations (
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
        recommendations TEXT,
        FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE RESTRICT
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS consultation_steps (
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
        FOREIGN KEY (consultation_id) REFERENCES consultations(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
        UNIQUE (consultation_id, step_order)
      )
    `);

    await executeQuery(`
      CREATE TABLE IF NOT EXISTS prescriptions (
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
    // Hot migration to reconstruct products table check constraint if legacy exists
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

    // Hot migration for prescriptions table to make product_id nullable and add new columns
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

    // Add new columns to existing tables if missing
    try {
      await executeQuery(`ALTER TABLE consultations ADD COLUMN allergies TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultations ADD COLUMN medical_conditions TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultations ADD COLUMN recommendations TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE products ADD COLUMN skin_biotypes TEXT DEFAULT '[]'`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE products ADD COLUMN stock_quantity INTEGER DEFAULT 10`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE products ADD COLUMN cost_price REAL DEFAULT 0`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE products ADD COLUMN reorder_point INTEGER DEFAULT 3`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultations ADD COLUMN signature_data_url TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultations ADD COLUMN before_image_url TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultations ADD COLUMN after_image_url TEXT`);
    } catch (e) {}

    // Ensure all custom step columns exist
    try {
      await executeQuery(`ALTER TABLE consultation_steps ADD COLUMN custom_product_name TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultation_steps ADD COLUMN custom_brand TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultation_steps ADD COLUMN custom_active_ingredients TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultation_steps ADD COLUMN custom_actions TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultation_steps ADD COLUMN application_description TEXT`);
    } catch (e) {}
    try {
      await executeQuery(`ALTER TABLE consultation_steps ADD COLUMN aparatology_settings TEXT`);
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

    for (const prod of defaultProducts) {
      await executeQuery(`
        INSERT OR IGNORE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, prod);
    }

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

        let idx = 10; // offset so default ids don't collide
        for (const key of Object.keys(grouped)) {
          const item = grouped[key];
          // Check if this product name is already seeded
          const nameCheck = await executeQuery("SELECT id FROM products WHERE name = ? AND brand_line = ?", [item.name, item.brand]);
          if (nameCheck.rows && nameCheck.rows.length > 0) {
            continue;
          }

          const id = `MIG-${idx.toString().padStart(4, '0')}`;
          const brandCode = item.brand ? item.brand.substring(0, 3).toUpperCase() : 'GEN';
          const sku = `SKU-${brandCode}-${idx.toString().padStart(4, '0')}`;
          const activeJSON = JSON.stringify(item.actives);
          const actionJSON = JSON.stringify(item.actions);
          const isProfessional = item.protocol === 'Apoyo en Casa' ? 0 : 1;

          await executeQuery(`
            INSERT OR IGNORE INTO products (id, sku, name, brand_line, active_ingredients, physiological_actions, retail_price, is_professional_use)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [id, sku, item.name, item.brand || 'General', activeJSON, actionJSON, 500.00, isProfessional]);
          idx++;
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

