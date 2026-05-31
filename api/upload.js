import { executeBatch } from '../database.js';

// Clean pricing data
function sanitizePrice(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  // Strip currency symbols, spaces, commas
  const cleaned = String(value).replace(/[$\s,]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { products } = req.body;
    if (!products || !Array.isArray(products)) {
      return res.status(400).json({ error: 'Products array is required in request body.' });
    }

    const insertStatements = [];
    let count = 0;

    for (const item of products) {
      // Direct column mappings from incoming parsed payload
      const rawId = item.id || item["ID / CLAVE"] || item["ID/CLAVE"];
      const rawBrand = item.brand || item["MARCA"];
      const rawName = item.name || item["NOMBRE DEL PRODUCTO"] || item["NOMBRE"];
      const rawCategory = item.category || item["CATEGORÍA"] || item["CATEGORIA"];
      const rawCapacity = item.capacity || item["CAPACIDAD"];
      const rawPriceAes = item.price_aesthetic !== undefined ? item.price_aesthetic : item["PRECIO ESTETICISTA (MXN)"] || item["PRECIO ESTETICISTA"];
      const rawPricePub = item.price_public !== undefined ? item.price_public : item["PRECIO PÚBLICO (MXN)"] || item["PRECIO PUBLICO"];
      const rawActives = item.active_ingredients || item["ACTIVOS CLAVE"] || item["ACTIVOS"];
      const rawIndication = item.skin_indication || item["BIOTIPO / INDICACIÓN"] || item["BIOTIPO/INDICACION"] || item["BIOTIPO"];

      // Validate mandatory fields
      if (!rawId || !rawBrand || !rawName || !rawCategory) {
        continue; // skip rows missing critical primary identifiers
      }

      const id = String(rawId).trim();
      const brand = String(rawBrand).trim();
      const name = String(rawName).trim();
      const category = String(rawCategory).trim();
      const capacity = rawCapacity ? String(rawCapacity).trim() : null;
      const priceAesthetic = sanitizePrice(rawPriceAes);
      const pricePublic = sanitizePrice(rawPricePub);
      const activeIngredients = rawActives ? String(rawActives).trim() : null;
      const skinIndication = rawIndication ? String(rawIndication).trim() : null;

      // UPSERT statement (Universal PostgreSQL/SQLite conflict handler)
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
          id,
          brand,
          name,
          category,
          capacity,
          priceAesthetic,
          pricePublic,
          activeIngredients,
          skinIndication
        ]
      });

      count++;
    }

    if (insertStatements.length > 0) {
      await executeBatch(insertStatements);
    }

    return res.status(200).json({
      success: true,
      insertedCount: count,
      message: `Catálogo actualizado con éxito. Se procesaron e insertaron/actualizaron ${count} productos.`
    });

  } catch (error) {
    console.error('[API Upload Ingestion Error]:', error);
    return res.status(500).json({ error: error.message });
  }
}
