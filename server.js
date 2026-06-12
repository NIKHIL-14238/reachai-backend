// ============================================================
// ReachAI CRM Backend - Main Server
// ============================================================
// This is the entry point for our CRM backend.
// It sets up Express, connects to PostgreSQL, creates tables,
// and mounts all our API routes.
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ----- Middleware -----
// CORS: Allows our React frontend (on a different domain) to call this API
app.use(cors());
// Parse JSON request bodies (so we can read req.body)
app.use(express.json({ limit: '10mb' }));

// ----- Database Connection -----
// We use PostgreSQL via a connection pool.
// A "pool" keeps multiple connections open and reuses them (efficient!).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Make the database pool available to all route handlers
app.set('db', pool);

// ----- Create Tables -----
// This runs on server startup and creates tables if they don't exist.
// In production, you'd use a migration tool, but this is fine for our scope.
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Customers table: stores shopper information
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        phone VARCHAR(50),
        city VARCHAR(100),
        age INTEGER,
        gender VARCHAR(20),
        total_spent DECIMAL(12,2) DEFAULT 0,
        order_count INTEGER DEFAULT 0,
        last_order_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Orders table: stores purchase history
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        order_number VARCHAR(50) UNIQUE NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        items JSONB DEFAULT '[]',
        status VARCHAR(50) DEFAULT 'completed',
        channel VARCHAR(50) DEFAULT 'online',
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Segments table: audience groups created by marketer or AI
      CREATE TABLE IF NOT EXISTS segments (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        filter_query TEXT,
        natural_language_query TEXT,
        customer_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Segment members: which customers belong to which segment
      CREATE TABLE IF NOT EXISTS segment_members (
        segment_id INTEGER REFERENCES segments(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        PRIMARY KEY (segment_id, customer_id)
      );

      -- Campaigns table: marketing campaigns
      CREATE TABLE IF NOT EXISTS campaigns (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        segment_id INTEGER REFERENCES segments(id),
        channel VARCHAR(50) NOT NULL DEFAULT 'email',
        subject VARCHAR(500),
        message_template TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'draft',
        total_sent INTEGER DEFAULT 0,
        total_delivered INTEGER DEFAULT 0,
        total_failed INTEGER DEFAULT 0,
        total_opened INTEGER DEFAULT 0,
        total_clicked INTEGER DEFAULT 0,
        scheduled_at TIMESTAMP,
        sent_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Communication logs: individual message tracking
      CREATE TABLE IF NOT EXISTS communication_logs (
        id SERIAL PRIMARY KEY,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        channel VARCHAR(50) NOT NULL,
        recipient VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'queued',
        external_id VARCHAR(255),
        sent_at TIMESTAMP,
        delivered_at TIMESTAMP,
        opened_at TIMESTAMP,
        clicked_at TIMESTAMP,
        failed_at TIMESTAMP,
        failure_reason TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Create indexes for faster queries
      CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
      CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(created_at);
      CREATE INDEX IF NOT EXISTS idx_comm_campaign ON communication_logs(campaign_id);
      CREATE INDEX IF NOT EXISTS idx_comm_status ON communication_logs(status);
      CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
    `);
    console.log('✅ Database tables initialized successfully');
  } catch (err) {
    console.error('❌ Error initializing database:', err.message);
  } finally {
    client.release();
  }
}

// ----- Mount Routes -----
// Each file in /routes handles a different part of the API
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');
const segmentRoutes = require('./routes/segments');
const campaignRoutes = require('./routes/campaigns');
const analyticsRoutes = require('./routes/analytics');
const aiRoutes = require('./routes/ai');
const callbackRoutes = require('./routes/callbacks');

app.use('/api/customers', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/segments', segmentRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/callbacks', callbackRoutes);

// Health check endpoint (useful for deployment platforms)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'reachai-crm-backend' });
});

// ----- Start Server -----
async function start() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`🚀 ReachAI CRM Backend running on port ${PORT}`);
  });
}

start();
