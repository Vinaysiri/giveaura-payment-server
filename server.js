require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const app = express();

/* ======================================================
 * CONFIG
 * ====================================================== */

const PORT = Number(process.env.PORT || 5000);

const ALLOWED_ORIGINS = [
  "https://fundraiser-donations.web.app",
  "https://fundraiser-donations.firebaseapp.com",
  "https://giveaura.life",
  "https://www.giveaura.life",

  // Local development
  "http://localhost:5173",
  "http://localhost:3000",
];

/*
 * Supported payment purposes.
 *
 * donation      -> monetary fundraiser donation
 * event         -> generic event payment
 * event-booking -> paid event ticket booking
 * boost         -> campaign boost purchase
 * subscription  -> future subscription plans
 * giveaura-ad   -> GiveAura advertisement purchase
 */
const ALLOWED_PURPOSES = new Set([
  "donation",
  "event",
  "event-booking",
  "boost",
  "subscription",
  "giveaura-ad",
]);

/*
 * Safety limits.
 *
 * These are NOT business-policy limits.
 * They only protect the payment endpoint from absurd values.
 *
 * Change MAX_PAYMENT_AMOUNT_INR later if your platform
 * legitimately needs larger transactions.
 */
const MIN_PAYMENT_AMOUNT_INR = 1;
const MAX_PAYMENT_AMOUNT_INR = 10000000; // ₹1 crore

/* ======================================================
 * BASIC MIDDLEWARE
 * ====================================================== */

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "1mb",
  })
);

/* ======================================================
 * CORS
 * ====================================================== */

app.use((req, res, next) => {
  const origin = req.headers.origin;

  /*
   * Requests without Origin are allowed because they may
   * come from server-to-server calls, health checks, etc.
   */
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );

  if (req.method === "OPTIONS") {
    /*
     * Reject browser preflight from unknown origins.
     */
    if (
      origin &&
      !ALLOWED_ORIGINS.includes(origin)
    ) {
      return res.sendStatus(403);
    }

    return res.sendStatus(204);
  }

  /*
   * Reject browser requests from unknown origins.
   */
  if (
    origin &&
    !ALLOWED_ORIGINS.includes(origin)
  ) {
    return res.status(403).json({
      success: false,
      message: "Origin not allowed",
    });
  }

  next();
});

/* ======================================================
 * ENV VALIDATION
 * ====================================================== */

function validateEnvironment() {
  const missing = [];

  if (!process.env.RAZORPAY_KEY_ID) {
    missing.push("RAZORPAY_KEY_ID");
  }

  if (!process.env.RAZORPAY_KEY_SECRET) {
    missing.push("RAZORPAY_KEY_SECRET");
  }

  if (missing.length > 0) {
    console.error(
      `[startup] Missing required environment variables: ${missing.join(
        ", "
      )}`
    );

    return false;
  }

  return true;
}

const razorpayConfigured = validateEnvironment();

/* ======================================================
 * RAZORPAY INIT
 * ====================================================== */

let razorpay = null;

if (razorpayConfigured) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

/* ======================================================
 * HELPERS
 * ====================================================== */

function normalizeString(value, maxLength = 255) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized = String(value)
    .trim()
    .slice(0, maxLength);

  return normalized || null;
}

function normalizePurpose(value) {
  return String(value || "donation")
    .trim()
    .toLowerCase();
}

function normalizeAmount(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return null;
  }

  /*
   * Payment calculations should be restricted to
   * two decimal places.
   */
  return Math.round(numeric * 100) / 100;
}

function toPaise(amountInRupees) {
  return Math.round(
    Number(amountInRupees) * 100
  );
}

