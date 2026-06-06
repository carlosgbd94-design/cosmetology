const TURSO_URL = 'https://cosmetics-prodcts-carlos-becerra.aws-us-west-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODAyNTc5MzEsImlkIjoiMDE5ZTdmOWUtMmEwMS03OWMxLTg3N2YtN2RkY2FkZjg1ZDk5IiwicmlkIjoiM2VhNTAwMzUtMjIwZS00MWM2LWI3NjItNTM2NjQ1NzJhM2EzIn0.7-B8dPeRempyRbJBif_dZYDmoKizAwHz9F9RTv-WGNmpniIRicU3GkcENXOi2k0n1_rKfDuL69f1cLAOyeFnBg';

function decodeValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return Number(v.value);
  if (v.type === 'float') return Number(v.value);
  return v.value;
}

function decodeResultSet(result) {
  const columns = result.cols.map(c => c.name);
  return result.rows.map(row => {
    const obj = {};
    row.forEach((val, idx) => {
      obj[columns[idx]] = decodeValue(val);
    });
    return obj;
  });
}

async function run() {
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
          stmt: { sql: "SELECT * FROM productos_activos;" }
        },
        {
          type: "close"
        }
      ]
    })
  });
  const data = await response.json();
  const rows = decodeResultSet(data.results[0].response.result);
  console.log("Total rows in productos_activos:", rows.length);
  console.log("Distinct products: ", [...new Set(rows.map(r => r.producto))]);
  console.log("Distinct brands: ", [...new Set(rows.map(r => r.linea))]);
}

run();
