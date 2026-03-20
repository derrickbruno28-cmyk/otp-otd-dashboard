const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { Pool } = require('pg');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const schemaPath = path.join(__dirname, 'db', 'schema.sql');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(publicDir));

const COL_ALIASES = {
  ls_num: ['ls #', 'ls#', 'ls number', 'load number', 'shipment number', 'ls_num'],
  load_id: ['load id', 'load_id', 'loadid', 'reference', 'load ref'],
  trip_num: ['trip #', 'trip#', 'trip_num', 'trip number', 'lane', 'route'],
  lane_miles: ['lane miles', 'miles', 'distance', 'mileage', 'lane_miles'],
  truck_num: ['truck #', 'truck#', 'truck_num', 'truck number', 'unit #', 'unit'],
  primary_driver: ['primary driver', 'driver', 'driver name', 'primary_driver'],
  secondary_driver: ['secondary driver', 'co-driver', 'team driver', 'secondary_driver'],
  run_type: ['run type', 'run_type', 'type', 'solo/team', 'team/solo'],
  load_type: ['load type', 'load_type', 'pre/live', 'live/pre'],
  pu_appt: ['pu appt', 'pickup appt', 'pickup appointment', 'pu appointment', 'pu_appt', 'pickup time'],
  pu_actual: ['pu actual', 'pickup actual', 'actual pickup', 'pu_actual'],
  otp_status: ['otp', 'otp status', 'otp_status', 'on time pickup'],
  otp_fail_reason: ['otp fail reason', 'otp fail', 'otp_fail_reason', 'otp reason'],
  otp_notes: ['otp notes', 'otp late notes', 'otp_notes'],
  del1_appt: ['del 1 appt', 'delivery 1 appt', 'del1 appt', 'delivery appt', 'del1_appt', 'delivery appointment'],
  del1_actual: ['del 1 actual', 'delivery 1 actual', 'del1 actual', 'delivery actual', 'del1_actual'],
  del2_appt: ['del 2 appt', 'delivery 2 appt', 'del2 appt', 'del2_appt'],
  del2_actual: ['del 2 actual', 'delivery 2 actual', 'del2 actual', 'del2_actual'],
  otd_status: ['otd', 'otd status', 'otd_status', 'on time delivery'],
  otd_fail_reason: ['otd fail reason', 'otd fail', 'otd_fail_reason', 'otd reason'],
  otd_notes: ['otd notes', 'otd late notes', 'otd_notes'],
  week_num: ['week #', 'week#', 'week', 'week_num', 'week number'],
  month: ['month', 'month year', 'period']
};

function normalizeRunType(value) {
  if (!value) return null;
  if (value.includes('Solo')) return 'Solo';
  if (value.includes('Team')) return 'Team';
  return value;
}

function normalizeStatus(value) {
  if (!value) return null;
  const str = String(value).trim();
  const lower = str.toLowerCase();
  if (str.includes('✓') || lower === 'yes' || lower === 'on time' || str === '1') return '✓';
  if (str.includes('✗') || lower === 'no' || lower === 'late' || str === '0') return '✗';
  if (lower.includes('pending')) return 'Pending';
  return null;
}

function normalizeDate(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str || str === 'null') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) return str.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(str)) return `${str.slice(0, 10)}T${str.slice(11, 16)}`;
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) return null;
  const pad = (num) => String(num).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

function calcOTPStatus(puAppt, puActual) {
  if (!puAppt || !puActual) return 'Pending';
  return new Date(puActual) <= new Date(puAppt) ? '✓' : '✗';
}

function calcOTDStatus(del1Appt, del1Actual, del2Appt, del2Actual) {
  const appt = del2Appt || del1Appt;
  const actual = del2Actual || del1Actual;
  if (!appt || !actual) return 'Pending';
  return new Date(actual) <= new Date(appt) ? '✓' : '✗';
}

