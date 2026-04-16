const { google } = require('googleapis');

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Normaliza strings para comparación flexible (sin tildes, minúsculas, sin espacios extra)
function norm(str) {
  return (str || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function rowMatches(row, nombre, vehiculo) {
  const n = norm(row[1]);
  const v = norm(row[3]);
  const qn = norm(nombre);
  const qv = vehiculo ? norm(vehiculo) : null;
  const nombreOk = n.includes(qn) || qn.includes(n);
  const vehiculoOk = !qv || v.includes(qv) || qv.includes(v);
  return nombreOk && vehiculoOk;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Solo POST' });

  const { action, nombre, vehiculo, fecha_hora } = req.body || {};

  if (!action || !nombre) {
    return res.status(400).json({ error: 'Faltan datos: action y nombre son requeridos' });
  }

  try {
    const auth = getAuth();
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const RANGE = 'Hoja 1!A:F';

    // Leer todas las filas
    // Columnas: A=timestamp, B=nombre, C=celular, D=vehiculo, E=fecha_hora, F=servicio
    const getRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: RANGE });
    const rows = getRes.data.values || [];

    const matches = [];
    for (let i = 0; i < rows.length; i++) {
      if (rowMatches(rows[i], nombre, vehiculo)) {
        matches.push({ rowIndex: i, row: rows[i] });
      }
    }

    // ── BUSCAR ────────────────────────────────────────────────────────────
    if (action === 'buscar') {
      if (matches.length === 0) {
        return res.json({ found: false, message: 'No encontré ningún turno registrado con esos datos.' });
      }
      return res.json({
        found: true,
        turnos: matches.map(m => ({
          nombre:    m.row[1] || '',
          celular:   m.row[2] || '',
          vehiculo:  m.row[3] || '',
          fecha_hora: m.row[4] || '',
          servicio:  m.row[5] || '',
        })),
      });
    }

    // ── CANCELAR ──────────────────────────────────────────────────────────
    if (action === 'cancelar') {
      if (matches.length === 0) {
        return res.json({ success: false, message: 'No encontré el turno para cancelar.' });
      }

      // Si hay múltiples matches y se pasó fecha_hora, afinar la búsqueda
      let target = matches[matches.length - 1]; // por defecto el más reciente
      if (fecha_hora && matches.length > 1) {
        const qfh = norm(fecha_hora);
        const refined = matches.find(m => norm(m.row[4]).includes(qfh) || qfh.includes(norm(m.row[4])));
        if (refined) target = refined;
      }

      // Obtener el sheetId real de la pestaña (necesario para deleteDimension)
      const spRes = await sheets.spreadsheets.get({ spreadsheetId });
      const sheet = spRes.data.sheets.find(s => s.properties.title === 'Hoja 1');
      const sheetId = sheet?.properties?.sheetId ?? 0;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{
            deleteDimension: {
              range: {
                sheetId,
                dimension: 'ROWS',
                startIndex: target.rowIndex,
                endIndex: target.rowIndex + 1,
              },
            },
          }],
        },
      });

      return res.json({
        success: true,
        cancelado: {
          nombre:    target.row[1] || '',
          vehiculo:  target.row[3] || '',
          fecha_hora: target.row[4] || '',
          servicio:  target.row[5] || '',
        },
        message: `Turno cancelado correctamente.`,
      });
    }

    return res.status(400).json({ error: 'action inválida. Usá "buscar" o "cancelar".' });

  } catch (e) {
    console.error('Error en sheets-cancel:', e);
    res.status(500).json({ error: 'Error del servidor: ' + e.message });
  }
};
