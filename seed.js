import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbClient } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

async function seed() {
  const csvPath = path.join(__dirname, 'Resourses', 'base_datos_cosmetica.csv');
  console.log(`[Seeder] Reading file from: ${csvPath}`);
  
  if (!fs.existsSync(csvPath)) {
    console.error(`[Seeder] Error: File not found at ${csvPath}`);
    return;
  }
  
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  if (lines.length <= 1) {
    console.error('[Seeder] Error: CSV file has no records.');
    return;
  }
  
  const headers = parseCSVLine(lines[0]);
  console.log('[Seeder] CSV Headers:', headers);
  
  const insertStatements = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 4) continue;
    
    const [protocolo, producto, linea, activo, accion] = values;
    
    insertStatements.push({
      sql: 'INSERT INTO productos_activos (protocolo, producto, linea, activo, accion) VALUES (?, ?, ?, ?, ?)',
      args: [protocolo, producto, linea, activo, accion || '']
    });
  }
  
  console.log(`[Seeder] Ingesting ${insertStatements.length} active ingredient relationships...`);
  
  try {
    if (insertStatements.length > 0) {
      await dbClient.batch(insertStatements);
      console.log('[Seeder] Database seeding completed successfully.');
    }
  } catch (error) {
    console.error('[Seeder] Error seeding database:', error);
  }
}

seed();