function getWeekNum(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(d.getFullYear(), 0, 1);
  return Math.ceil(((d - start) / 86400000 + start.getDay() + 1) / 7);
}

function getMonth(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function buildSourceKey(record) {
  if (!record.ls_num && !record.load_id) return null;
  return `${record.ls_num || ''}|${record.load_id || ''}`;
}

function sanitizeRecord(input) {
  const puAppt = normalizeDate(input.pu_appt);
  const puActual = normalizeDate(input.pu_actual);
  const del1Appt = normalizeDate(input.del1_appt);
  const del1Actual = normalizeDate(input.del1_actual);
  const del2Appt = normalizeDate(input.del2_appt);
  const del2Actual = normalizeDate(input.del2_actual);
  const rawLsNum = input.ls_num == null ? null : String(input.ls_num).trim().replace(/\.0$/, '');
  const rawLoadId = input.load_id == null ? null : String(input.load_id).trim();
  const rawTripNum = input.trip_num == null ? null : String(input.trip_num).trim();
  const rawTruck = input.truck_num == null ? null : String(input.truck_num).split('->')[0].trim();
  const rawMiles = input.lane_miles == null ? null : parseFloat(String(input.lane_miles).replace(/[^\d.]/g, ''));
  const runType = normalizeRunType(input.run_type) || (input.secondary_driver ? 'Team' : 'Solo');
  const otpStatus = normalizeStatus(input.otp_status) || calcOTPStatus(puAppt, puActual);
  const otdStatus = normalizeStatus(input.otd_status) || calcOTDStatus(del1Appt, del1Actual, del2Appt, del2Actual);
  const record = {
    id: input.id ? Number(input.id) : undefined,
    ls_num: rawLsNum || null,
    load_id: rawLoadId || null,
    trip_num: rawTripNum || null,
    lane_miles: Number.isFinite(rawMiles) ? rawMiles : null,
    truck_num: rawTruck || null,
    primary_driver: input.primary_driver ? String(input.primary_driver).trim() : null,
    secondary_driver: input.secondary_driver ? String(input.secondary_driver).trim() : null,
    run_type: runType || null,
    load_type: input.load_type ? String(input.load_type).trim() : null,
    pu_appt: puAppt,
    pu_actual: puActual,
    otp_status: otpStatus || 'Pending',
    otp_fail_reason: input.otp_fail_reason ? String(input.otp_fail_reason).trim() : null,
    otp_notes: input.otp_notes ? String(input.otp_notes).trim() : null,
    del1_appt: del1Appt,
    del1_actual: del1Actual,
    del2_appt: del2Appt,
    del2_actual: del2Actual,
    otd_status: otdStatus || 'Pending',
    otd_fail_reason: input.otd_fail_reason ? String(input.otd_fail_reason).trim() : null,
    otd_notes: input.otd_notes ? String(input.otd_notes).trim() : null,
    week_num: input.week_num != null && input.week_num !== '' ? Number(input.week_num) : getWeekNum(puAppt),
    month: input.month ? String(input.month).trim() : getMonth(puAppt),
    load_ref: `${rawLsNum || ''} | ${rawLoadId || ''} | ${rawTripNum || ''}`.trim()
  };
  record.source_key = buildSourceKey(record);
  return record;
}

function mapColumns(headers) {
  const mapping = {};
  headers.forEach((header, index) => {
    if (!header) return;
    const normalized = String(header).toLowerCase().trim().replace(/\n/g, ' ');
    for (const [field, aliases] of Object.entries(COL_ALIASES)) {
      if (!mapping[field] && aliases.some((alias) => normalized.includes(alias) || alias.includes(normalized.split(' ')[0]))) {
        mapping[field] = index;
      }
    }
  });
  return mapping;
}

function detectFileFormat(headers) {
  const normalized = headers.map((header) => String(header || '').toLowerCase().trim());
  const hasLoad = normalized.some((value) => value === 'load');
  const hasPickup = normalized.some((value) => value === 'pickup');
  const hasRefConf = normalized.some((value) => value.includes('ref/conf') || value.includes('ref') || value.includes('conf'));
  const hasDriver1 = normalized.some((value) => value.includes('primarydriver') || value.includes('primary driver1'));
  if (hasLoad && hasPickup && (hasRefConf || hasDriver1)) return 'loads_export';
  return 'standard';
}

function parseLoadsExportRow(row, headers) {
  const headerMap = {};
  headers.forEach((header, index) => {
    headerMap[String(header || '').toLowerCase().trim()] = index;
  });
  const get = (key) => {
    const index = headerMap[key];
    return index !== undefined && row[index] != null ? String(row[index]).trim() : null;
  };
  const parseApptDate = (raw) => {
    if (!raw) return null;
    const firstPart = String(raw).split('-')[0].trim();
    return normalizeDate(firstPart);
  };
  const cleanDriver = (raw) => {
    if (!raw) return null;
    return raw.replace(/\s*\([^)]+\)\s*$/, '').trim() || null;
  };
  const tripRaw = get('pickup.1') || get('trips') || get('trip');
  const tripNum = tripRaw ? tripRaw.split(',')[0].trim() : null;
  const puAppt = parseApptDate(get('pickup'));
  return sanitizeRecord({
    ls_num: get('load'),
    load_id: get('ref/conf'),
    trip_num: tripNum,
    lane_miles: get('miles/units'),
    truck_num: get('truck1'),
    primary_driver: cleanDriver(get('primarydriver1') || get('primary driver1')),
    secondary_driver: cleanDriver(get('secondarydriver1') || get('secondary driver1')),
    run_type: cleanDriver(get('secondarydriver1') || get('secondary driver1')) ? 'Team' : 'Solo',
    load_type: 'Live Load',
    pu_appt: puAppt,
    del1_appt: parseApptDate(get('delivery')),
    otp_status: 'Pending',
    otp_fail_reason: get('late reason'),
    otp_notes: get('load notes'),
    otd_status: 'Pending',
    otd_fail_reason: get('late reason'),
    week_num: getWeekNum(puAppt),
    month: getMonth(puAppt)
  });
}

