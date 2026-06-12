// ============================================================
// Customer Routes - /api/customers
// ============================================================
// Handles all customer-related operations:
// - GET /          → List all customers (with search & pagination)
// - GET /:id       → Get single customer with their orders
// - POST /         → Create a new customer
// - POST /bulk     → Import multiple customers at once
// ============================================================

const express = require('express');
const router = express.Router();

// GET /api/customers - List customers with optional search & pagination
router.get('/', async (req, res) => {
  const db = req.app.get('db');
  // Query parameters for filtering
  const { search, page = 1, limit = 50, sort = 'created_at', order = 'DESC' } = req.query;
  const offset = (page - 1) * limit;

  try {
    let whereClause = '';
    const params = [];

    // If search term provided, filter by name, email, or city
    if (search) {
      params.push(`%${search}%`);
      whereClause = `WHERE name ILIKE $1 OR email ILIKE $1 OR city ILIKE $1`;
    }

    // Whitelist allowed sort columns to prevent SQL injection
    const allowedSorts = ['name', 'email', 'total_spent', 'order_count', 'created_at', 'last_order_date'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Get total count (for pagination info)
    const countResult = await db.query(
      `SELECT COUNT(*) FROM customers ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get the actual customers
    const paramOffset = params.length;
    const result = await db.query(
      `SELECT * FROM customers ${whereClause} 
       ORDER BY ${sortCol} ${sortOrder} 
       LIMIT $${paramOffset + 1} OFFSET $${paramOffset + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );

    res.json({
      customers: result.rows,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error('Error fetching customers:', err);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// GET /api/customers/:id - Get a single customer with their orders
router.get('/:id', async (req, res) => {
  const db = req.app.get('db');
  try {
    const customer = await db.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    if (customer.rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Also fetch their orders
    const orders = await db.query(
      'SELECT * FROM orders WHERE customer_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );

    // Also fetch their communication history
    const communications = await db.query(
      `SELECT cl.*, c.name as campaign_name 
       FROM communication_logs cl 
       LEFT JOIN campaigns c ON cl.campaign_id = c.id 
       WHERE cl.customer_id = $1 
       ORDER BY cl.created_at DESC LIMIT 20`,
      [req.params.id]
    );

    res.json({
      ...customer.rows[0],
      orders: orders.rows,
      communications: communications.rows,
    });
  } catch (err) {
    console.error('Error fetching customer:', err);
    res.status(500).json({ error: 'Failed to fetch customer' });
  }
});

// POST /api/customers - Create a single customer
router.post('/', async (req, res) => {
  const db = req.app.get('db');
  const { name, email, phone, city, age, gender } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  try {
    const result = await db.query(
      `INSERT INTO customers (name, email, phone, city, age, gender) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [name, email, phone, city, age, gender]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Customer with this email already exists' });
    }
    console.error('Error creating customer:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});

// POST /api/customers/bulk - Import multiple customers
router.post('/bulk', async (req, res) => {
  const db = req.app.get('db');
  const { customers } = req.body;

  if (!Array.isArray(customers) || customers.length === 0) {
    return res.status(400).json({ error: 'Provide an array of customers' });
  }

  const client = await db.connect();
  let imported = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');
    for (const c of customers) {
      try {
        await client.query(
          `INSERT INTO customers (name, email, phone, city, age, gender) 
           VALUES ($1, $2, $3, $4, $5, $6) 
           ON CONFLICT (email) DO NOTHING`,
          [c.name, c.email, c.phone, c.city, c.age, c.gender]
        );
        imported++;
      } catch {
        skipped++;
      }
    }
    await client.query('COMMIT');
    res.json({ imported, skipped, total: customers.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error bulk importing:', err);
    res.status(500).json({ error: 'Failed to import customers' });
  } finally {
    client.release();
  }
});

module.exports = router;
