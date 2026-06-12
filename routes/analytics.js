// ============================================================
// Analytics Routes - /api/analytics
// ============================================================
// Provides aggregated data for the dashboard:
// - GET /overview     → Key metrics (total customers, revenue, etc.)
// - GET /campaigns    → Campaign performance summary
// - GET /channels     → Performance breakdown by channel
// ============================================================

const express = require('express');
const router = express.Router();

// GET /api/analytics/overview - Dashboard overview metrics
router.get('/overview', async (req, res) => {
  const db = req.app.get('db');
  try {
    // Customer metrics
    const customerStats = await db.query(`
      SELECT 
        COUNT(*) as total_customers,
        COALESCE(SUM(total_spent), 0)::numeric as total_revenue,
        COALESCE(AVG(total_spent), 0)::integer as avg_customer_value,
        COUNT(CASE WHEN last_order_date > NOW() - INTERVAL '30 days' THEN 1 END) as active_customers,
        COUNT(CASE WHEN created_at > NOW() - INTERVAL '30 days' THEN 1 END) as new_customers_30d
      FROM customers
    `);

    // Order metrics
    const orderStats = await db.query(`
      SELECT 
        COUNT(*) as total_orders,
        COALESCE(AVG(amount), 0)::integer as avg_order_value
      FROM orders
    `);

    // Campaign metrics
    const campaignStats = await db.query(`
      SELECT 
        COUNT(*) as total_campaigns,
        COALESCE(SUM(total_sent), 0) as total_messages_sent,
        COALESCE(SUM(total_delivered), 0) as total_delivered,
        COALESCE(SUM(total_opened), 0) as total_opened,
        COALESCE(SUM(total_clicked), 0) as total_clicked,
        COALESCE(SUM(total_failed), 0) as total_failed
      FROM campaigns WHERE status IN ('sent', 'sending', 'completed')
    `);

    // Segment metrics
    const segmentStats = await db.query(`
      SELECT COUNT(*) as total_segments FROM segments
    `);

    // Revenue over last 6 months
    const revenueTimeline = await db.query(`
      SELECT 
        TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month,
        SUM(amount)::integer as revenue,
        COUNT(*) as orders
      FROM orders
      WHERE created_at > NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at)
    `);

    // Top cities by customer count
    const topCities = await db.query(`
      SELECT city, COUNT(*) as count, SUM(total_spent)::integer as revenue
      FROM customers
      WHERE city IS NOT NULL
      GROUP BY city
      ORDER BY count DESC
      LIMIT 5
    `);

    res.json({
      customers: customerStats.rows[0],
      orders: orderStats.rows[0],
      campaigns: campaignStats.rows[0],
      segments: segmentStats.rows[0],
      revenue_timeline: revenueTimeline.rows,
      top_cities: topCities.rows,
    });
  } catch (err) {
    console.error('Error fetching analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// GET /api/analytics/campaigns - Campaign performance comparison
router.get('/campaigns', async (req, res) => {
  const db = req.app.get('db');
  try {
    const result = await db.query(`
      SELECT 
        c.id, c.name, c.channel, c.status, c.sent_at,
        c.total_sent, c.total_delivered, c.total_failed, 
        c.total_opened, c.total_clicked,
        s.name as segment_name,
        CASE WHEN c.total_sent > 0 
          THEN ROUND(c.total_delivered::numeric / c.total_sent * 100, 1) 
          ELSE 0 END as delivery_rate,
        CASE WHEN c.total_delivered > 0 
          THEN ROUND(c.total_opened::numeric / c.total_delivered * 100, 1) 
          ELSE 0 END as open_rate,
        CASE WHEN c.total_opened > 0 
          THEN ROUND(c.total_clicked::numeric / c.total_opened * 100, 1) 
          ELSE 0 END as click_rate
      FROM campaigns c
      LEFT JOIN segments s ON c.segment_id = s.id
      WHERE c.status IN ('sent', 'sending', 'completed')
      ORDER BY c.sent_at DESC
    `);

    res.json({ campaigns: result.rows });
  } catch (err) {
    console.error('Error fetching campaign analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// GET /api/analytics/channels - Performance by channel
router.get('/channels', async (req, res) => {
  const db = req.app.get('db');
  try {
    const result = await db.query(`
      SELECT 
        channel,
        COUNT(*) as total_messages,
        COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status = 'opened' THEN 1 END) as opened,
        COUNT(CASE WHEN status = 'clicked' THEN 1 END) as clicked,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM communication_logs
      GROUP BY channel
    `);

    res.json({ channels: result.rows });
  } catch (err) {
    console.error('Error fetching channel analytics:', err);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
