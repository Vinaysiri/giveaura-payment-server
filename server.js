require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

/* --------------------------------------------------
 * BASIC MIDDLEWARE
 * -------------------------------------------------- */

app.use(express.json({ limit: "1mb" }));

/* --------------------------------------------------
 * OPTIONAL FIREBASE ADMIN (🔥 SAFE FIX)
 * -------------------------------------------------- */

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
  console.log("✅ firebase-admin loaded & initialized");
} catch (err) {
  console.warn("⚠️ firebase-admin NOT available");
  console.warn("⚠️ Firestore writes are DISABLED");
  console.warn(err.message);
}

/* --------------------------------------------------
 * ENV LOG
 * -------------------------------------------------- */

console.log("[BOOT] Payment server starting…");
console.log("[ENV]", {
  PORT: process.env.PORT || 5000,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "(not set)",
  RAZORPAY_KEY_ID: !!process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: !!process.env.RAZORPAY_KEY_SECRET,
});

/* --------------------------------------------------
 * CORS
 * -------------------------------------------------- */

const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "https://fundraiser-donations.web.app",
  "https://fundraiser-donations.firebaseapp.com",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow server-to-server or curl/postman
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.error("❌ CORS blocked origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// VERY IMPORTANT
app.options("*", cors());

/* --------------------------------------------------
 * RAZORPAY INIT
 * -------------------------------------------------- */

let razorpayInstance = null;

try {
  const Razorpay = require("razorpay");
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.log("✅ Razorpay initialized");
} catch (err) {
  console.warn("⚠️ Razorpay not available – mock mode enabled");
}

/* --------------------------------------------------
 * ROOT & HEALTH
 * -------------------------------------------------- */

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

/* --------------------------------------------------
 * CREATE ORDER
 * -------------------------------------------------- */

app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
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

/* --------------------------------------------------
 * CONFIRM PAYMENT (RENDER SAFE)
 * -------------------------------------------------- */

app.post("/api/payment/confirm", async (req, res) => {
  try {
    const { paymentId, orderId, signature, campaignId, amount } = req.body;

    if (!paymentId || !orderId || !signature || !amount) {
      return res.status(400).json({
        success: false,
        message: "Missing fields",
      });
    }

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

    // 🔁 SAFE FALLBACK IF FIRESTORE NOT AVAILABLE
    if (!firestoreEnabled) {
      console.warn("⚠️ Firestore skipped (firebase-admin missing)");
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

    return res.json({ success: true, donationId });
  } catch (err) {
    console.error("[CONFIRM ERROR]", err);
    return res.status(500).json({
      success: false,
      message: "Payment confirmation failed",
    });
  }
});

/* --------------------------------------------------
 * START SERVER
 * -------------------------------------------------- */

const PORT = Number(process.env.PORT) || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Payment server listening on port ${PORT}`);
});