function sanitizeNotes(meta = {}) {
  /*
   * Razorpay notes should contain small scalar values.
   *
   * Never blindly copy arbitrary nested client objects.
   */
  if (
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta)
  ) {
    return {};
  }

  const clean = {};

  const allowedKeys = [
    "userId",
    "donorId",
    "planId",
    "boostPlan",
    "eventId",
    "seats",
    "source",
    "campaignTitle",
    "referenceId",
  ];

  for (const key of allowedKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(
        meta,
        key
      )
    ) {
      continue;
    }

    const value = meta[key];

    if (
      value === null ||
      value === undefined
    ) {
      continue;
    }

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      clean[key] = String(value).slice(
        0,
        250
      );
    }
  }

  return clean;
}

function safeCompareHex(a, b) {
  try {
    const aBuffer = Buffer.from(
      String(a || ""),
      "hex"
    );

    const bBuffer = Buffer.from(
      String(b || ""),
      "hex"
    );

    if (
      aBuffer.length === 0 ||
      bBuffer.length === 0 ||
      aBuffer.length !== bBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      aBuffer,
      bBuffer
    );
  } catch {
    return false;
  }
}

function verifyRazorpaySignature({
  orderId,
  paymentId,
  signature,
}) {
  if (
    !orderId ||
    !paymentId ||
    !signature ||
    !process.env.RAZORPAY_KEY_SECRET
  ) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac(
      "sha256",
      process.env.RAZORPAY_KEY_SECRET
    )
    .update(
      `${orderId}|${paymentId}`
    )
    .digest("hex");

  return safeCompareHex(
    expectedSignature,
    signature
  );
}

function requireRazorpay(res) {
  if (
    !razorpayConfigured ||
    !razorpay
  ) {
    res.status(503).json({
      success: false,
      message:
        "Payment gateway is not configured",
    });

    return false;
  }

  return true;
}

/* ======================================================
 * HEALTH
 * ====================================================== */

app.get("/", (_req, res) => {
  return res.send(
    "GiveAura payment server running"
  );
});

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "giveaura-payment-server",
    razorpayConfigured,
    timestamp: new Date().toISOString(),
  });
});

/* ======================================================
 * CREATE ORDER
 *
 * IMPORTANT:
 *
 * At this stage this endpoint creates the Razorpay order.
 *
 * For donations, the NEXT backend update should make the
 * server load the campaign from Firestore and calculate
 * the authoritative payable amount itself.
 *
 * Until that Firebase integration is added, the server
 * still receives the amount from the client.
 * ====================================================== */

app.post(
  "/api/payment/create-order",
  async (req, res) => {
    try {
      if (!requireRazorpay(res)) {
        return;
      }

      const {
        amount,
        purpose = "donation",
        campaignId = null,
        meta = {},
      } = req.body || {};

      const numericAmount =
        normalizeAmount(amount);

      const normalizedPurpose =
        normalizePurpose(purpose);

      const normalizedCampaignId =
        normalizeString(
          campaignId,
          200
        );

      /* ------------------------------------------
       * Validate amount
       * ------------------------------------------ */

      if (
        numericAmount === null ||
        numericAmount <
          MIN_PAYMENT_AMOUNT_INR ||
        numericAmount >
          MAX_PAYMENT_AMOUNT_INR
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment amount",
        });
      }

      /* ------------------------------------------
       * Validate purpose
       * ------------------------------------------ */

      if (
        !ALLOWED_PURPOSES.has(
          normalizedPurpose
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid payment purpose",
        });
      }

      /* ------------------------------------------
       * Donations require campaignId
       * ------------------------------------------ */

      if (
        normalizedPurpose ===
          "donation" &&
        !normalizedCampaignId
      ) {
        return res.status(400).json({
          success: false,
          message:
            "campaignId is required for donation payments",
        });
      }

      /* ------------------------------------------
       * Boosts also require campaignId
       * ------------------------------------------ */

      if (
        normalizedPurpose ===
          "boost" &&
        !normalizedCampaignId
      ) {
        return res.status(400).json({
          success: false,
          message:
            "campaignId is required for boost payments",
        });
      }

      const cleanMeta =
        sanitizeNotes(meta);

      const amountPaise =
        toPaise(numericAmount);

      /*
       * receipt must be <= Razorpay limits.
       * Keep it compact and unique.
       */
      const receipt = `ga_${Date.now()}_${crypto
        .randomBytes(4)
        .toString("hex")}`;

      console.info(
        "[payment/create-order]",
        {
          purpose:
            normalizedPurpose,
          campaignId:
            normalizedCampaignId,
          amountPaise,
          receipt,
        }
      );

      /* ------------------------------------------
       * Create Razorpay order
       * ------------------------------------------ */

      const order =
        await razorpay.orders.create({
          amount: amountPaise,

          currency: "INR",

          receipt,

          notes: {
            purpose:
              normalizedPurpose,

            ...(normalizedCampaignId
              ? {
                  campaignId:
                    normalizedCampaignId,
                }
              : {}),

            ...cleanMeta,
          },
        });

      return res.status(200).json({
        success: true,

        key:
          process.env
            .RAZORPAY_KEY_ID,

        orderId:
          order.id,

        amount:
          order.amount,

        currency:
          order.currency ||
          "INR",

        receipt:
          order.receipt ||
          receipt,

        purpose:
          normalizedPurpose,
      });
    } catch (err) {
      console.error(
        "[payment/create-order] error:",
        err
      );

      return res.status(500).json({
        success: false,
        message:
          "Order creation failed",
      });
    }
  }
);