function parseCsv(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }
    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(current);
      if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
      row = [];
      current = '';
      continue;
    }
    current += char;
  }
  if (current || row.length) {
    row.push(current);
    if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
  }
  return rows.map((r) => r.map((cell) => String(cell).trim()));
}

function parseSheetBuffer(buffer, sourceName) {
  const isCsv = sourceName.toLowerCase().endsWith('.csv');
  let headers = [];
  let rows = [];
  if (isCsv) {
    const parsed = parseCsv(buffer.toString('utf8'));
    headers = parsed[0] || [];
    rows = parsed.slice(1);
  } else {
    const workbookText = XLSX.read(buffer, { type: 'buffer', raw: true });
    const workbookDates = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheetText = workbookText.Sheets[workbookText.SheetNames[0]];
    const sheetDates = workbookDates.Sheets[workbookDates.SheetNames[0]];
    const rawText = XLSX.utils.sheet_to_json(sheetText, { header: 1, defval: null, raw: true });
    const rawDates = XLSX.utils.sheet_to_json(sheetDates, { header: 1, defval: null, raw: false });
    let headerIndex = 0;
    for (let i = 0; i < Math.min(10, rawText.length); i += 1) {
      const nonEmpty = rawText[i].filter((cell) => cell != null && String(cell).trim() !== '').length;
      if (nonEmpty >= 3) {
        headerIndex = i;
        break;
      }
    }
    headers = (rawText[headerIndex] || []).map((header) => (header ? String(header) : ''));
    const formatCheck = detectFileFormat(headers);
    if (formatCheck === 'loads_export') {
      rows = rawText.slice(headerIndex + 1).filter((row) => row.some((cell) => cell != null && String(cell).trim() !== ''));
    } else {
      const lsColIndex = headers.findIndex((header) => /^ls\s*#/i.test(String(header).replace(/\n.*/, '')));
      const filterColumn = lsColIndex >= 0 ? lsColIndex : 0;
      rows = rawDates.slice(headerIndex + 1).filter((row) => row[filterColumn] != null && String(row[filterColumn]).trim() !== '');
    }
  }

  const format = detectFileFormat(headers);
  if (format === 'loads_export') {
    return rows.map((row) => parseLoadsExportRow(row, headers)).filter((record) => record.ls_num || record.load_id);
  }

  const mapping = mapColumns(headers);
  return rows.map((row) => {
    const get = (field) => {
      const index = mapping[field];
      return index !== undefined && row[index] != null ? String(row[index]).trim() : null;
    };
    return sanitizeRecord({
      ls_num: get('ls_num'),
      load_id: get('load_id'),
      trip_num: get('trip_num'),
      lane_miles: get('lane_miles'),
      truck_num: get('truck_num'),
      primary_driver: get('primary_driver'),
      secondary_driver: get('secondary_driver'),
      run_type: get('run_type'),
      load_type: get('load_type'),
      pu_appt: get('pu_appt'),
      pu_actual: get('pu_actual'),
      otp_status: get('otp_status'),
      otp_fail_reason: get('otp_fail_reason'),
      otp_notes: get('otp_notes'),
      del1_appt: get('del1_appt'),
      del1_actual: get('del1_actual'),
      del2_appt: get('del2_appt'),
      del2_actual: get('del2_actual'),
      otd_status: get('otd_status'),
      otd_fail_reason: get('otd_fail_reason'),
      otd_notes: get('otd_notes'),
      week_num: get('week_num'),
      month: get('month')
    });
  }).filter((record) => record.ls_num || record.load_id);
}

async function ensureSchema() {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schema);
}

