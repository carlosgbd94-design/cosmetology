import { createClient } from '@libsql/client/web';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const isPostgres = !!process.env.DATABASE_URL;

let dbClient = null;
let pgPool = null;

if (isPostgres) {
  console.log('[Database] Connecting to PostgreSQL (Supabase)...');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for Supabase in many environments
  });
} else {
  const url = process.env.LIBSQL_DB_URL || 'file:cosmeticos.db';
  const authToken = process.env.LIBSQL_DB_TOKEN || '';
  console.log(`[Database] Connecting to LibSQL/Turso: ${url}`);
  dbClient = createClient({
    url,
    authToken,
  });
  dbClient.getIsSchemaDatabase = async () => false;
}

// Unified query execute method
export async function query(sql, args = []) {
  if (isPostgres) {
    // Convert SQLite "?" placeholders to PostgreSQL "$1, $2, ..." placeholders
    let index = 1;
    const pgSql = sql.replace(/\?/g, () => `$${index++}`);
    const result = await pgPool.query(pgSql, args);
    return {
      rows: result.rows,
      lastInsertRowid: result.rows[0]?.id || null, // fallback for insert responses
    };
  } else {
    const result = await dbClient.execute({ sql, args });
    return {
      rows: result.rows,
      lastInsertRowid: result.lastInsertRowid,
    };
  }
}

// Unified batch execution helper (uses transactions)
export async function executeBatch(statements) {
  if (isPostgres) {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      for (const stmt of statements) {
        let index = 1;
        const pgSql = stmt.sql.replace(/\?/g, () => `$${index++}`);
        await client.query(pgSql, stmt.args || []);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } else {
    await dbClient.batch(statements);
  }
}

// Initialize tables based on SQL database target
export async function initDatabase() {
  try {
    if (isPostgres) {
      // 1. PostgreSQL Schema
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS public.products (
          id VARCHAR(50) PRIMARY KEY,
          brand VARCHAR(100) NOT NULL,
          name VARCHAR(255) NOT NULL,
          category VARCHAR(100) NOT NULL,
          capacity VARCHAR(50),
          price_aesthetic NUMERIC(10, 2),
          price_public NUMERIC(10, 2),
          active_ingredients TEXT,
          skin_indication TEXT,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        )
      `);

      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS public.fichas_pacientes (
          id SERIAL PRIMARY KEY,
          nombre VARCHAR(255) NOT NULL,
          fecha DATE NOT NULL,
          biotipo VARCHAR(100),
          diagnostico TEXT,
          condicion TEXT,
          protocolo_id VARCHAR(50)
        )
      `);

      // Create indexes for Postgres
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_products_brand ON public.products(brand)`);
      await pgPool.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON public.products(category)`);

      console.log('[Database] PostgreSQL schema initialized successfully.');
    } else {
      // 2. LibSQL / SQLite Schema (Updated to map the new products catalog schema)
      await dbClient.execute(`
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          brand TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          capacity TEXT,
          price_aesthetic REAL,
          price_public REAL,
          active_ingredients TEXT,
          skin_indication TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await dbClient.execute(`
        CREATE TABLE IF NOT EXISTS fichas_pacientes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nombre TEXT,
          fecha TEXT,
          biotipo TEXT,
          diagnostico TEXT,
          condicion TEXT,
          protocolo_id TEXT
        )
      `);

      console.log('[Database] LibSQL/SQLite schema initialized successfully.');
    }
  } catch (error) {
    console.error('[Database] Schema initialization failed:', error);
  }
}
