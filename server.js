require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const app = express();

/* ======================================================
 * BASIC MIDDLEWARE
 * ====================================================== */
app.use(express.json({ limit: "1mb" }));

/* ======================================================
 * CORS
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ======================================================
 * RAZORPAY INIT
 * ====================================================== */
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/* ======================================================
 * HEALTH
 * ====================================================== */
app.get("/", (_req, res) => res.send("GiveAura payment server running"));
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ======================================================
 * CREATE ORDER (DONATION + EVENT)
 * ====================================================== */
app.post("/api/payment/create-order", async (req, res) => {
  try {
    console.log("🔥 CREATE ORDER:", req.body);

    const {
      amount,
      purpose = "donation",
      campaignId = null,
      meta = {},
    } = req.body || {};

    const numericAmount = Number(amount);

    /* ---------- VALIDATION ---------- */
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    if (purpose === "donation" && !campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId is required for donations",
      });
    }

    if (!["donation", "event"].includes(purpose)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment purpose",
      });
    }

    /* ---------- CREATE RAZORPAY ORDER ---------- */
    const order = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100), // paise
      currency: "INR",
      payment_capture: 1,
      notes: {
        purpose,
        campaignId,
        ...meta,
      },
    });

    return res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: "INR",
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error("❌ CREATE ORDER ERROR:", err);
    return res.status(500).json({
      success: false,
      message: "Order creation failed",
    });
  }
});

/* ======================================================
 * VERIFY SIGNATURE
 * ====================================================== */
app.post("/api/payment/verify-signature", (req, res) => {
  try {
    const { paymentId, orderId, signature } = req.body || {};

    if (!paymentId || !orderId || !signature) {
      return res.status(400).json({ valid: false });
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    return res.json({ valid: expected === signature });
  } catch (err) {
    console.error("VERIFY ERROR:", err);
    return res.status(500).json({ valid: false });
  }
});

/* ======================================================
 * START SERVER
 * ====================================================== */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Payment server running on ${PORT}`);
});
