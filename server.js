import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import Stripe from 'stripe';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const currency = process.env.STORE_CURRENCY || 'eur';
const databasePath = process.env.DATABASE_URL || './data/ungriff.db';
fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const db = new Database(databasePath);
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    customer_json TEXT NOT NULL,
    items_json TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    shipping INTEGER NOT NULL,
    total INTEGER NOT NULL,
    payment_status TEXT NOT NULL DEFAULT 'pending',
    printful_status TEXT NOT NULL DEFAULT 'pending',
    printful_order_id TEXT,
    tracking_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
for (const column of ["payment_provider TEXT NOT NULL DEFAULT 'stripe'"]) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${column}`); } catch (error) {
    if (!error.message.includes('duplicate column name')) throw error;
  }
}

const printfulHeaders = {
  Authorization: `Bearer ${process.env.PRINTFUL_API_KEY || ''}`,
  'Content-Type': 'application/json'
};

async function printful(pathname, options = {}) {
  if (!process.env.PRINTFUL_API_KEY) throw new Error('PRINTFUL_API_KEY is not configured');
  const response = await fetch(`https://api.printful.com${pathname}`, { ...options, headers: { ...printfulHeaders, ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok || body.code >= 400) throw new Error(body.error?.message || `Printful error ${response.status}`);
  return body.result;
}

function normalizeProduct(product) {
  const variants = (product.sync_variants || []).map((variant) => ({
    id: variant.id,
    productId: variant.product?.product_id || variant.product?.id,
    name: variant.name,
    sku: variant.sku,
    price: Number(variant.retail_price || 0),
    currency,
    size: variant.size || '',
    color: variant.color || '',
    inStock: variant.availability_status !== 'out_of_stock',
    image: variant.files?.find((file) => file.type === 'preview' || file.type === 'default')?.preview_url || variant.product?.image,
    options: variant.options || []
  }));
  const image = product.thumbnail_url || variants[0]?.image || '';
  return {
    id: product.id,
    name: product.name,
    description: product.description || '',
    image,
    gallery: [...new Set([image, ...variants.map((variant) => variant.image).filter(Boolean)])],
    variants,
    available: variants.some((variant) => variant.inStock)
  };
}

async function getProducts() {
  const products = await printful('/store/products');
  return Promise.all(products.map(async (product) => normalizeProduct(await printful(`/store/products/${product.id}`))));
}

function orderNumber() { return `UNG-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`; }
function cents(value) { return Math.round(Number(value) * 100); }
function shippingFor(subtotal) { return subtotal >= 12000 ? 0 : 790; }
function validateCustomerAndItems(customer, items) {
  if (!customer?.email || !customer.firstName || !customer.lastName || !customer.address || !customer.city || !customer.postalCode || !customer.country) throw new Error('Les informations de livraison sont incompletes.');
  if (!Array.isArray(items) || !items.length || items.some((item) => !Number.isInteger(item.variantId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) throw new Error('Le panier est invalide.');
}
async function validateCart(items) {
  const products = await getProducts();
  const catalog = new Map(products.flatMap((product) => product.variants.map((variant) => [String(variant.id), { product, variant }])));
  const validated = items.map((item) => {
    const match = catalog.get(String(item.variantId));
    if (!match || !match.variant.inStock) throw new Error('Une variante sélectionnée n’est plus disponible.');
    return { variantId: match.variant.id, productId: match.product.id, name: match.product.name, size: match.variant.size, color: match.variant.color, quantity: item.quantity, unitAmount: cents(match.variant.price), sku: match.variant.sku };
  });
  const subtotal = validated.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
  const shipping = shippingFor(subtotal);
  return { validated, subtotal, shipping, total: subtotal + shipping };
}
function orderAmount(total) { return (total / 100).toFixed(2); }

app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (request, response) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return response.status(503).send('Stripe is not configured');
  let event;
  try { event = stripe.webhooks.constructEvent(request.body, request.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch { return response.status(400).send('Invalid signature'); }
  if (db.prepare('SELECT id FROM webhook_events WHERE id = ?').get(event.id)) return response.json({ received: true });
  db.prepare('INSERT INTO webhook_events (id, provider) VALUES (?, ?)').run(event.id, 'stripe');
  if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
    const session = event.data.object;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(session.metadata?.orderId);
    if (order && order.payment_status !== 'paid' && (event.type === 'checkout.session.async_payment_succeeded' || session.payment_status === 'paid')) await fulfillOrder(order, session);
  }
  response.json({ received: true });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));
app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'UNGRIFF BOUTIQUE VUE.html')));

app.get('/api/products', async (_request, response) => {
  try { response.json({ products: await getProducts(), currency }); }
  catch (error) { response.status(503).json({ error: 'Le catalogue Printful est momentanement indisponible.' }); }
});

