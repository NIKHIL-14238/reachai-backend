// ============================================================
// Campaign Routes - /api/campaigns
// ============================================================
// Handles campaign lifecycle:
// - GET /             → List all campaigns
// - GET /:id          → Get campaign with delivery stats
// - POST /            → Create a new campaign (draft)
// - POST /:id/send    → Send a campaign to its segment
// - GET /:id/logs     → Get individual message delivery logs
// ============================================================

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

// GET /api/campaigns - List all campaigns with stats
router.get('/', async (req, res) => {
  const db = req.app.get('db');
  try {
    const result = await db.query(`
      SELECT c.*, s.name as segment_name, s.customer_count as audience_size
      FROM campaigns c
      LEFT JOIN segments s ON c.segment_id = s.id
      ORDER BY c.created_at DESC
    `);
    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error('Error fetching campaigns:', err);
    res.status(500).json({ error: 'Failed to fetch campaigns' });
  }
});

// GET /api/campaigns/:id - Get single campaign with full stats
router.get('/:id', async (req, res) => {
  const db = req.app.get('db');
  try {
    const campaign = await db.query(
      `SELECT c.*, s.name as segment_name 
       FROM campaigns c 
       LEFT JOIN segments s ON c.segment_id = s.id 
       WHERE c.id = $1`,
      [req.params.id]
    );

    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Get status breakdown of all messages in this campaign
    const stats = await db.query(
      `SELECT status, COUNT(*) as count 
       FROM communication_logs 
       WHERE campaign_id = $1 
       GROUP BY status`,
      [req.params.id]
    );

    res.json({
      ...campaign.rows[0],
      delivery_stats: stats.rows,
    });
  } catch (err) {
    console.error('Error fetching campaign:', err);
    res.status(500).json({ error: 'Failed to fetch campaign' });
  }
});

// POST /api/campaigns - Create a new campaign (draft status)
router.post('/', async (req, res) => {
  const db = req.app.get('db');
  const { name, segment_id, channel, subject, message_template } = req.body;

  if (!name || !segment_id || !message_template) {
    return res.status(400).json({ error: 'name, segment_id, and message_template are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO campaigns (name, segment_id, channel, subject, message_template, status) 
       VALUES ($1, $2, $3, $4, $5, 'draft') RETURNING *`,
      [name, segment_id, channel || 'email', subject, message_template]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating campaign:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// POST /api/campaigns/:id/send - Actually send the campaign
// This is the key flow:
// 1. Get all customers in the campaign's segment
// 2. Create a communication_log entry for each customer
// 3. Send each message to the Channel Service
// 4. The Channel Service will callback with delivery status updates
router.post('/:id/send', async (req, res) => {
  const db = req.app.get('db');
  const campaignId = req.params.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Get campaign details
    const campaign = await client.query(
      'SELECT * FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (campaign.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const cam = campaign.rows[0];
    if (cam.status === 'sent' || cam.status === 'sending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Campaign already sent or in progress' });
    }

    // Get all customers in the campaign's segment
    const members = await client.query(
      `SELECT c.* FROM customers c
       JOIN segment_members sm ON c.id = sm.customer_id
       WHERE sm.segment_id = $1`,
      [cam.segment_id]
    );

    if (members.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Segment has no members' });
    }

    // Update campaign status to 'sending'
    await client.query(
      `UPDATE campaigns SET status = 'sending', sent_at = NOW(), total_sent = $1 WHERE id = $2`,
      [members.rows.length, campaignId]
    );

    // Create communication log entries and prepare messages for the channel service
    const messages = [];
    for (const customer of members.rows) {
      const externalId = uuidv4();
      
      // Personalize the message by replacing {{name}} placeholders
      const personalizedMessage = cam.message_template
        .replace(/\{\{name\}\}/gi, customer.name)
        .replace(/\{\{email\}\}/gi, customer.email)
        .replace(/\{\{city\}\}/gi, customer.city || '')
        .replace(/\{\{total_spent\}\}/gi, customer.total_spent || '0');

      // Determine recipient based on channel
      const recipient = cam.channel === 'email' ? customer.email 
        : cam.channel === 'sms' || cam.channel === 'whatsapp' ? customer.phone 
        : customer.email;

      // Create the communication log entry
      await client.query(
        `INSERT INTO communication_logs 
         (campaign_id, customer_id, channel, recipient, message, status, external_id, sent_at)
         VALUES ($1, $2, $3, $4, $5, 'sent', $6, NOW())`,
        [campaignId, customer.id, cam.channel, recipient, personalizedMessage, externalId]
      );

      messages.push({
        external_id: externalId,
        recipient,
        channel: cam.channel,
        message: personalizedMessage,
        subject: cam.subject,
        customer_name: customer.name,
      });
    }

    await client.query('COMMIT');

    // Send messages to the Channel Service asynchronously
    // We don't await this - it happens in the background
    const channelServiceUrl = process.env.CHANNEL_SERVICE_URL || 'http://localhost:4000';
    const callbackUrl = process.env.CRM_CALLBACK_URL || 'http://localhost:3000';

    // Fire-and-forget: send to channel service
    fetch(`${channelServiceUrl}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        campaign_id: campaignId,
        messages,
        callback_url: `${callbackUrl}/api/callbacks/status`,
      }),
    }).catch(err => {
      console.error('Error calling channel service:', err.message);
    });

    res.json({
      success: true,
      campaign_id: campaignId,
      messages_sent: messages.length,
      message: `Campaign is being sent to ${messages.length} recipients`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error sending campaign:', err);
    res.status(500).json({ error: 'Failed to send campaign' });
  } finally {
    client.release();
  }
});

// GET /api/campaigns/:id/logs - Get individual delivery logs
router.get('/:id/logs', async (req, res) => {
  const db = req.app.get('db');
  try {
    const result = await db.query(
      `SELECT cl.*, c.name as customer_name 
       FROM communication_logs cl
       JOIN customers c ON cl.customer_id = c.id
       WHERE cl.campaign_id = $1
       ORDER BY cl.created_at DESC`,
      [req.params.id]
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

module.exports = router;
