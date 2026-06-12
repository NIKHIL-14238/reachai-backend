// ============================================================
// Callback Routes - /api/callbacks
// ============================================================
// This is the "receipt API" mentioned in the assignment.
// The Channel Service calls these endpoints to report what
// happened to each message: delivered, failed, opened, etc.
//
// Flow:
// 1. CRM sends message → Channel Service
// 2. Channel Service simulates delivery
// 3. Channel Service calls POST /api/callbacks/status
// 4. CRM updates communication_logs and campaign stats
// ============================================================

const express = require('express');
const router = express.Router();

// POST /api/callbacks/status - Receive a delivery status update
// Called by the Channel Service for each status change
router.post('/status', async (req, res) => {
  const db = req.app.get('db');
  const { external_id, status, timestamp, failure_reason } = req.body;

  if (!external_id || !status) {
    return res.status(400).json({ error: 'external_id and status are required' });
  }

  // Validate that the status is one we recognize
  const validStatuses = ['delivered', 'failed', 'opened', 'read', 'clicked'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Find the communication log by external_id
    const log = await client.query(
      'SELECT * FROM communication_logs WHERE external_id = $1',
      [external_id]
    );

    if (log.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Communication log not found' });
    }

    const entry = log.rows[0];

    // Step 2: Update the communication log with the new status
    // We track timestamps for each status separately
    const updateFields = { status };
    let timestampField = '';

    switch (status) {
      case 'delivered':
        timestampField = 'delivered_at';
        break;
      case 'failed':
        timestampField = 'failed_at';
        break;
      case 'opened':
        timestampField = 'opened_at';
        break;
      case 'read':
        // 'read' is treated similar to 'opened' for tracking
        timestampField = 'opened_at';
        break;
      case 'clicked':
        timestampField = 'clicked_at';
        break;
    }

    await client.query(
      `UPDATE communication_logs 
       SET status = $1, ${timestampField} = $2 ${status === 'failed' ? ', failure_reason = $4' : ''}
       WHERE external_id = $3`,
      status === 'failed' 
        ? [status, timestamp || new Date(), external_id, failure_reason]
        : [status, timestamp || new Date(), external_id]
    );

    // Step 3: Update the campaign's aggregate counters
    // This is a denormalization for performance - we keep running totals
    // on the campaign so we don't have to COUNT(*) every time.
    const campaignId = entry.campaign_id;
    const columnMap = {
      delivered: 'total_delivered',
      failed: 'total_failed',
      opened: 'total_opened',
      clicked: 'total_clicked',
    };

    if (columnMap[status]) {
      await client.query(
        `UPDATE campaigns SET ${columnMap[status]} = ${columnMap[status]} + 1 WHERE id = $1`,
        [campaignId]
      );
    }

    // If we got any terminal status, check if campaign is fully processed
    const remaining = await client.query(
      `SELECT COUNT(*) FROM communication_logs 
       WHERE campaign_id = $1 AND status = 'sent'`,
      [campaignId]
    );

    if (parseInt(remaining.rows[0].count) === 0) {
      await client.query(
        `UPDATE campaigns SET status = 'completed' WHERE id = $1 AND status = 'sending'`,
        [campaignId]
      );
    }

    await client.query('COMMIT');
    res.json({ success: true, status });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error processing callback:', err);
    res.status(500).json({ error: 'Failed to process callback' });
  } finally {
    client.release();
  }
});

// POST /api/callbacks/batch - Receive multiple status updates at once
// More efficient than individual calls
router.post('/batch', async (req, res) => {
  const db = req.app.get('db');
  const { updates } = req.body;

  if (!Array.isArray(updates)) {
    return res.status(400).json({ error: 'Provide an array of updates' });
  }

  let processed = 0;
  let failed = 0;

  for (const update of updates) {
    try {
      const { external_id, status, timestamp, failure_reason } = update;
      
      const log = await db.query(
        'SELECT campaign_id FROM communication_logs WHERE external_id = $1',
        [external_id]
      );

      if (log.rows.length === 0) {
        failed++;
        continue;
      }

      // Update the log
      const timestampField = status === 'delivered' ? 'delivered_at'
        : status === 'failed' ? 'failed_at'
        : status === 'opened' || status === 'read' ? 'opened_at'
        : status === 'clicked' ? 'clicked_at'
        : null;

      if (timestampField) {
        await db.query(
          `UPDATE communication_logs SET status = $1, ${timestampField} = $2 
           ${status === 'failed' ? ', failure_reason = $4' : ''}
           WHERE external_id = $3`,
          status === 'failed'
            ? [status, timestamp || new Date(), external_id, failure_reason]
            : [status, timestamp || new Date(), external_id]
        );
      }

      // Update campaign counters
      const columnMap = { delivered: 'total_delivered', failed: 'total_failed', opened: 'total_opened', clicked: 'total_clicked' };
      if (columnMap[status]) {
        await db.query(
          `UPDATE campaigns SET ${columnMap[status]} = ${columnMap[status]} + 1 WHERE id = $1`,
          [log.rows[0].campaign_id]
        );
      }

      processed++;
    } catch {
      failed++;
    }
  }

  res.json({ processed, failed, total: updates.length });
});

module.exports = router;
