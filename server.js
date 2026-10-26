
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
app.disable("x-powered-by");

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: allowedOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json({ limit: "25kb" }));
app.use("/api", rateLimit({
  windowMs: 60000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false
}));

for (const key of [
  "FRONTEND_URL",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET"
]) {
  if (!process.env[key]) {
    console.warn("Missing environment variable:", key);
  }
}

// Database
const db = new Database(
  process.env.DB_PATH || "./velvet-table.sqlite"
);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  order_json TEXT NOT NULL,
  provider_order_id TEXT,
  payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

const saveOrder = db.prepare(`
  INSERT INTO orders
  (id, provider, status, amount, currency,
   order_json, provider_order_id)
  VALUES
  (@id, @provider, @status, @amount, @currency,
   @order_json, @provider_order_id)
`);

const updatePaid = db.prepare(`
  UPDATE orders
  SET status = 'paid', payment_id = ?
  WHERE id = ? AND status = 'pending'
`);

const updateCash = db.prepare(`
  UPDATE orders
  SET status = 'cash_due'
  WHERE id = ? AND status = 'pending'
`);

// Keep these prices synchronized with index.html.
const menu = {
  1: { name: "Crispy Golden Fries", price: 149 },
  2: { name: "Paneer Tikka", price: 249 },
  3: { name: "Crispy Chicken Wings", price: 279 },
  4: { name: "Classic Margherita", price: 299 },
  5: { name: "Loaded Farmhouse Pizza", price: 399 },
  6: { name: "Signature Cheeseburger", price: 329 },
  7: { name: "Crispy Veg Burger", price: 229 },
  8: { name: "Creamy Alfredo Pasta", price: 329 },
  9: { name: "Masala Dosa", price: 179 },
  10: { name: "Paneer Butter Masala", price: 299 },
  11: { name: "Royal Veg Biryani", price: 279 },
  12: { name: "Butter Chicken", price: 349 },
  13: { name: "Chocolate Lava Cake", price: 189 },
  14: { name: "New York Cheesecake", price: 229 },
  15: { name: "Belgian Chocolate Scoop", price: 99 },
  16: { name: "Strawberry Sundae", price: 179 },
  17: { name: "Cold Coffee", price: 149 },
  18: { name: "Mango Smoothie", price: 169 },
  19: { name: "Fresh Lime Mojito", price: 159 },
  20: { name: "Masala Chai", price: 69 }
};

const razorpay =
  process.env.RAZORPAY_KEY_ID &&
  process.env.RAZORPAY_KEY_SECRET
    ? new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      })
    : null;

function newId() {
  return crypto.randomUUID();
}

// Recalculate all prices on the server.
function makeOrder(body) {
  const {
    items, type, table = "", name, phone, notes = ""
  } = body || {};

  if (!Array.isArray(items) ||
      items.length < 1 ||
      items.length > 30) {
    throw new Error("Cart is empty or invalid.");
  }

  if (!["dine-in", "takeaway"].includes(type)) {
    throw new Error("Select dine-in or takeaway.");
  }

  if (typeof name !== "string" ||
      !name.trim() || name.trim().length > 80) {
    throw new Error("Enter a valid name.");
  }

  if (typeof phone !== "string" ||
      !/^[+0-9 ()-]{8,15}$/.test(phone.trim())) {
    throw new Error("Enter a valid phone number.");
  }

  if (type === "dine-in" &&
      (typeof table !== "string" ||
       !/^[a-zA-Z0-9 -]{1,10}$/.test(table.trim()))) {
    throw new Error("Enter a valid table number.");
  }

  if (typeof notes !== "string" || notes.length > 300) {
    throw new Error("Special requests are too long.");
  }

  let subtotal = 0;
  const normalized = [];

  for (const item of items) {
    const id = Number(item.id);
    const quantity = Number(item.quantity);

    if (!menu[id] ||
        !Number.isInteger(quantity) ||
        quantity < 1 || quantity > 20) {
      throw new Error("Invalid menu item or quantity.");
    }

    subtotal += menu[id].price * quantity;

    normalized.push({
      id,
      name: menu[id].name,
      unitPrice: menu[id].price,
      quantity
    });
  }

  // Demo tax only. Configure the actual applicable tax rules
  // before accepting real customer orders.
  const tax = Math.round(subtotal * 0.05);
  const total = subtotal + tax;

  if (total < 1 || total > 100000) {
    throw new Error("Order total is outside allowed limits.");
  }

  return {
    items: normalized,
    type,
    table: type === "dine-in" ? table.trim() : "",
    name: name.trim(),
    phone: phone.trim(),
    notes: notes.trim(),
    subtotal,
    tax,
    total
  };
}

