// ============================================================
// Seed Script - Generates realistic demo data
// ============================================================
// Run with: npm run seed
// This creates ~200 customers and ~500 orders for a fictional
// Indian fashion D2C brand called "StyleVerse".
// ============================================================

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// Indian first names
const firstNames = {
  Male: ['Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan',
    'Rohan', 'Kartik', 'Shaurya', 'Advait', 'Dhruv', 'Kabir', 'Ravi', 'Nikhil', 'Pranav', 'Yash',
    'Manish', 'Deepak', 'Suresh', 'Rajesh', 'Amit', 'Rahul', 'Vikram', 'Anand', 'Mohit', 'Gaurav'],
  Female: ['Ananya', 'Diya', 'Aditi', 'Myra', 'Sara', 'Aadhya', 'Isha', 'Kiara', 'Riya', 'Priya',
    'Sneha', 'Pooja', 'Neha', 'Kavya', 'Tara', 'Meera', 'Simran', 'Anjali', 'Nisha', 'Divya',
    'Sunita', 'Rekha', 'Pallavi', 'Shreya', 'Tanvi', 'Aisha', 'Zara', 'Fatima', 'Ruhi', 'Ira'],
};

const lastNames = ['Sharma', 'Patel', 'Gupta', 'Singh', 'Kumar', 'Verma', 'Joshi', 'Reddy', 'Nair', 'Iyer',
  'Kapoor', 'Malhotra', 'Chopra', 'Banerjee', 'Mukherjee', 'Das', 'Pillai', 'Menon', 'Rao', 'Shetty',
  'Deshmukh', 'Patil', 'Mishra', 'Pandey', 'Tiwari', 'Chauhan', 'Saxena', 'Agarwal', 'Mehta', 'Shah'];

const cities = ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Pune', 'Kolkata', 'Jaipur',
  'Ahmedabad', 'Lucknow', 'Chandigarh', 'Kochi', 'Indore', 'Noida', 'Gurgaon'];

// Fashion product catalog
const products = [
  { name: 'Classic Cotton T-Shirt', category: 'Tops', price: 799 },
  { name: 'Slim Fit Jeans', category: 'Bottoms', price: 1499 },
  { name: 'Linen Shirt', category: 'Tops', price: 1299 },
  { name: 'Kurta Set', category: 'Ethnic', price: 2199 },
  { name: 'Sneakers', category: 'Footwear', price: 2999 },
  { name: 'Printed Dress', category: 'Dresses', price: 1899 },
  { name: 'Denim Jacket', category: 'Outerwear', price: 3499 },
  { name: 'Chino Pants', category: 'Bottoms', price: 1799 },
  { name: 'Polo T-Shirt', category: 'Tops', price: 999 },
  { name: 'Leather Belt', category: 'Accessories', price: 899 },
  { name: 'Sunglasses', category: 'Accessories', price: 1599 },
  { name: 'Silk Saree', category: 'Ethnic', price: 4999 },
  { name: 'Hoodie', category: 'Outerwear', price: 1999 },
  { name: 'Joggers', category: 'Bottoms', price: 1299 },
  { name: 'Crop Top', category: 'Tops', price: 699 },
  { name: 'Formal Blazer', category: 'Outerwear', price: 4499 },
  { name: 'Palazzo Pants', category: 'Bottoms', price: 1099 },
  { name: 'Canvas Backpack', category: 'Accessories', price: 1899 },
  { name: 'Leather Watch', category: 'Accessories', price: 3299 },
  { name: 'Running Shoes', category: 'Footwear', price: 3999 },
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - Math.floor(Math.random() * daysBack));
  d.setHours(randomBetween(8, 22), randomBetween(0, 59));
  return d;
}

async function seed() {
  const client = await pool.connect();
  console.log('🌱 Starting seed...');

  try {
    await client.query('BEGIN');

    // Clear existing data
    await client.query('DELETE FROM communication_logs');
    await client.query('DELETE FROM segment_members');
    await client.query('DELETE FROM campaigns');
    await client.query('DELETE FROM segments');
    await client.query('DELETE FROM orders');
    await client.query('DELETE FROM customers');

    console.log('🗑️  Cleared existing data');

    // Generate 200 customers
    const customerIds = [];
    for (let i = 0; i < 200; i++) {
      const gender = Math.random() > 0.45 ? 'Female' : 'Male';
      const firstName = randomFrom(firstNames[gender]);
      const lastName = randomFrom(lastNames);
      const name = `${firstName} ${lastName}`;
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${randomBetween(1, 99)}@${randomFrom(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com'])}`;
      const phone = `+91${randomBetween(70000, 99999)}${randomBetween(10000, 99999)}`;
      const city = randomFrom(cities);
      const age = randomBetween(18, 55);
      const createdAt = randomDate(365);

      const result = await client.query(
        `INSERT INTO customers (name, email, phone, city, age, gender, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [name, email, phone, city, age, gender, createdAt]
      );
      customerIds.push(result.rows[0].id);
    }
    console.log(`👥 Created ${customerIds.length} customers`);

    // Generate 500+ orders spread across customers
    // Some customers buy a lot (VIP), some buy once (one-time), some never (leads)
    let orderCount = 0;
    for (const customerId of customerIds) {
      // Vary order frequency: 30% get 0 orders, 40% get 1-2, 20% get 3-5, 10% get 5-10
      const roll = Math.random();
      let numOrders;
      if (roll < 0.15) numOrders = 0;       // leads / no orders
      else if (roll < 0.55) numOrders = randomBetween(1, 2);  // casual
      else if (roll < 0.85) numOrders = randomBetween(3, 5);  // regular
      else numOrders = randomBetween(6, 12);                   // VIP

      for (let j = 0; j < numOrders; j++) {
        // Pick 1-4 random items
        const numItems = randomBetween(1, 4);
        const items = [];
        let totalAmount = 0;

        for (let k = 0; k < numItems; k++) {
          const product = randomFrom(products);
          const qty = randomBetween(1, 2);
          items.push({ name: product.name, category: product.category, price: product.price, quantity: qty });
          totalAmount += product.price * qty;
        }

        const orderNumber = `SV-${Date.now()}-${orderCount}`;
        const orderDate = randomDate(300);
        const channel = randomFrom(['online', 'online', 'online', 'app', 'app', 'store']);

        await client.query(
          `INSERT INTO orders (customer_id, order_number, amount, items, status, channel, created_at) 
           VALUES ($1, $2, $3, $4, 'completed', $5, $6)`,
          [customerId, orderNumber, totalAmount, JSON.stringify(items), channel, orderDate]
        );
        orderCount++;
      }
    }
    console.log(`📦 Created ${orderCount} orders`);

    // Update customer aggregates
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
    console.log('📊 Updated customer aggregates');

    await client.query('COMMIT');
    console.log('✅ Seed completed successfully!');

    // Print summary
    const summary = await client.query(`
      SELECT 
        COUNT(*) as customers,
        SUM(order_count) as orders,
        SUM(total_spent)::integer as revenue,
        AVG(total_spent)::integer as avg_value
      FROM customers
    `);
    console.log('📈 Summary:', summary.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