async function queryShipments() {
  const result = await pool.query('select * from shipments order by id asc');
  return result.rows;
}

async function upsertShipment(client, input) {
  const record = sanitizeRecord(input);
  const values = [
    record.source_key,
    record.ls_num,
    record.load_id,
    record.trip_num,
    record.lane_miles,
    record.truck_num,
    record.primary_driver,
    record.secondary_driver,
    record.run_type,
    record.load_type,
    record.pu_appt,
    record.pu_actual,
    record.otp_status,
    record.otp_fail_reason,
    record.otp_notes,
    record.del1_appt,
    record.del1_actual,
    record.del2_appt,
    record.del2_actual,
    record.otd_status,
    record.otd_fail_reason,
    record.otd_notes,
    record.week_num,
    record.month,
    record.load_ref
  ];

  if (record.id) {
    const updateValues = [...values, record.id];
    const result = await client.query(
      `update shipments
       set source_key = $1, ls_num = $2, load_id = $3, trip_num = $4, lane_miles = $5, truck_num = $6,
           primary_driver = $7, secondary_driver = $8, run_type = $9, load_type = $10, pu_appt = $11,
           pu_actual = $12, otp_status = $13, otp_fail_reason = $14, otp_notes = $15, del1_appt = $16,
           del1_actual = $17, del2_appt = $18, del2_actual = $19, otd_status = $20, otd_fail_reason = $21,
           otd_notes = $22, week_num = $23, month = $24, load_ref = $25, updated_at = now()
       where id = $26
       returning *`,
      updateValues
    );
    return result.rows[0];
  }

  const result = await client.query(
    `insert into shipments (
      source_key, ls_num, load_id, trip_num, lane_miles, truck_num, primary_driver, secondary_driver,
      run_type, load_type, pu_appt, pu_actual, otp_status, otp_fail_reason, otp_notes, del1_appt,
      del1_actual, del2_appt, del2_actual, otd_status, otd_fail_reason, otd_notes, week_num, month, load_ref
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
    )
    on conflict (source_key) do update set
      ls_num = excluded.ls_num,
      load_id = excluded.load_id,
      trip_num = excluded.trip_num,
      lane_miles = excluded.lane_miles,
      truck_num = excluded.truck_num,
      primary_driver = excluded.primary_driver,
      secondary_driver = excluded.secondary_driver,
      run_type = excluded.run_type,
      load_type = excluded.load_type,
      pu_appt = excluded.pu_appt,
      pu_actual = excluded.pu_actual,
      otp_status = excluded.otp_status,
      otp_fail_reason = excluded.otp_fail_reason,
      otp_notes = excluded.otp_notes,
      del1_appt = excluded.del1_appt,
      del1_actual = excluded.del1_actual,
      del2_appt = excluded.del2_appt,
      del2_actual = excluded.del2_actual,
      otd_status = excluded.otd_status,
      otd_fail_reason = excluded.otd_fail_reason,
      otd_notes = excluded.otd_notes,
      week_num = excluded.week_num,
      month = excluded.month,
      load_ref = excluded.load_ref,
      updated_at = now()
    returning *`,
    values
  );
  return result.rows[0];
}

