import { query } from '../database.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { method } = req;

  try {
    if (method === 'GET') {
      const { action, brand, category, id } = req.query;

      // 1. Fetch distinct brands
      if (action === 'brands') {
        const result = await query(
          "SELECT DISTINCT brand FROM products WHERE brand IS NOT NULL AND brand != '' ORDER BY brand ASC"
        );
        return res.status(200).json(result.rows.map(row => row.brand));
      }

      // 2. Fetch categories for a brand
      if (action === 'categories') {
        const result = await query(
          "SELECT DISTINCT category FROM products WHERE brand = ? AND category IS NOT NULL AND category != '' ORDER BY category ASC",
          [brand || '']
        );
        return res.status(200).json(result.rows.map(row => row.category));
      }

      // 3. Fetch products for a brand and category
      if (action === 'products') {
        const result = await query(
          "SELECT id, name FROM products WHERE brand = ? AND category = ? ORDER BY name ASC",
          [brand || '', category || '']
        );
        return res.status(200).json(result.rows);
      }

      // 4. Fetch details for a specific product by ID
      if (action === 'detalles') {
        const result = await query(
          "SELECT * FROM products WHERE id = ?",
          [id || '']
        );
        return res.status(200).json(result.rows[0] || null);
      }

      // 5. Fetch all products (for Admin catalog table view)
      if (action === 'list') {
        const result = await query(
          "SELECT * FROM products ORDER BY name ASC"
        );
        return res.status(200).json(result.rows);
      }

      // 6. Fetch distinct active ingredients (for Levenshtein check)
      if (action === 'ingredientes') {
        const result = await query(
          "SELECT DISTINCT active_ingredients FROM products WHERE active_ingredients IS NOT NULL AND active_ingredients != ''"
        );
        
        // Flatten list by comma-separating
        const allActives = new Set();
        result.rows.forEach(row => {
          row.active_ingredients.split(',').forEach(act => {
            const trimmed = act.trim();
            if (trimmed) allActives.add(trimmed);
          });
        });
        
        return res.status(200).json(Array.from(allActives).map(act => ({ activo: act, accion: 'Ingrediente Activo Catálogo' })));
      }

      // 7. Fetch historic patient sheets
      if (action === 'fichas') {
        const result = await query(
          "SELECT f.*, p.name as producto, p.brand as linea, p.category as protocolo FROM fichas_pacientes f LEFT JOIN products p ON f.protocolo_id = p.id ORDER BY f.id DESC"
        );
        return res.status(200).json(result.rows);
      }

      // 8. Delete a product
      if (action === 'delete_product') {
        await query("DELETE FROM products WHERE id = ?", [id || '']);
        return res.status(200).json({ success: true, message: 'Producto eliminado correctamente.' });
      }

      return res.status(400).json({ error: 'Invalid GET action parameter' });
    }

    if (method === 'POST') {
      const { action } = req.body;

      // 9. Save a patient sheet
      if (action === 'save_ficha') {
        const { nombre, fecha, biotipo, diagnostico, condicion, protocolo_id } = req.body;
        
        if (!nombre || !fecha) {
          return res.status(400).json({ error: 'Nombre and Fecha are required fields' });
        }

        const result = await query(
          'INSERT INTO fichas_pacientes (nombre, fecha, biotipo, diagnostico, condicion, protocolo_id) VALUES (?, ?, ?, ?, ?, ?)',
          [
            nombre,
            fecha,
            biotipo || '',
            diagnostico || '',
            condicion || '',
            protocolo_id || null
          ]
        );

        return res.status(201).json({ success: true, id: result.lastInsertRowid, message: 'Ficha guardada con éxito.' });
      }

      // 10. Save or Edit a Single Product
      if (action === 'save_product') {
        const { id, brand, name, category, capacity, price_aesthetic, price_public, active_ingredients, skin_indication, is_edit } = req.body;

        if (!id || !brand || !name || !category) {
          return res.status(400).json({ error: 'ID/Clave, Marca, Nombre and Categoría are required.' });
        }

        // Clean prices
        const priceAes = price_aesthetic ? parseFloat(String(price_aesthetic).replace(/[$\s,]/g, '')) : null;
        const pricePub = price_public ? parseFloat(String(price_public).replace(/[$\s,]/g, '')) : null;

        if (is_edit) {
          // Update product
          await query(
            `UPDATE products SET brand = ?, name = ?, category = ?, capacity = ?, 
             price_aesthetic = ?, price_public = ?, active_ingredients = ?, skin_indication = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [brand, name, category, capacity || null, priceAes, pricePub, active_ingredients || null, skin_indication || null, id]
          );
          return res.status(200).json({ success: true, message: 'Producto actualizado con éxito.' });
        } else {
          // Check for unique key duplicate on insert
          const check = await query("SELECT id FROM products WHERE id = ?", [id]);
          if (check.rows.length > 0) {
            return res.status(400).json({ error: `El ID/Clave '${id}' ya está registrado en el inventario.` });
          }

          // Insert new product
          await query(
            `INSERT INTO products (id, brand, name, category, capacity, price_aesthetic, price_public, active_ingredients, skin_indication) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, brand, name, category, capacity || null, priceAes, pricePub, active_ingredients || null, skin_indication || null]
          );
          return res.status(201).json({ success: true, message: 'Producto creado con éxito.' });
        }
      }

      return res.status(400).json({ error: 'Invalid POST action parameter' });
    }

    res.setHeader('Allow', ['GET', 'POST', 'OPTIONS']);
    return res.status(405).end(`Method ${method} Not Allowed`);
  } catch (error) {
    console.error('[API Products Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}
