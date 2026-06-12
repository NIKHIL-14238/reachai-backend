// ============================================================
// AI Routes - /api/ai
// ============================================================
// This is the AI-native core of our CRM. It uses Claude to:
// 1. Convert natural language → SQL filter queries (segmentation)
// 2. Draft personalized campaign messages
// 3. Suggest campaign ideas based on customer data
//
// This is what makes our CRM "AI-native" - intelligence is woven
// into the product, not bolted on.
// ============================================================

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Helper: Call Claude API
async function callClaude(systemPrompt, userMessage) {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// POST /api/ai/segment - Convert natural language to a SQL filter
// Example: "Women in Mumbai who spent more than 5000" →
//   { filter: "gender = 'Female' AND city = 'Mumbai' AND total_spent > 5000" }
router.post('/segment', async (req, res) => {
  const db = req.app.get('db');
  const { query } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Query is required' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI service not configured. Set ANTHROPIC_API_KEY.' });
  }

  try {
    // First, get the schema info and some sample data to help Claude understand the data
    const sampleData = await db.query(
      `SELECT DISTINCT city FROM customers WHERE city IS NOT NULL LIMIT 20`
    );
    const cities = sampleData.rows.map(r => r.city);

    const stats = await db.query(`
      SELECT 
        MIN(total_spent) as min_spent, MAX(total_spent) as max_spent,
        MIN(order_count) as min_orders, MAX(order_count) as max_orders,
        MIN(age) as min_age, MAX(age) as max_age
      FROM customers
    `);

    const systemPrompt = `You are a SQL query assistant for a customer CRM database. 
Your job is to convert natural language descriptions of customer segments into SQL WHERE clauses.

The customers table has these columns:
- name (VARCHAR) - customer's full name
- email (VARCHAR) - email address
- phone (VARCHAR) - phone number
- city (VARCHAR) - city they live in. Available cities: ${cities.join(', ')}
- age (INTEGER) - age in years
- gender (VARCHAR) - 'Male', 'Female', or 'Other'
- total_spent (DECIMAL) - total amount spent across all orders (in INR/rupees)
- order_count (INTEGER) - number of orders placed
- last_order_date (TIMESTAMP) - when they last ordered
- created_at (TIMESTAMP) - when they became a customer

Data ranges: ${JSON.stringify(stats.rows[0])}
Current date reference: NOW()

RULES:
1. Return ONLY the WHERE clause content (no "WHERE" keyword, no "SELECT", no semicolons)
2. Use valid PostgreSQL syntax
3. Use single quotes for string literals
4. For date comparisons, use: last_order_date > NOW() - INTERVAL '30 days'
5. For "inactive" or "dormant", check last_order_date being old
6. For "high value" or "VIP", check total_spent being high or order_count being high
7. For "new customers", check created_at being recent
8. Be case-insensitive for city names using ILIKE

Return ONLY the SQL WHERE clause, nothing else. No explanation, no markdown.

Examples:
- "customers from Mumbai" → city ILIKE 'Mumbai'
- "women who spent more than 5000" → gender = 'Female' AND total_spent > 5000
- "inactive customers" → last_order_date < NOW() - INTERVAL '90 days'
- "young customers under 25 from Delhi" → age < 25 AND city ILIKE 'Delhi'
- "VIP customers with more than 10 orders" → order_count > 10`;

    const filterQuery = await callClaude(systemPrompt, query);

    // Clean up the response - remove any markdown formatting
    const cleanFilter = filterQuery
      .replace(/```sql/g, '')
      .replace(/```/g, '')
      .replace(/^WHERE\s+/i, '')
      .replace(/;$/g, '')
      .trim();

    // Validate by running it (just a SELECT COUNT)
    const preview = await db.query(
      `SELECT COUNT(*) as count FROM customers WHERE ${cleanFilter}`
    );

    // Also generate a human-friendly name for the segment
    const namePrompt = `Given this customer segment description: "${query}"
Generate a short, catchy segment name (3-5 words max). Return ONLY the name, nothing else.
Examples: "High-Value Mumbaikars", "Young Fashion Enthusiasts", "Dormant VIP Shoppers"`;

    const suggestedName = await callClaude('You generate short segment names.', namePrompt);

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

// POST /api/ai/message - Draft a campaign message using AI
router.post('/message', async (req, res) => {
  const { campaign_goal, segment_description, channel, brand_name, tone } = req.body;

  if (!campaign_goal) {
    return res.status(400).json({ error: 'campaign_goal is required' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI service not configured' });
  }

  try {
    const systemPrompt = `You are a marketing copywriter for ${brand_name || 'a D2C brand'}.
Write compelling, personalized campaign messages.

Rules:
1. Use {{name}} as a placeholder for the customer's name
2. Keep it concise and action-oriented
3. Match the channel's tone:
   - Email: Can be longer, include subject line
   - SMS: Under 160 characters
   - WhatsApp: Conversational, can use emojis sparingly
   - RCS: Rich, can suggest interactive elements
4. Tone: ${tone || 'friendly and professional'}
5. Always include a clear call-to-action

Return ONLY a JSON object with this structure (no markdown):
{
  "subject": "email subject line (only for email channel)",
  "message": "the message body with {{name}} placeholder"
}`;

    const userMessage = `Campaign goal: ${campaign_goal}
Target audience: ${segment_description || 'general customers'}
Channel: ${channel || 'email'}`;

    const response = await callClaude(systemPrompt, userMessage);
    
    // Parse the JSON response
    const cleanResponse = response.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanResponse);

    res.json(parsed);
  } catch (err) {
    console.error('AI message error:', err);
    res.status(500).json({ error: 'Failed to generate message', details: err.message });
  }
});

// POST /api/ai/suggest - Get AI-powered campaign suggestions
router.post('/suggest', async (req, res) => {
  const db = req.app.get('db');

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'AI service not configured' });
  }

  try {
    // Gather insights about the customer base
    const insights = await db.query(`
      SELECT 
        COUNT(*) as total_customers,
        AVG(total_spent)::integer as avg_spent,
        AVG(order_count)::integer as avg_orders,
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

    const systemPrompt = `You are an AI marketing strategist for a D2C brand's CRM.
Based on customer data insights, suggest 3 campaign ideas.

Return ONLY a JSON array (no markdown) with this structure:
[
  {
    "name": "Campaign Name",
    "goal": "What this campaign aims to achieve",
    "segment_query": "Natural language description of the target segment",
    "channel": "email|sms|whatsapp",
    "message_idea": "Brief description of what the message should say",
    "priority": "high|medium|low"
  }
]`;

    const userMessage = `Customer base insights:
${JSON.stringify(insights.rows[0], null, 2)}

Top cities: ${topCities.rows.map(r => `${r.city} (${r.count})`).join(', ')}

Suggest 3 smart campaign ideas based on this data.`;

    const response = await callClaude(systemPrompt, userMessage);
    const cleanResponse = response.replace(/```json/g, '').replace(/```/g, '').trim();
    const suggestions = JSON.parse(cleanResponse);

    res.json({ suggestions, insights: insights.rows[0] });
  } catch (err) {
    console.error('AI suggest error:', err);
    res.status(500).json({ error: 'Failed to generate suggestions', details: err.message });
  }
});

module.exports = router;