/* ======================================================
 * VERIFY PAYMENT
 *
 * This endpoint:
 *
 * 1. verifies Razorpay signature
 * 2. fetches the actual Razorpay payment
 * 3. fetches the actual Razorpay order
 * 4. verifies payment belongs to order
 * 5. verifies amount/currency
 *
 * It DOES NOT yet write Firestore.
 *
 * Firestore accounting will be added in the next backend
 * update so that there is one authoritative transaction.
 * ====================================================== */

app.post(
  "/api/payment/verify",
  async (req, res) => {
    try {
      if (!requireRazorpay(res)) {
        return;
      }

      const {
        paymentId,
        orderId,
        signature,
      } = req.body || {};

      const normalizedPaymentId =
        normalizeString(
          paymentId,
          200
        );

      const normalizedOrderId =
        normalizeString(
          orderId,
          200
        );

      const normalizedSignature =
        normalizeString(
          signature,
          500
        );

      if (
        !normalizedPaymentId ||
        !normalizedOrderId ||
        !normalizedSignature
      ) {
        return res.status(400).json({
          success: false,
          valid: false,
          message:
            "paymentId, orderId and signature are required",
        });
      }

      /* ------------------------------------------
       * Verify checkout signature
       * ------------------------------------------ */

      const signatureValid =
        verifyRazorpaySignature({
          orderId:
            normalizedOrderId,

          paymentId:
            normalizedPaymentId,

          signature:
            normalizedSignature,
        });

      if (!signatureValid) {
        return res.status(401).json({
          success: false,
          valid: false,
          message:
            "Invalid payment signature",
        });
      }

      /* ------------------------------------------
       * Fetch trusted Razorpay records
       * ------------------------------------------ */

      const [
        payment,
        order,
      ] = await Promise.all([
        razorpay.payments.fetch(
          normalizedPaymentId
        ),

        razorpay.orders.fetch(
          normalizedOrderId
        ),
      ]);

      if (!payment) {
        return res.status(404).json({
          success: false,
          valid: false,
          message:
            "Payment not found",
        });
      }

      if (!order) {
        return res.status(404).json({
          success: false,
          valid: false,
          message:
            "Order not found",
        });
      }

      /* ------------------------------------------
       * Ensure payment belongs to order
       * ------------------------------------------ */

      if (
        String(
          payment.order_id || ""
        ) !==
        String(
          normalizedOrderId
        )
      ) {
        return res.status(409).json({
          success: false,
          valid: false,
          message:
            "Payment does not belong to this order",
        });
      }

      /* ------------------------------------------
       * Verify amount
       * ------------------------------------------ */

      const paymentAmount =
        Number(
          payment.amount || 0
        );

      const orderAmount =
        Number(
          order.amount || 0
        );

      if (
        !paymentAmount ||
        !orderAmount ||
        paymentAmount !==
          orderAmount
      ) {
        return res.status(409).json({
          success: false,
          valid: false,
          message:
            "Payment amount mismatch",
        });
      }

      /* ------------------------------------------
       * Verify currency
       * ------------------------------------------ */

      const paymentCurrency =
        String(
          payment.currency || ""
        ).toUpperCase();

      const orderCurrency =
        String(
          order.currency || ""
        ).toUpperCase();

      if (
        paymentCurrency !== "INR" ||
        orderCurrency !== "INR"
      ) {
        return res.status(409).json({
          success: false,
          valid: false,
          message:
            "Unexpected payment currency",
        });
      }

      /*
       * With payment_capture enabled, Razorpay normally
       * captures automatically.
       *
       * We accept only captured payments as successful
       * accounting candidates.
       */
      if (
        payment.status !==
        "captured"
      ) {
        return res.status(409).json({
          success: false,
          valid: false,
          message:
            "Payment has not been captured",
          paymentStatus:
            payment.status ||
            null,
        });
      }

      const notes =
        order.notes &&
        typeof order.notes ===
          "object"
          ? order.notes
          : {};

      return res.status(200).json({
        success: true,

        valid: true,

        payment: {
          paymentId:
            payment.id,

          orderId:
            normalizedOrderId,

          amount:
            paymentAmount,

          amountRupees:
            paymentAmount / 100,

          currency:
            paymentCurrency,

          status:
            payment.status,

          method:
            payment.method ||
            null,

          captured:
            payment.captured ===
            true,

          createdAt:
            payment.created_at ||
            null,
        },

        order: {
          orderId:
            order.id,

          amount:
            orderAmount,

          amountRupees:
            orderAmount / 100,

          currency:
            orderCurrency,

          status:
            order.status ||
            null,

          purpose:
            notes.purpose ||
            null,

          campaignId:
            notes.campaignId ||
            null,

          notes,
        },
      });
    } catch (err) {
      console.error(
        "[payment/verify] error:",
        err
      );

      return res.status(500).json({
        success: false,
        valid: false,
        message:
          "Payment verification failed",
      });
    }
  }
);

