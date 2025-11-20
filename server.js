// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json());

// Print env for debugging (do NOT keep verbose logs forever in prod)
console.info("ENV:", {
  PORT: process.env.PORT || "(default 5000)",
  FRONTEND_ORIGIN:
    process.env.FRONTEND_ORIGIN ||
    "(not set, default http://localhost:5173)",
  RAZORPAY_KEY_ID: !!process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: !!process.env.RAZORPAY_KEY_SECRET,
});

/* ---------------------------------
 * CORS setup
 * --------------------------------- */

// defaults for dev + known Firebase Hosting URLs
const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:3000",
  "https://fundraiser-donations.web.app",
  "https://fundraiser-donations.firebaseapp.com",
];

// You can set multiple origins in FRONTEND_ORIGIN separated by comma
// e.g. FRONTEND_ORIGIN=https://fundraiser-donations.web.app,https://myadmin.domain.com
const envOrigins = process.env.FRONTEND_ORIGIN
  ? process.env.FRONTEND_ORIGIN.split(",")
      .map((o) => o.trim())
      .filter(Boolean)
  : [];

const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

console.info("Allowed CORS origins:", allowedOrigins);

app.use(
  cors({
    origin(origin, callback) {
      // allow:
      // - same-origin/backend tools (no Origin header)
      // - any origin in our whitelist
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn("CORS blocked origin:", origin);
      callback(new Error("Not allowed by CORS"));
    },
  })
);

// optional: handle preflight explicitly
app.options("*", cors());

/* ---------------------------------
 * Razorpay setup
 * --------------------------------- */

let Razorpay = null;
let razorpayInstance = null;

try {
  Razorpay = require("razorpay");
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
  console.info("✅ Razorpay SDK loaded");
} catch (err) {
  console.warn(
    "⚠️ Razorpay SDK not available or failed to initialize. Falling back to mock orders for testing."
  );
  console.warn(err && err.stack ? err.stack : err);
  razorpayInstance = null;
}

/* ---------------------------------
 * Routes
 * --------------------------------- */

// health
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /api/payment/create-order
 * body: { amount: 100, campaignId: "abc123" }
 * Returns: { success: true, orderId, key, amount, currency }
 */
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount, campaignId } = req.body || {};
    if (
      amount === undefined ||
      amount === null ||
      Number(amount) <= 0 ||
      Number.isNaN(Number(amount))
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount (must be a positive number)",
      });
    }

    // If no Razorpay instance (module not installed or keys missing), return a mock order
    if (!razorpayInstance) {
      console.warn(
        "Using mock order because Razorpay instance not initialized."
      );
      const mockOrder = {
        id: `order_mock_${Date.now()}`,
        amount: Math.round(Number(amount) * 100),
        currency: "INR",
      };
      return res.json({
        success: true,
        orderId: mockOrder.id,
        key: process.env.RAZORPAY_KEY_ID || null,
        amount: mockOrder.amount,
        currency: mockOrder.currency,
        _mock: true,
      });
    }

    // Create order on Razorpay
    const options = {
      amount: Math.round(Number(amount) * 100), // in paise
      currency: "INR",
      receipt: `rcpt_${campaignId || "unknown"}_${Date.now()}`,
      payment_capture: 1,
    };

    const order = await razorpayInstance.orders.create(options);

    return res.json({
      success: true,
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
    });
  } catch (err) {
    // Serialize the error safely
    const serializedError = (() => {
      try {
        const obj = {};
        Object.getOwnPropertyNames(err).forEach((k) => {
          try {
            obj[k] = err[k];
          } catch {
            obj[k] = String(err[k]);
          }
        });
        obj.message = err.message || obj.message;
        obj.stack = err.stack
          ? err.stack.split("\n").slice(0, 8).join("\n")
          : undefined;
        return obj;
      } catch {
        return { message: String(err) };
      }
    })();

    console.error("Create-order error (full):", serializedError);

    const clientMsg =
      serializedError.error?.description ||
      serializedError.message ||
      "Server error creating Razorpay order";

    return res.status(500).json({
      success: false,
      message: "Server error creating Razorpay order",
      error: clientMsg,
      stack: serializedError.stack, // dev-only
    });
  }
});

/**
 * OPTIONAL: record donation on server
 * Your Donate.jsx POSTs here with { donation }
 * Right now we just log + ACK so front-end doesn't break.
 * Later you can connect this to Firestore / your DB.
 */
app.post("/api/donations/record", async (req, res) => {
  const { donation } = req.body || {};
  if (!donation) {
    return res
      .status(400)
      .json({ success: false, message: "Missing donation in body" });
  }

  console.info("Received donation record:", {
    campaignId: donation.campaignId,
    amount: donation.amount,
    donorEmail: donation.donorEmail,
    distributionMode: donation.distributionMode,
  });

  // TODO: save to DB / verify Razorpay signature here if you want server-side safety

  // For now, respond success with no extra allocations (client already computes splits)
  return res.json({
    success: true,
    allocations: null,
  });
});

/**
 * OPTIONAL: list campaigns (used by overflow logic in Donate.jsx)
 * For now we return an empty array. If you want, wire this to your DB.
 */
app.get("/api/campaigns", (req, res) => {
  // NOTE: you can respect ?exclude= param here
  const excludeId = req.query.exclude;
  console.info("GET /api/campaigns (exclude = %s)", excludeId || "none");

  // stub: return empty list so client gracefully skips overflow targeting
  return res.json([]);
});

/**
 * GET /api/campaigns/:id
 * Used by Donate.jsx as a fallback to load a simple campaign object.
 */
app.get("/api/campaigns/:id", (req, res) => {
  const id = req.params.id;
  res.json({
    id,
    title: "Test Campaign",
    creatorAccountId: null,
  });
});

/* ---------------------------------
 * Server listen
 * --------------------------------- */

const PORT = Number(process.env.PORT) || 5000;
const server = app.listen(PORT, () =>
  console.log(`Payment server listening on http://localhost:${PORT}`)
);

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Kill the process using that port or change PORT in your .env.`
    );
  } else {
    console.error("Server error:", err);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error(
    "Unhandled Rejection:",
    reason && (reason.stack || reason.toString())
  );
});
process.on("uncaughtException", (err) => {
  console.error(
    "Uncaught Exception:",
    err && (err.stack || err.toString())
  );
});
