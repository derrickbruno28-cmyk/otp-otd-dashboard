const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, 'public');
const schemaPath = path.join(__dirname, 'db', 'schema.sql');

const shipmentColumns = [
  'ls_num',
  'load_id',
  'trip_num',
  'lane_miles',
  'truck_num',
  'primary_driver',
  'secondary_driver',
  'run_type',
  'load_type',
  'pu_appt',
  'pu_actual',
  'otp_status',
  'otp_fail_reason',
  'otp_notes',
  'del1_appt',
  'del1_actual',
  'del2_appt',
  'del2_actual',
  'otd_status',
  'otd_fail_reason',
  'otd_notes',
  'week_num',
  'month',
  'load_ref',
  'import_batch_id'
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(publicDir));

function sanitizeShipment(record = {}) {
  const shipment = {};
  for (const key of shipmentColumns) {
    shipment[key] = record[key] ?? null;
  }
  return shipment;
}

async function initDatabase() {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
}

async function getLatestImportBatch() {
  const batchResult = await pool.query(
    `select id, created_at, row_count
     from import_batches
     where rolled_back_at is null
     order by id desc
     limit 1`
  );
  const batch = batchResult.rows[0];
  if (!batch) return null;

  const idsResult = await pool.query(
    'select id from shipments where import_batch_id = $1 order by id asc',
    [batch.id]
  );

  return {
    id: Number(batch.id),
    createdAt: batch.created_at,
    rowCount: Number(batch.row_count || idsResult.rows.length),
    insertedIds: idsResult.rows.map((row) => Number(row.id))
  };
}

app.get('/api/shipments', async (_req, res) => {
  try {
    const result = await pool.query(
      `select id, ${shipmentColumns.join(', ')}
       from shipments
       order by id desc`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Failed to load shipments', error);
    res.status(500).json({ error: 'Failed to load shipments' });
  }
});

app.put('/api/shipments', async (req, res) => {
  const record = sanitizeShipment(req.body || {});

  try {
    if (req.body && req.body.id) {
      const values = shipmentColumns.map((column) => record[column]);
      const setClause = shipmentColumns.map((column, index) => `${column} = $${index + 1}`).join(', ');
      const result = await pool.query(
        `update shipments
         set ${setClause}, updated_at = now()
         where id = $${shipmentColumns.length + 1}
         returning id`,
        [...values, req.body.id]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: 'Shipment not found' });
      }

      return res.json({ id: Number(result.rows[0].id) });
    }

    const values = shipmentColumns.map((column) => record[column]);
    const placeholders = shipmentColumns.map((_, index) => `$${index + 1}`).join(', ');
    const result = await pool.query(
      `insert into shipments (${shipmentColumns.join(', ')})
       values (${placeholders})
       returning id`,
      values
    );

    return res.json({ id: Number(result.rows[0].id) });
  } catch (error) {
    console.error('Failed to save shipment', error);
    res.status(500).json({ error: 'Failed to save shipment' });
  }
});

app.delete('/api/shipments/:id', async (req, res) => {
  try {
    await pool.query('delete from shipments where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to delete shipment', error);
    res.status(500).json({ error: 'Failed to delete shipment' });
  }
});

app.post('/api/shipments/bulk', async (req, res) => {
  const records = Array.isArray(req.body?.records) ? req.body.records.map(sanitizeShipment) : [];
  if (!records.length) {
    return res.json({ insertedIds: [], batch: null });
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const batchResult = await client.query(
      'insert into import_batches (row_count) values (0) returning id, created_at'
    );
    const batchId = Number(batchResult.rows[0].id);
    const insertedIds = [];

    for (const record of records) {
      record.import_batch_id = batchId;
      const values = shipmentColumns.map((column) => record[column]);
      const placeholders = shipmentColumns.map((_, index) => `$${index + 1}`).join(', ');
      const insertResult = await client.query(
        `insert into shipments (${shipmentColumns.join(', ')})
         values (${placeholders})
         returning id`,
        values
      );
      insertedIds.push(Number(insertResult.rows[0].id));
    }

    await client.query(
      'update import_batches set row_count = $1 where id = $2',
      [insertedIds.length, batchId]
    );
    await client.query('commit');

    res.json({
      insertedIds,
      batch: {
        id: batchId,
        createdAt: batchResult.rows[0].created_at,
        rowCount: insertedIds.length,
        insertedIds
      }
    });
  } catch (error) {
    await client.query('rollback');
    console.error('Failed to bulk import shipments', error);
    res.status(500).json({ error: 'Failed to bulk import shipments' });
  } finally {
    client.release();
  }
});

app.get('/api/import-batches/latest', async (_req, res) => {
  try {
    res.json(await getLatestImportBatch());
  } catch (error) {
    console.error('Failed to load latest import batch', error);
    res.status(500).json({ error: 'Failed to load latest import batch' });
  }
});

app.post('/api/import-batches/:id/undo', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const deleteResult = await client.query(
      'delete from shipments where import_batch_id = $1 returning id',
      [req.params.id]
    );
    await client.query(
      'update import_batches set rolled_back_at = now() where id = $1',
      [req.params.id]
    );
    await client.query('commit');

    res.json({
      ok: true,
      rowCount: deleteResult.rowCount,
      deletedIds: deleteResult.rows.map((row) => Number(row.id))
    });
  } catch (error) {
    await client.query('rollback');
    console.error('Failed to undo import batch', error);
    res.status(500).json({ error: 'Failed to undo import batch' });
  } finally {
    client.release();
  }
});

app.delete('/api/shipments', async (_req, res) => {
  try {
    await pool.query('truncate table import_batch_items, import_batches, shipments restart identity cascade');
    res.json({ ok: true });
  } catch (error) {
    console.error('Failed to clear shipments', error);
    res.status(500).json({ error: 'Failed to clear shipments' });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

initDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`OTP/OTD dashboard running on port ${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize database', error);
    process.exit(1);
  });
