import XLSX from 'xlsx';
import path from 'path';

function run() {
  const filePath = path.join('Resourses', 'Catalogo_Productos_Corregido.xlsx');
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet);
  console.log("Total rows in Excel:", rows.length);
  if (rows.length > 0) {
    console.log("First row:", rows[0]);
    console.log("Unique products in Excel:", [...new Set(rows.map(r => r.PRODUCTO || r.producto || r.Producto))].length);
    console.log("First 5 rows:", rows.slice(0, 5));
  }
}

run();
