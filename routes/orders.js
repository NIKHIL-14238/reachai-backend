// ============================================================
// Order Routes - /api/orders
// ============================================================
// Handles order-related operations:
// - GET /          → List orders (with filters)
// - POST /         → Create a new order
// - POST /bulk     → Import multiple orders
// ============================================================

const express = require('express');
const router = express.Router();

// GET /api/orders - List orders with optional filters
router.get('/', async (req, res) => {
  const db = req.app.get('db');
  const { customer_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  try {
    let whereClause = '';
    const params = [];

    if (customer_id) {
      params.push(customer_id);
      whereClause = `WHERE o.customer_id = $1`;
    }

    const paramOffset = params.length;
    const result = await db.query(
      `SELECT o.*, c.name as customer_name, c.email as customer_email
       FROM orders o
       JOIN customers c ON o.customer_id = c.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $${paramOffset + 1} OFFSET $${paramOffset + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM orders o ${whereClause}`,
      params
    );

    res.json({
      orders: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
      },
    });
  } catch (err) {
    console.error('Error fetching orders:', err);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// POST /api/orders - Create a single order
// Also updates the customer's total_spent, order_count, and last_order_date
router.post('/', async (req, res) => {
  const db = req.app.get('db');
  const { customer_id, order_number, amount, items, status, channel } = req.body;

  if (!customer_id || !order_number || !amount) {
    return res.status(400).json({ error: 'customer_id, order_number, and amount are required' });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Insert the order
    const result = await client.query(
      `INSERT INTO orders (customer_id, order_number, amount, items, status, channel) 
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [customer_id, order_number, amount, JSON.stringify(items || []), status || 'completed', channel || 'online']
    );

    // Update customer aggregates (total_spent, order_count, last_order_date)
    // This is a common pattern: keep computed summaries on the parent record
    // so we don't need expensive JOINs every time we list customers.
    await client.query(
      `UPDATE customers SET 
        total_spent = total_spent + $1, 
        order_count = order_count + 1,
        last_order_date = NOW()
       WHERE id = $2`,
      [amount, customer_id]
    );

    await client.query('COMMIT');
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Order number already exists' });
    }
    console.error('Error creating order:', err);
    res.status(500).json({ error: 'Failed to create order' });
  } finally {
    client.release();
  }
});

// POST /api/orders/bulk - Import multiple orders at once
router.post('/bulk', async (req, res) => {
  const db = req.app.get('db');
  const { orders } = req.body;

  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(400).json({ error: 'Provide an array of orders' });
  }

  const client = await db.connect();
  let imported = 0;

  try {
    await client.query('BEGIN');

    for (const o of orders) {
      try {
        await client.query(
          `INSERT INTO orders (customer_id, order_number, amount, items, status, channel, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (order_number) DO NOTHING`,
          [o.customer_id, o.order_number, o.amount, JSON.stringify(o.items || []),
           o.status || 'completed', o.channel || 'online', o.created_at || new Date()]
        );
        imported++;
      } catch { /* skip duplicates */ }
    }

    // Recalculate all customer aggregates after bulk import
    await client.query(`
      UPDATE customers c SET 
        total_spent = COALESCE(sub.total, 0),
        order_count = COALESCE(sub.cnt, 0),
        last_order_date = sub.last_date
      FROM (
        SELECT customer_id, SUM(amount) as total, COUNT(*) as cnt, MAX(created_at) as last_date
        FROM orders GROUP BY customer_id
      ) sub
      WHERE c.id = sub.customer_id
    `);

    await client.query('COMMIT');
    res.json({ imported, total: orders.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error bulk importing orders:', err);
    res.status(500).json({ error: 'Failed to import orders' });
  } finally {
    client.release();
  }
});

module.exports = router;
