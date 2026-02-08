require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();

/* ======================================================
 * BASIC MIDDLEWARE
 * ====================================================== */

app.use(express.json({ limit: "1mb" }));

/* ======================================================
 * CORS — HARD FIX (NO cors PACKAGE)
 * ====================================================== */

const ALLOWED_ORIGINS = [
  "https://fundraiser-donations.web.app",
  "https://fundraiser-donations.firebaseapp.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Credentials", "true");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

/* ======================================================
 * ENV LOG
 * ====================================================== */

console.log("[BOOT] Payment server starting");
console.log("[ENV]", {
  PORT: process.env.PORT || 5000,
  RAZORPAY_KEY_ID: !!process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: !!process.env.RAZORPAY_KEY_SECRET,
});

/* ======================================================
 * RAZORPAY INIT
 * ====================================================== */

let razorpayInstance = null;

try {
  const Razorpay = require("razorpay");
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} catch {
  console.warn("⚠️ Razorpay NOT available (mock mode)");
}

/* ======================================================
 * ROOT & HEALTH
 * ====================================================== */

app.get("/", (_req, res) => {
  res.send("GiveAura payment server running");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: Date.now(),
  });
});

app.post("/api/events/create-booking-order", async (req, res) => {
  try {
    const { eventId, seats = 1, amount } = req.body;

    if (!eventId || !amount || amount <= 0 || seats <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid event booking payload",
      });
    }

    if (!razorpayInstance) {
      return res.json({
        success: true,
        orderId: `order_mock_${Date.now()}`,
        key: process.env.RAZORPAY_KEY_ID || null,
        amount: Math.round(amount * 100),
        currency: "INR",
        _mock: true,
      });
    }

    const order = await razorpayInstance.orders.create({
      amount: Math.round(amount * 100),
      currency: "INR",
      receipt: `event_${eventId}_${Date.now()}`,
      notes: {
        eventId,
        seats,
        purpose: "event",
      },
      payment_capture: 1,
    });

    return res.json({
      success: true,
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("[EVENT CREATE ORDER ERROR]", err);
    return res.status(500).json({
      success: false,
      message: "Event order creation failed",
    });
  }
});

/* ======================================================
 * CREATE ORDER (ONLY REQUIRED PAYMENT ENDPOINT)
 * ====================================================== */

app.post("/api/payment/create-order", async (req, res) => {
  try {
    console.log("🔥 CREATE-ORDER PAYLOAD:", req.body);
    const { amount, campaignId = null, purpose = "donation", meta = {} } =
      req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    
const ALLOWED_PURPOSES = ["donation", "event"];

if (!ALLOWED_PURPOSES.includes(purpose)) {
  return res.status(400).json({
    success: false,
    message: "Invalid payment purpose",
  });
}

if (purpose === "donation" && !campaignId) {
  return res.status(400).json({
    success: false,
    message: "campaignId is required for donations",
  });
}

if (purpose === "event") {
  // allowed
}

    app.post("/api/events/create-booking-order", async (req, res) => {
  try {
    const { amount, eventId, seats = 1 } = req.body;

    if (!eventId || !amount || amount <= 0 || seats <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid event booking payload",
      });
    }

    if (!razorpayInstance) {
      return res.json({
        success: true,
        orderId: `order_mock_${Date.now()}`,
        key: process.env.RAZORPAY_KEY_ID || null,
        amount: Math.round(Number(amount) * 100),
        currency: "INR",
        _mock: true,
      });
    }

    const order = await razorpayInstance.orders.create({
      amount: Math.round(Number(amount) * 100),
      currency: "INR",
      receipt: `event_${eventId}_${Date.now()}`,
      notes: {
        eventId,
        seats,
        purpose: "event",
      },
      payment_capture: 1,
    });

    return res.json({
      success: true,
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("[EVENT ORDER ERROR]", err);
    return res.status(500).json({
      success: false,
      message: "Event order failed",
    });
  }
});


    // Mock mode (local / no Razorpay keys)
    if (!razorpayInstance) {
      return res.json({
        success: true,
        orderId: `order_mock_${Date.now()}`,
        key: process.env.RAZORPAY_KEY_ID || null,
        amount: Math.round(Number(amount) * 100),
        currency: "INR",
        _mock: true,
      });
    }

    const order = await razorpayInstance.orders.create({
      amount: Math.round(Number(amount) * 100), // paise
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: {
        campaignId,
        purpose,
        ...meta,
      },
      payment_capture: 1,
    });

    return res.json({
      success: true,
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    console.error("[CREATE ORDER ERROR]", err);
    return res.status(500).json({
      success: false,
      message: "Create order failed",
    });
  }
});

/* ======================================================
 * CONFIRM PAYMENT — DISABLED (OLD FLOW)
 * ====================================================== */

app.post("/api/payment/confirm", (_req, res) => {
  return res.status(410).json({
    success: false,
    message:
      "Payment confirmation is handled client-side via donateToCampaign().",
  });
});

/* ======================================================
 * OPTIONAL: SIGNATURE VERIFICATION (SAFE, NO DB WRITE)
 * ====================================================== */

app.post("/api/payment/verify-signature", (req, res) => {
  try {
    const { paymentId, orderId, signature } = req.body;

    if (!paymentId || !orderId || !signature) {
      return res.status(400).json({
        valid: false,
        message: "Missing fields",
      });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    return res.json({ valid: expected === signature });
  } catch (err) {
    console.error("[VERIFY SIGNATURE ERROR]", err);
    return res.status(500).json({ valid: false });
  }
});

/* ======================================================
 * START SERVER
 * ====================================================== */

const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Payment server listening on port ${PORT}`);
});
