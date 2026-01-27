require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const app = express();

/* ======================================================
 * BASIC MIDDLEWARE
 * ====================================================== */

app.use(express.json({ limit: "1mb" }));

/* ======================================================
 * CORS — HARD FIX (NO cors() PACKAGE)
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
 * OPTIONAL FIREBASE ADMIN (SAFE)
 * ====================================================== */

let admin = null;
let firestoreEnabled = false;

try {
  admin = require("firebase-admin");

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
  }

  firestoreEnabled = true;
  console.log("✅ firebase-admin initialized");
} catch (err) {
  console.warn("⚠️ firebase-admin NOT available");
  console.warn("⚠️ Firestore writes DISABLED");
}

/* ======================================================
 * ENV LOG (SAFE)
 * ====================================================== */

console.log("[BOOT] Payment server starting");
console.log("[ENV]", {
  PORT: process.env.PORT || 5000,
  FIRESTORE: firestoreEnabled,
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
} catch (err) {
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
    firestoreEnabled,
    ts: Date.now(),
  });
});

/* ======================================================
 * CREATE ORDER
 * ====================================================== */

app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    // Mock mode (Razorpay not available)
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
 * CONFIRM PAYMENT — FINAL FIX
 * ====================================================== */

app.post("/api/payment/confirm", async (req, res) => {
  try {
    const { paymentId, orderId, signature, campaignId, amount } = req.body;

    if (!paymentId || !orderId || !signature || !amount) {
      return res.status(400).json({
        success: false,
        message: "Missing fields",
      });
    }

    // Verify Razorpay signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (expected !== signature) {
      return res.status(401).json({
        success: false,
        message: "Invalid signature",
      });
    }

    // Firestore disabled → still return success
    if (!firestoreEnabled) {
      console.warn("⚠️ Firestore skipped");
      return res.json({
        success: true,
        donationId: `don_mock_${Date.now()}`,
        _warning: "Firestore disabled",
      });
    }

    const db = admin.firestore();
    const donationId = `don_${Date.now()}`;

    await db.collection("donations").doc(donationId).set({
      donationId,
      campaignId: campaignId || null,
      amount: Number(amount),
      paymentId,
      orderId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "render-confirm",
    });

    return res.json({
      success: true,
      donationId,
    });
  } catch (err) {
    console.error("[CONFIRM ERROR]", err);
    return res.status(500).json({
      success: false,
      message: "Payment confirmation failed",
    });
  }
});

/* ======================================================
 * START SERVER (RENDER SAFE)
 * ====================================================== */

const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Payment server listening on port ${PORT}`);
});
