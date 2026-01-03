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
 * Helpers for platform fee (mirror frontend)
 * --------------------------------- */

// round to 2 decimals
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Decide platform fee % based on campaign type (server-side)
 * Mirrors the mapping in Donate.jsx (getPlatformFeePercent)
 */
function getPlatformFeePercentServer(source) {
  return 0;
}

/* ---------------------------------
 * Routes
 * --------------------------------- */

// simple root for sanity check
app.get("/", (req, res) => {
  res.send("GiveAura payment server is running");
});

// health
app.get("/health", (req, res) => res.json({ ok: true }));

/**
 * POST /api/payment/create-order
 * body: { amount: 100, campaignId: "abc123", purpose?: "donation", meta?: {...} }
 * Returns: { success: true, orderId, key, amount, currency }
 */
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const { amount, campaignId, purpose, meta } = req.body || {};
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

    // Build a safe, short receipt (Razorpay limit: 40 chars)
    const safeCampaignId = (campaignId || "unknown")
      .toString()
      .replace(/[^a-zA-Z0-9]/g, "") // keep only alphanumerics
      .slice(0, 4); // <= 4 chars from campaignId

    const tsBase36 = Date.now().toString(36); // short timestamp
    let receipt = `r_${safeCampaignId}_${tsBase36}`;

    // hard cap to 40 chars for Razorpay
    if (receipt.length > 40) {
      receipt = receipt.slice(0, 40);
    }

    console.info(
      "Computed Razorpay receipt:",
      receipt,
      "length=",
      receipt.length
    );

    // Prepare notes (limited size) so we can see basic context in Razorpay dashboard
    const notes = {
      gv_campaignId: String(campaignId || ""),
      gv_purpose: String(purpose || "donation"),
    };

    if (meta && typeof meta === "object") {
      // pick a few lightweight keys from meta
      Object.entries(meta)
        .slice(0, 3)
        .forEach(([k, v]) => {
          notes[`m_${k}`] = String(v);
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
        receipt,
      };
      return res.json({
        success: true,
        orderId: mockOrder.id,
        key: process.env.RAZORPAY_KEY_ID || null,
        amount: mockOrder.amount,
        currency: mockOrder.currency,
        receipt: mockOrder.receipt,
        purpose: purpose || "donation",
        meta: meta || null,
        _mock: true,
      });
    }

    // Create order on Razorpay
    const options = {
      amount: Math.round(Number(amount) * 100), // in paise
      currency: "INR",
      // we still skip sending `receipt` to Razorpay to avoid length issues in edge cases
      // receipt,
      payment_capture: 1,
      notes,
    };

    console.info("Creating Razorpay order with options:", {
      ...options,
      notes,
    });

    const order = await razorpayInstance.orders.create(options);

    console.info("Razorpay order created:", {
      id: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
    });

    return res.json({
      success: true,
      orderId: order.id,
      key: process.env.RAZORPAY_KEY_ID,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
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
      (serializedError.error && serializedError.error.description) ||
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
 * Record donation on server & compute allocations (optional analytics)
 *
 * body: { donation: { amount, fundraiserShare?, platformFee?, platformFeePercent?, campaignType?, ... } }
 */
app.post("/api/donations/record", async (req, res) => {
  const { donation } = req.body || {};
  if (!donation) {
    return res
      .status(400)
      .json({ success: false, message: "Missing donation in body" });
  }

  // Pull basic numbers
  const gross =
    Number(donation.amount ?? donation.grossAmount ?? 0) || 0;

  // Prefer frontend-provided percent/fee; otherwise compute from type
  let platformPercent =
    typeof donation.platformFeePercent === "number"
      ? donation.platformFeePercent
      : getPlatformFeePercentServer(donation);

  let platformFee =
    typeof donation.platformFee === "number"
      ? Number(donation.platformFee)
      : round2(gross * platformPercent);

  let fundraiserShare =
    typeof donation.fundraiserShare === "number"
      ? Number(donation.fundraiserShare)
      : round2(gross - platformFee);

  // Safety: clamp to avoid negative weirdness
  if (fundraiserShare < 0) fundraiserShare = 0;
  if (platformFee < 0) platformFee = 0;

  const percentDisplay = (platformPercent * 100).toFixed(1);

  const campaignTitle =
    donation.campaignTitle ||
    donation.campaign_name ||
    "Campaign";

  console.info("Received donation record:", {
    campaignId: donation.campaignId,
    amount: gross,
    donorEmail: donation.donorEmail,
    distributionMode: donation.distributionMode || "normal",
    campaignType: donation.campaignType || null,
    platformPercent,
    platformFee,
    fundraiserShare,
  });

  // Build same style allocations used in frontend fallback
  const allocations = [
    {
      id: "creator",
      label: `${campaignTitle} (to fundraiser)`,
      amount: fundraiserShare,
    },
    {
      id: "platform",
      label: `GiveAura Platform Fee (${percentDisplay}%)`,
      amount: platformFee,
    },
  ];

  // If the frontend sent some special overflow info you can extend this here later

  // Here you could write to your own SQL/NoSQL logs if needed.

  return res.json({
    success: true,
    allocations,
  });
});

/**
 * OPTIONAL: list campaigns (used by overflow logic in Donate.jsx)
 */
app.get("/api/campaigns", (req, res) => {
  const excludeId = req.query.exclude;
  console.info("GET /api/campaigns (exclude = %s)", excludeId || "none");
  // Static empty list – Donate.jsx will fall back to Firestore.
  return res.json([]);
});

/**
 * GET /api/campaigns/:id
 * (simple placeholder – real data comes from Firestore on the frontend)
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

const crypto = require("crypto");
const admin = require("firebase-admin");

// init firebase admin once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

app.post("/api/payment/confirm", async (req, res) => {
  try {
    const {
      paymentId,
      orderId,
      signature,
      campaignId,
      amount,
    } = req.body;

    if (!paymentId || !orderId || !signature || !campaignId || !amount) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    // 🔐 verify razorpay signature
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    if (expected !== signature) {
      return res.status(401).json({ success: false, message: "Invalid signature" });
    }

    // 🔥 Firestore update
    const db = admin.firestore();
    const donationId = `don_${Date.now()}`;

    await db.runTransaction(async (tx) => {
      const campaignRef = db.collection("campaigns").doc(campaignId);
      const snap = await tx.get(campaignRef);

      if (!snap.exists) throw new Error("Campaign not found");

      const raised = Number(snap.data().fundsRaised || 0);

      tx.set(
        campaignRef.collection("donations").doc(donationId),
        {
          donationId,
          campaignId,
          amount: Number(amount),
          paymentId,
          orderId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          source: "render-confirm",
        }
      );

      tx.update(campaignRef, {
        fundsRaised: raised + Number(amount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return res.json({ success: true, donationId });
  } catch (err) {
    console.error("confirm error:", err);
    return res.status(500).json({ success: false, message: "Confirm failed" });
  }
});