async function syncSheet() {
  if (!process.env.SHEET_URL) {
    return { skipped: true, reason: 'SHEET_URL not configured' };
  }
  const response = await fetch(process.env.SHEET_URL);
  if (!response.ok) {
    throw new Error(`Sheet download failed with ${response.status}`);
  }
  const urlPath = new URL(process.env.SHEET_URL).pathname;
  const sourceName = path.basename(urlPath) || 'sheet.xlsx';
  const buffer = Buffer.from(await response.arrayBuffer());
  const records = parseSheetBuffer(buffer, sourceName);
  const client = await pool.connect();
  try {
    await client.query('begin');
    let count = 0;
    for (const record of records) {
      await upsertShipment(client, record);
      count += 1;
    }
    await client.query('commit');
    return { insertedOrUpdated: count };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/api/health', async (_req, res, next) => {
  try {
    const db = await pool.query('select now() as now');
    res.json({ ok: true, now: db.rows[0].now });
  } catch (error) {
    next(error);
  }
});

app.get('/api/shipments', async (_req, res, next) => {
  try {
    res.json(await queryShipments());
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const record = await upsertShipment(client, req.body);
    res.status(201).json(record);
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.put('/api/shipments/:id', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const record = await upsertShipment(client, { ...req.body, id: Number(req.params.id) });
    res.json(record);
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
});

app.delete('/api/shipments/:id', async (req, res, next) => {
  try {
    await pool.query('delete from shipments where id = $1', [Number(req.params.id)]);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/shipments/bulk', async (req, res, next) => {
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  const client = await pool.connect();
  try {
    await client.query('begin');
    let count = 0;
    for (const record of records) {
      await upsertShipment(client, record);
      count += 1;
    }
    await client.query('commit');
    res.status(201).json({ insertedOrUpdated: count });
  } catch (error) {
    await client.query('rollback');
    next(error);
  } finally {
    client.release();
  }
});

app.delete('/api/shipments', async (_req, res, next) => {
  try {
    await pool.query('truncate table shipments restart identity');
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/sync-sheet', async (_req, res, next) => {
  try {
    res.json(await syncSheet());
  } catch (error) {
    next(error);
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: error.message || 'Internal server error' });
});

async function start() {
  await ensureSchema();
  app.listen(port, () => {
    console.log(`OTP/OTD dashboard listening on http://localhost:${port}`);
  });
  const cronSchedule = process.env.CRON_SCHEDULE || '0 * * * *';
  cron.schedule(cronSchedule, async () => {
    try {
      const result = await syncSheet();
      console.log('Sheet sync finished:', result);
    } catch (error) {
      console.error('Sheet sync failed:', error.message);
    }
  }, { timezone: process.env.TZ || 'America/Chicago' });
}

start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});
