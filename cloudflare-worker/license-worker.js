export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Dermatique License API', { status: 200 });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/issue') {
        return await handleIssue(request, env, corsHeaders);
      }
      // /validate y la raíz "/" hacen lo mismo, para no romper al cliente actual
      return await handleValidate(request, env, corsHeaders);
    } catch (e) {
      return new Response(JSON.stringify({ valid: false, error: String(e && e.message || e) }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  }
};

// Tope de dispositivos distintos que pueden activar una misma licencia. Sin este límite, una sola
// clave se podía usar en cualquier cantidad de dispositivos (y compartirse sin control); con un tope
// de exactamente 1 se obligaría a comprar de nuevo por cada dispositivo legítimo del mismo cliente
// (celular + tablet + laptop). 3 cubre el uso normal de un mismo profesional sin abrir la puerta a
// reventa masiva de una sola clave.
const MAX_DEVICES_PER_LICENSE = 3;

// ---- Turso ----
function encodeValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'number') return Number.isInteger(v) ? { type: 'integer', value: String(v) } : { type: 'float', value: v };
  return { type: 'text', value: String(v) };
}

async function tursoQuery(env, sql, args = []) {
  const resp = await fetch(`${env.TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TURSO_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(encodeValue) } }, { type: 'close' }] })
  });
  const json = await resp.json();
  const result = json.results[0];
  if (result.type === 'error') throw new Error('Turso: ' + result.error.message);
  const execResult = result.response.result;
  const cols = execResult.cols.map(c => c.name);
  return execResult.rows.map(row => {
    const obj = {};
    row.forEach((val, idx) => { obj[cols[idx]] = val.type === 'null' ? null : val.value; });
    return obj;
  });
}

// ---- Dispositivos por licencia ----
async function ensureDeviceTable(env) {
  await tursoQuery(env, `CREATE TABLE IF NOT EXISTS license_devices (
    license_key TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (license_key, device_id)
  )`);
}

function sanitizeDeviceId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.length > 128) return '';
  return id;
}

// Registra el dispositivo contra la licencia si hay cupo. No es transaccional (SELECT + INSERT
// separados): para el volumen de esta app el riesgo de una carrera justo en el cupo #3 es aceptable,
// a cambio de no complicar el Worker con transacciones explícitas de Turso.
// Además de aceptar/rechazar, regresa cuántos dispositivos hay usados vs. el tope, para que el
// cliente pueda mostrarle al especialista "2 de 3 dispositivos" sin tener que adivinarlo.
async function registerDevice(env, licenseKey, deviceId) {
  if (!deviceId) return { ok: true }; // clientes viejos sin deviceId: no se bloquean, tampoco cuentan
  await ensureDeviceTable(env);
  const rows = await tursoQuery(env, `SELECT device_id FROM license_devices WHERE license_key = ?`, [licenseKey]);
  if (rows.some(r => r.device_id === deviceId)) {
    return { ok: true, used: rows.length, max: MAX_DEVICES_PER_LICENSE }; // ya activado antes aquí
  }
  if (rows.length >= MAX_DEVICES_PER_LICENSE) {
    return { ok: false, reason: 'device_limit', used: rows.length, max: MAX_DEVICES_PER_LICENSE };
  }
  await tursoQuery(env, `INSERT INTO license_devices (license_key, device_id) VALUES (?, ?)`, [licenseKey, deviceId]);
  return { ok: true, used: rows.length + 1, max: MAX_DEVICES_PER_LICENSE };
}

// ---- Validación de licencias ----
async function handleValidate(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ valid: false }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const key = (body.licenseKey || '').trim().toUpperCase();
  const deviceId = sanitizeDeviceId(body.deviceId);
  if (!key) {
    return new Response(JSON.stringify({ valid: false }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // La clave maestra del dueño no está sujeta al límite de dispositivos.
  if (env.MASTER_LICENSE_KEY && key === env.MASTER_LICENSE_KEY) {
    return new Response(JSON.stringify({ valid: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const rows = await tursoQuery(env, `SELECT status FROM licenses WHERE license_key = ?`, [key]);
  const licenseValid = rows.length > 0 && rows[0].status === 'active';
  if (!licenseValid) {
    return new Response(JSON.stringify({ valid: false }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const deviceCheck = await registerDevice(env, key, deviceId);
  const devices = deviceCheck.used != null ? { used: deviceCheck.used, max: deviceCheck.max } : undefined;
  if (!deviceCheck.ok) {
    return new Response(JSON.stringify({ valid: false, reason: deviceCheck.reason, devices }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ valid: true, devices }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

// ---- PayPal ----
async function getPayPalAccessToken(env) {
  const resp = await fetch('https://api-m.paypal.com/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('No se pudo autenticar con PayPal: ' + JSON.stringify(data));
  return data.access_token;
}

function generateLicenseKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = () => Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `DERM-${seg()}-${seg()}-${seg()}`;
}

// Emite una licencia real solo después de confirmar contra la API de PayPal que la orden existe
// y el pago se completó. Idempotente: si ya se emitió una licencia para esa orden, regresa la misma.
// El dispositivo que completa la compra se registra como el primero de los 3 disponibles.
async function handleIssue(request, env, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const orderId = (body.orderId || '').trim();
  const deviceId = sanitizeDeviceId(body.deviceId);
  if (!orderId) {
    return new Response(JSON.stringify({ error: 'missing_order_id' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const existing = await tursoQuery(env, `SELECT license_key FROM licenses WHERE paypal_order_id = ?`, [orderId]);
  if (existing.length > 0) {
    let devices;
    if (deviceId) {
      try {
        const dc = await registerDevice(env, existing[0].license_key, deviceId);
        devices = dc.used != null ? { used: dc.used, max: dc.max } : undefined;
      } catch (e) {}
    }
    return new Response(JSON.stringify({ licenseKey: existing[0].license_key, devices }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const accessToken = await getPayPalAccessToken(env);
  const orderResp = await fetch(`https://api-m.paypal.com/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const order = await orderResp.json();

  if (!orderResp.ok) {
    return new Response(JSON.stringify({ error: 'order_lookup_failed', detail: order }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (order.status !== 'COMPLETED' && order.status !== 'APPROVED') {
    return new Response(JSON.stringify({ error: 'payment_not_completed', status: order.status }), { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const licenseKey = generateLicenseKey();
  await tursoQuery(
    env,
    `INSERT INTO licenses (license_key, paypal_order_id, status, created_at) VALUES (?, ?, 'active', CURRENT_TIMESTAMP)`,
    [licenseKey, orderId]
  );

  let devices;
  if (deviceId) {
    try {
      const dc = await registerDevice(env, licenseKey, deviceId);
      devices = dc.used != null ? { used: dc.used, max: dc.max } : undefined;
    } catch (e) {}
  }

  return new Response(JSON.stringify({ licenseKey, devices }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