app.post('/api/checkout', async (request, response) => {
  if (!stripe) return response.status(503).json({ error: 'Le paiement Stripe n’est pas encore configure.' });
  const { customer, items } = request.body || {};
  if (!customer?.email || !customer.firstName || !customer.lastName || !customer.address || !customer.city || !customer.postalCode || !customer.country) return response.status(400).json({ error: 'Les informations de livraison sont incompletes.' });
  if (!Array.isArray(items) || !items.length || items.some((item) => !Number.isInteger(item.variantId) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20)) return response.status(400).json({ error: 'Le panier est invalide.' });
  try {
    const products = await getProducts();
    const catalog = new Map(products.flatMap((product) => product.variants.map((variant) => [String(variant.id), { product, variant }])));
    const validated = items.map((item) => {
      const match = catalog.get(String(item.variantId));
      if (!match || !match.variant.inStock) throw new Error('Une variante sélectionnée n’est plus disponible.');
      return { variantId: match.variant.id, productId: match.product.id, name: match.product.name, size: match.variant.size, color: match.variant.color, quantity: item.quantity, unitAmount: cents(match.variant.price), sku: match.variant.sku };
    });
    const subtotal = validated.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
    const shipping = shippingFor(subtotal);
    const createdOrderNumber = orderNumber();
    const order = db.prepare('INSERT INTO orders (order_number, email, customer_json, items_json, subtotal, shipping, total) VALUES (?, ?, ?, ?, ?, ?, ?)').run(createdOrderNumber, customer.email, JSON.stringify(customer), JSON.stringify(validated), subtotal, shipping, subtotal + shipping);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: customer.email,
      line_items: [...validated.map((item) => ({ price_data: { currency, product_data: { name: `${item.name} · ${item.size || item.color || 'Standard'}` }, unit_amount: item.unitAmount }, quantity: item.quantity })), ...(shipping ? [{ price_data: { currency, product_data: { name: 'Livraison' }, unit_amount: shipping }, quantity: 1 }] : [])],
      metadata: { orderId: String(order.lastInsertRowid) },
      success_url: `${publicUrl}/?view=confirmation&order=${createdOrderNumber}`,
      cancel_url: `${publicUrl}/?view=checkout`
    });
    response.json({ checkoutUrl: session.url, orderNumber: createdOrderNumber });
  } catch (error) { response.status(400).json({ error: error.message || 'Impossible de créer la commande.' }); }
});

app.get('/api/orders/:orderNumber', (request, response) => {
  const order = db.prepare('SELECT order_number, email, items_json, subtotal, shipping, total, payment_status, printful_status, tracking_json, created_at FROM orders WHERE order_number = ?').get(request.params.orderNumber);
  if (!order) return response.status(404).json({ error: 'Commande introuvable.' });
  response.json({ ...order, items: JSON.parse(order.items_json), tracking: order.tracking_json ? JSON.parse(order.tracking_json) : [] });
});

async function fulfillOrder(order, session) {
  db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run('paid', order.id);
  const lock = db.prepare("UPDATE orders SET printful_status = 'creating' WHERE id = ? AND printful_order_id IS NULL AND printful_status NOT IN ('creating', 'created')").run(order.id);
  if (!lock.changes) return;
  const customer = JSON.parse(order.customer_json);
  const items = JSON.parse(order.items_json);
  try {
    const printfulOrder = await printful('/orders', { method: 'POST', body: JSON.stringify({ external_id: order.order_number, shipping: 'STANDARD', recipient: { name: `${customer.firstName} ${customer.lastName}`, address1: customer.address, city: customer.city, state_code: customer.state || '', country_code: customer.country, zip: customer.postalCode, email: customer.email, phone: customer.phone || undefined }, items: items.map((item) => ({ sync_variant_id: item.variantId, quantity: item.quantity })) }) });
    db.prepare('UPDATE orders SET printful_status = ?, printful_order_id = ? WHERE id = ?').run('created', String(printfulOrder.id), order.id);
  } catch (error) { db.prepare('UPDATE orders SET printful_status = ? WHERE id = ?').run('error', order.id); console.error('Printful fulfillment error:', error.message); }
}

app.post('/api/webhooks/printful', async (request, response) => {
  const eventId = request.headers['x-pf-webhook-id'] || crypto.createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
  if (db.prepare('SELECT id FROM webhook_events WHERE id = ?').get(eventId)) return response.json({ received: true });
  db.prepare('INSERT INTO webhook_events (id, provider) VALUES (?, ?)').run(eventId, 'printful');
  const order = db.prepare('SELECT id FROM orders WHERE printful_order_id = ?').get(String(request.body?.data?.order?.id || ''));
  if (order) db.prepare('UPDATE orders SET printful_status = ?, tracking_json = ? WHERE id = ?').run(request.body.type || 'updated', JSON.stringify(request.body.data?.shipment || []), order.id);
  response.json({ received: true });
});

app.listen(port, () => console.log(`UNGRIFF running on ${publicUrl}`));
