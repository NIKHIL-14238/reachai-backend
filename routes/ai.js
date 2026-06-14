const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

async function callAI(prompt) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'mistralai/mistral-7b-instruct:free',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

router.post('/segment', async (req, res) => {
  const db = req.app.get('db');
  const { query } = req.body;

  if (!query) return res.status(400).json({ error: 'Query is required' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service not configured. Set OPENROUTER_API_KEY.' });

  try {
    const sampleCities = await db.query(
      `SELECT DISTINCT city FROM customers WHERE city IS NOT NULL LIMIT 20`
    );
    const cities = sampleCities.rows.map(r => r.city);

    const stats = await db.query(`
      SELECT 
        MIN(total_spent) as min_spent, MAX(total_spent) as max_spent,
        MIN(age) as min_age, MAX(age) as max_age
      FROM customers
    `);

    const prompt = `You are a SQL query assistant. Convert this natural language description into a PostgreSQL WHERE clause.

Customers table columns:
- name (VARCHAR)
- email (VARCHAR)
- city (VARCHAR) — available cities: ${cities.join(', ')}
- age (INTEGER)
- gender (VARCHAR) — values: 'Male', 'Female', 'Other'
- total_spent (DECIMAL) — total money spent in INR
- order_count (INTEGER) — number of orders
- last_order_date (TIMESTAMP)
- created_at (TIMESTAMP)

RULES:
- Return ONLY the WHERE clause content, nothing else
- No WHERE keyword, no SELECT, no semicolon, no markdown, no explanation
- Use valid PostgreSQL syntax with single quotes for strings
- For dates: last_order_date > NOW() - INTERVAL '30 days'
- For city: city ILIKE 'Mumbai'
- For inactive: last_order_date < NOW() - INTERVAL '90 days'

Examples:
"customers from Mumbai" → city ILIKE 'Mumbai'
"women who spent more than 5000" → gender = 'Female' AND total_spent > 5000
"inactive customers" → last_order_date < NOW() - INTERVAL '90 days'
"VIP customers" → order_count > 5 AND total_spent > 10000

User request: "${query}"

Return ONLY the SQL WHERE clause, nothing else:`;

    const filterQuery = await callAI(prompt);

    const cleanFilter = filterQuery
      .replace(/```sql/gi, '')
      .replace(/```/g, '')
      .replace(/^WHERE\s+/i, '')
      .replace(/;$/g, '')
      .trim();

    const preview = await db.query(
      `SELECT COUNT(*) as count FROM customers WHERE ${cleanFilter}`
    );

    const namePrompt = `Generate a short segment name (3-5 words) for: "${query}"
Examples: "High-Value Mumbaikars", "Dormant VIP Shoppers"
Return ONLY the name, nothing else:`;

    const suggestedName = await callAI(namePrompt);

    res.json({
      filter_query: cleanFilter,
      suggested_name: suggestedName.trim().replace(/"/g, ''),
      customer_count: parseInt(preview.rows[0].count),
      original_query: query,
    });
  } catch (err) {
    console.error('AI segment error:', err);
    res.status(500).json({ error: 'Failed to generate segment', details: err.message });
  }
});

router.post('/message', async (req, res) => {
  const { campaign_goal, segment_description, channel, brand_name, tone } = req.body;

  if (!campaign_goal) return res.status(400).json({ error: 'campaign_goal is required' });
  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service not configured' });

  try {
    const prompt = `You are a marketing copywriter for ${brand_name || 'a D2C fashion brand'}.
Write a campaign message.

Goal: ${campaign_goal}
Audience: ${segment_description || 'general customers'}
Channel: ${channel || 'email'}
Tone: ${tone || 'friendly and professional'}

Rules:
- Use {{name}} as placeholder for customer name
- Clear call-to-action
- For SMS: under 160 characters
- For WhatsApp: conversational, 1-2 emojis ok
- For email: include subject line

Return ONLY this exact JSON format, no markdown:
{"subject": "subject line here", "message": "message body with {{name}}"}`;

    const response = await callAI(prompt);
    const cleanResponse = response.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanResponse);
    res.json(parsed);
  } catch (err) {
    console.error('AI message error:', err);
    res.status(500).json({ error: 'Failed to generate message', details: err.message });
  }
});

router.post('/suggest', async (req, res) => {
  const db = req.app.get('db');

  if (!OPENROUTER_API_KEY) return res.status(500).json({ error: 'AI service not configured' });

  try {
    const insights = await db.query(`
      SELECT 
        COUNT(*) as total_customers,
        AVG(total_spent)::integer as avg_spent,
        COUNT(CASE WHEN last_order_date > NOW() - INTERVAL '30 days' THEN 1 END) as active_30d,
        COUNT(CASE WHEN last_order_date < NOW() - INTERVAL '90 days' THEN 1 END) as dormant_90d,
        COUNT(CASE WHEN order_count = 1 THEN 1 END) as one_time_buyers,
        COUNT(CASE WHEN total_spent > 10000 THEN 1 END) as high_value
      FROM customers
    `);

    const topCities = await db.query(`
      SELECT city, COUNT(*) as count FROM customers 
      WHERE city IS NOT NULL GROUP BY city ORDER BY count DESC LIMIT 5
    `);

    const prompt = `You are an AI marketing strategist for a D2C fashion brand.

Customer data:
- Total customers: ${insights.rows[0].total_customers}
- Average spend: Rs.${insights.rows[0].avg_spent}
- Active in last 30 days: ${insights.rows[0].active_30d}
- Dormant 90+ days: ${insights.rows[0].dormant_90d}
- One-time buyers: ${insights.rows[0].one_time_buyers}
- High value (Rs.10k+): ${insights.rows[0].high_value}
- Top cities: ${topCities.rows.map(r => r.city).join(', ')}

Suggest 3 campaign ideas. Return ONLY this JSON array, no markdown:
[{"name":"Campaign Name","goal":"What this achieves","segment_query":"audience description","channel":"email or sms or whatsapp","message_idea":"brief concept","priority":"high or medium or low"}]`;

    const response = await callAI(prompt);
    const cleanResponse = response.replace(/```json/gi, '').replace(/```/g, '').trim();
    const suggestions = JSON.parse(cleanResponse);

    res.json({ suggestions, insights: insights.rows[0] });
  } catch (err) {
    console.error('AI suggest error:', err);
    res.status(500).json({ error: 'Failed to generate suggestions', details: err.message });
  }
});

module.exports = router;