/* ======================================================
 * LEGACY VERIFY-SIGNATURE ENDPOINT
 *
 * Kept temporarily so existing frontend code does not
 * immediately break.
 *
 * New code should use:
 *
 * POST /api/payment/verify
 * ====================================================== */

app.post(
  "/api/payment/verify-signature",
  async (req, res) => {
    try {
      const {
        paymentId,
        orderId,
        signature,
      } = req.body || {};

      if (
        !paymentId ||
        !orderId ||
        !signature
      ) {
        return res.status(400).json({
          valid: false,
        });
      }

      const valid =
        verifyRazorpaySignature({
          orderId,
          paymentId,
          signature,
        });

      return res.status(
        valid ? 200 : 401
      ).json({
        valid,
      });
    } catch (err) {
      console.error(
        "[verify-signature] error:",
        err
      );

      return res.status(500).json({
        valid: false,
      });
    }
  }
);

/* ======================================================
 * 404
 * ====================================================== */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

/* ======================================================
 * GLOBAL ERROR HANDLER
 * ====================================================== */

app.use(
  (err, req, res, next) => {
    console.error(
      "[server] unhandled error:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    return res.status(500).json({
      success: false,
      message:
        "Internal server error",
    });
  }
);

/* ======================================================
 * START SERVER
 * ====================================================== */

app.listen(PORT, () => {
  console.log(
    `GiveAura payment server running on port ${PORT}`
  );

  console.log(
    `Razorpay configured: ${
      razorpayConfigured
        ? "YES"
        : "NO"
    }`
  );
});
