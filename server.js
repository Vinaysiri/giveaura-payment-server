// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

const app = express();

/* --------------------------------------------------
 * BASIC MIDDLEWARE
 * -------------------------------------------------- */

app.use(express.json({ limit: "1mb" }));

/* --------------------------------------------------
 * FIREBASE ADMIN INIT
 * -------------------------------------------------- */

if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log("✅ Firebase Admin initialized");
  } catch (err) {
    console.warn(
      "⚠️ Firebase Admin not initialized (missing credentials). " +
      "Firestore writes will fail until credentials are provided."
    );
    console.warn(err.message);
  }
}


/* --------------------------------------------------
 * ENV LOG (SAFE)
 * -------------------------------------------------- */

console.log("[BOOT] Payment server starting…");
console.log("[ENV]", {
  PORT: process.env.PORT || 5000,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || "(not set)",
  RAZORPAY_KEY_ID: !!process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: !!process.env.RAZORPAY_KEY_SECRET,
});

/* --------------------------------------------------
 * CORS (SAFE + RENDER FRIENDLY)
 * -------------------------------------------------- */

const allowedOrigins = (
  process.env.FRONTEND_ORIGIN
    ? process.env.FRONTEND_ORIGIN.split(",")
    : [
        "http://localhost:5173",
        "http://localhost:4173",
        "http://localhost:3000",
        "https://fundraiser-donations.web.app",
        "https://fundraiser-donations.firebaseapp.com",
      ]
).map((o) => o.trim());

app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      console.warn("[CORS BLOCKED]", origin);
      cb(null, false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

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
  console.log("[BOOT] Razorpay initialized");
} catch (err) {
  console.warn("[WARN] Razorpay not initialized – mock mode");
}

/* --------------------------------------------------
 * HEALTH & ROOT
 * -------------------------------------------------- */

app.get("/", (_req, res) => {
  res.send("GiveAura payment server running");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

/* --------------------------------------------------
 * CREATE ORDER
 * -------------------------------------------------- */

app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount, campaignId, purpose = "donation", meta = {} } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
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
      notes: {
        campaignId: String(campaignId || ""),
        purpose,
        meta: JSON.stringify(meta || {}),
      },
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
 * CONFIRM PAYMENT (🔥 CORE FIX)
 * -------------------------------------------------- */

app.post("/api/payment/confirm", async (req, res) => {
  console.log("[CONFIRM] Incoming request");

  try {
    const { paymentId, orderId, signature, campaignId, amount } = req.body;

    if (!paymentId || !orderId || !signature || !campaignId || !amount) {
      return res
        .status(400)
        .json({ success: false, message: "Missing fields" });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (expected !== signature) {
      return res
        .status(401)
        .json({ success: false, message: "Invalid signature" });
    }

    const db = admin.firestore();
    const donationId = `don_${Date.now()}`;

    await db.runTransaction(async (tx) => {
      const campaignRef = db.collection("campaigns").doc(campaignId);
      const snap = await tx.get(campaignRef);

      if (!snap.exists) throw new Error("Campaign not found");

      const raised = Number(snap.data().fundsRaised || 0);

      tx.set(campaignRef.collection("donations").doc(donationId), {
        donationId,
        campaignId,
        amount: Number(amount),
        paymentId,
        orderId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        source: "render-confirm",
      });

      tx.update(campaignRef, {
        fundsRaised: raised + Number(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    console.log("[CONFIRM] Success", donationId);
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
 * START SERVER (RENDER SAFE)
 * -------------------------------------------------- */

const PORT = Number(process.env.PORT) || 5000;

app.listen(PORT, () => {
  console.log(`[BOOT] Payment server listening on port ${PORT}`);
});
