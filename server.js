import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './database.js';
import productsHandler from './api/products.js';
import uploadHandler from './api/upload.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Increase payload sizes for large excel/csv uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static assets from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Mount API endpoints
app.all('/api/products', async (req, res) => {
  try {
    await productsHandler(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.all('/api/upload', async (req, res) => {
  try {
    await uploadHandler(req, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fallback to SPA index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start DB and Express Server
async function startServer() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`[Server] Selector de Cosméticos running at:`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`==================================================`);
  });
}

startServer();