function insertOrder({
  id, provider, status, order, providerOrderId = null
}) {
  saveOrder.run({
    id,
    provider,
    status,
    amount: order.total * 100,
    currency: "INR",
    order_json: JSON.stringify(order),
    provider_order_id: providerOrderId
  });
}

function sendError(res, error) {
  console.error(error.message);
  return res.status(400).json({
    error: error.message || "Request failed"
  });
}

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// RAZORPAY: CREATE ORDER
app.post("/api/razorpay/create-order", async (req, res) => {
  try {
    if (!razorpay) {
      return res.status(503).json({
        error: "Razorpay is not configured."
      });
    }

    const order = makeOrder(req.body);
    const internalId = newId();

    const providerOrder = await razorpay.orders.create({
      amount: order.total * 100,
      currency: "INR",
      receipt: "vt_" +
        internalId.replace(/-/g, "").slice(0, 20),
      notes: {
        internal_id: internalId,
        order_type: order.type,
        table: order.table || "takeaway"
      }
    });

    insertOrder({
      id: internalId,
      provider: "razorpay",
      status: "pending",
      order,
      providerOrderId: providerOrder.id
    });

    res.json({
      orderId: providerOrder.id,
      amount: providerOrder.amount,
      currency: providerOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// RAZORPAY: VERIFY SIGNATURE AND CAPTURED PAYMENT
app.post("/api/razorpay/verify", async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderId
    } = req.body || {};

    if (!razorpay ||
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature ||
        orderId !== razorpay_order_id) {
      return res.status(400).json({
        verified: false,
        error: "Invalid payment details."
      });
    }

    const row = db.prepare(`
      SELECT * FROM orders
      WHERE provider = 'razorpay'
      AND provider_order_id = ?
    `).get(razorpay_order_id);

    if (!row) {
      return res.status(404).json({
        verified: false,
        error: "Order not found."
      });
    }

    if (row.status === "paid") {
      return res.json({
        verified: true,
        orderId: row.id
      });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest();

    const supplied = Buffer.from(razorpay_signature, "hex");

    if (supplied.length !== expected.length ||
        !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(400).json({
        verified: false,
        error: "Signature verification failed."
      });
    }

    // Verify the payment against Razorpay's API too.
    const payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (payment.order_id !== row.provider_order_id ||
        payment.status !== "captured" ||
        payment.amount !== row.amount ||
        payment.currency !== row.currency) {
      return res.status(400).json({
        verified: false,
        error: "Payment is not confirmed as captured."
      });
    }

    updatePaid.run(razorpay_payment_id, row.id);

    res.json({
      verified: true,
      orderId: row.id
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// PAYPAL AUTHENTICATION
function paypalBase() {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function paypalAccessToken() {
  if (!process.env.PAYPAL_CLIENT_ID ||
      !process.env.PAYPAL_CLIENT_SECRET) {
    throw new Error("PayPal is not configured.");
  }

  const auth = Buffer.from(
    process.env.PAYPAL_CLIENT_ID + ":" +
    process.env.PAYPAL_CLIENT_SECRET
  ).toString("base64");

  const response = await fetch(
    paypalBase() + "/v1/oauth2/token",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error_description || "PayPal authentication failed."
    );
  }

  return data.access_token;
}

// PAYPAL: CREATE ORDER
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const order = makeOrder(req.body);
    const token = await paypalAccessToken();
    const internalId = newId();

    const response = await fetch(
      paypalBase() + "/v2/checkout/orders",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: internalId,
            custom_id: internalId,
            description: "VELVET TABLE restaurant order",
            amount: {
              currency_code: "INR",
              value: order.total.toFixed(2)
            }
          }],
          application_context: {
            brand_name: "VELVET TABLE",
            user_action: "PAY_NOW",
            return_url: process.env.PAYPAL_RETURN_URL,
            cancel_url: process.env.PAYPAL_CANCEL_URL
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.message || "PayPal could not create the order."
      );
    }

    const approvalUrl = data.links?.find(
      link => link.rel === "approve"
    )?.href;

    if (!approvalUrl) {
      throw new Error("PayPal approval URL missing.");
    }

    insertOrder({
      id: internalId,
      provider: "paypal",
      status: "pending",
      order,
      providerOrderId: data.id
    });

    res.json({
      orderId: data.id,
      approvalUrl
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// PAYPAL: SERVER-SIDE CAPTURE HELPER
async function capturePayPalOrder(paypalOrderId) {
  const row = db.prepare(`
    SELECT * FROM orders
    WHERE provider = 'paypal'
    AND provider_order_id = ?
  `).get(paypalOrderId);

  if (!row) throw new Error("Order not found.");

  if (row.status === "paid") {
    return { verified: true, orderId: row.id };
  }

  const token = await paypalAccessToken();

  const response = await fetch(
    paypalBase() +
      "/v2/checkout/orders/" +
      encodeURIComponent(paypalOrderId) +
      "/capture",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json"
      }
    }
  );

  const data = await response.json();

  // If PayPal reports an already-captured order, retrieve its
  // details and reconcile it rather than trusting the browser.
  if (!response.ok) {
    throw new Error(data.message || "PayPal capture failed.");
  }

  const capture =
    data.purchase_units?.[0]?.payments?.captures?.[0];

  if (data.status !== "COMPLETED" ||
      !capture ||
      capture.status !== "COMPLETED" ||
      Math.round(Number(capture.amount?.value) * 100) !== row.amount ||
      capture.amount?.currency_code !== row.currency) {
    throw new Error("PayPal payment is not confirmed as completed.");
  }

  updatePaid.run(capture.id, row.id);

  return { verified: true, orderId: row.id };
}

// Optional API capture endpoint
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { paypalOrderId } = req.body || {};
    if (!paypalOrderId) {
      throw new Error("PayPal order ID is required.");
    }

    const result = await capturePayPalOrder(paypalOrderId);
    res.json(result);
  } catch (error) {
    return sendError(res, error);
  }
});

// CASH: RECORD ORDER AS AWAITING PAYMENT
app.post("/api/cash-order", (req, res) => {
  try {
    const order = makeOrder(req.body);
    const id = newId();

    insertOrder({
      id,
      provider: "cash",
      status: "pending",
      order
    });

    updateCash.run(id);

    res.json({
      orderId: id,
      status: "cash_due",
      message: "Order placed; payment is due at the restaurant."
    });
  } catch (error) {
    return sendError(res, error);
  }
});

// PAYPAL REDIRECT: CAPTURE ONLY ON THE SERVER
app.get("/paypal/return", async (req, res) => {
  const token = req.query.token;

  if (!token || typeof token !== "string") {
    return res.status(400).send("Missing PayPal order token.");
  }

  try {
    const result = await capturePayPalOrder(token);

    res.send(`<!doctype html>
      <html lang="en">
      <meta name="viewport" content="width=device-width">
      <title>VELVET TABLE payment result</title>
      <body style="font:18px sans-serif;padding:30px;background:#111;color:#fff">
      <h1>Thank you!</h1>
      <p>PayPal payment confirmed.</p>
      <p>Order reference: ${result.orderId}</p>
      <p>You can return to the restaurant menu.</p>
      </body></html>`);
  } catch (error) {
    console.error(error.message);
    res.status(400).send(
      "Payment could not be confirmed. Please contact restaurant staff."
    );
  }
});

app.get("/paypal/cancel", (req, res) => {
  res.send(
    "PayPal checkout was cancelled. Return to the menu to try again."
  );
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("VELVET TABLE API listening on port " + port);
});
