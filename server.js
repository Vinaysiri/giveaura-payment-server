require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");

const app = express();

/* ======================================================
 * CONFIG
 * ====================================================== */

const PORT = Number(
  process.env.PORT || 5000
);

const ALLOWED_ORIGINS = [
  "https://fundraiser-donations.web.app",
  "https://fundraiser-donations.firebaseapp.com",
  "https://giveaura.life",
  "https://www.giveaura.life",

  "http://localhost:5173",
  "http://localhost:3000",
];

const ALLOWED_PURPOSES = new Set([
  "donation",
  "event",
  "event-booking",
  "boost",
  "subscription",
  "giveaura-ad",
]);

const MIN_PAYMENT_AMOUNT_INR = 1;

const MAX_PAYMENT_AMOUNT_INR =
  10000000;

/*
 * External/public/youth-created event:
 *
 * GiveAura = 12%
 * Organizer = 88%
 *
 * GiveAura-owned event:
 *
 * GiveAura = 100%
 */
const EXTERNAL_EVENT_PLATFORM_FEE_PERCENT =
  12;

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
  const origin =
    req.headers.origin;

  if (
    origin &&
    ALLOWED_ORIGINS.includes(origin)
  ) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  res.setHeader(
    "Vary",
    "Origin"
  );

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

  if (
    req.method === "OPTIONS"
  ) {
    if (
      origin &&
      !ALLOWED_ORIGINS.includes(
        origin
      )
    ) {
      return res.sendStatus(403);
    }

    return res.sendStatus(204);
  }

  if (
    origin &&
    !ALLOWED_ORIGINS.includes(
      origin
    )
  ) {
    return res
      .status(403)
      .json({
        success: false,
        message:
          "Origin not allowed",
      });
  }

  next();
});

/* ======================================================
 * ENV VALIDATION
 * ====================================================== */

function validateEnvironment() {
  const missing = [];

  if (
    !process.env.RAZORPAY_KEY_ID
  ) {
    missing.push(
      "RAZORPAY_KEY_ID"
    );
  }

  if (
    !process.env
      .RAZORPAY_KEY_SECRET
  ) {
    missing.push(
      "RAZORPAY_KEY_SECRET"
    );
  }

  if (
    missing.length > 0
  ) {
    console.error(
      `[startup] Missing required environment variables: ${missing.join(
        ", "
      )}`
    );

    return false;
  }

  return true;
}

const razorpayConfigured =
  validateEnvironment();

/* ======================================================
 * RAZORPAY INIT
 * ====================================================== */

let razorpay = null;

if (razorpayConfigured) {
  razorpay = new Razorpay({
    key_id:
      process.env
        .RAZORPAY_KEY_ID,

    key_secret:
      process.env
        .RAZORPAY_KEY_SECRET,
  });
}

/* ======================================================
 * HELPERS
 * ====================================================== */

function normalizeString(
  value,
  maxLength = 255
) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const normalized =
    String(value)
      .trim()
      .slice(
        0,
        maxLength
      );

  return normalized || null;
}

function normalizePurpose(
  value
) {
  return String(
    value || "donation"
  )
    .trim()
    .toLowerCase();
}

function normalizeAmount(
  value
) {
  const numeric =
    Number(value);

  if (
    !Number.isFinite(numeric)
  ) {
    return null;
  }

  return (
    Math.round(
      numeric * 100
    ) / 100
  );
}

function normalizeQuantity(
  value
) {
  const numeric =
    Number(value);

  if (
    !Number.isFinite(numeric)
  ) {
    return null;
  }

  const quantity =
    Math.floor(numeric);

  if (
    quantity < 1 ||
    quantity > 100
  ) {
    return null;
  }

  return quantity;
}

function toPaise(
  amountInRupees
) {
  return Math.round(
    Number(
      amountInRupees
    ) * 100
  );
}

function fromPaise(
  amountInPaise
) {
  return (
    Math.round(
      Number(
        amountInPaise
      )
    ) / 100
  );
}

function roundMoney(
  value
) {
  return (
    Math.round(
      Number(value) * 100
    ) / 100
  );
}

function sanitizeNotes(
  meta = {}
) {
  if (
    !meta ||
    typeof meta !==
      "object" ||
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
    "quantity",
    "source",
    "campaignTitle",
    "referenceId",
    "eventTitle",
    "eventOwnerType",
    "organizerId",
  ];

  for (
    const key of allowedKeys
  ) {
    if (
      !Object.prototype
        .hasOwnProperty.call(
          meta,
          key
        )
    ) {
      continue;
    }

    const value =
      meta[key];

    if (
      value === null ||
      value === undefined
    ) {
      continue;
    }

    if (
      typeof value ===
        "string" ||
      typeof value ===
        "number" ||
      typeof value ===
        "boolean"
    ) {
      clean[key] =
        String(value).slice(
          0,
          250
        );
    }
  }

  return clean;
}

function safeCompareHex(
  a,
  b
) {
  try {
    const aBuffer =
      Buffer.from(
        String(a || ""),
        "hex"
      );

    const bBuffer =
      Buffer.from(
        String(b || ""),
        "hex"
      );

    if (
      aBuffer.length === 0 ||
      bBuffer.length === 0 ||
      aBuffer.length !==
        bBuffer.length
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
    !process.env
      .RAZORPAY_KEY_SECRET
  ) {
    return false;
  }

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        process.env
          .RAZORPAY_KEY_SECRET
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

function requireRazorpay(
  res
) {
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

function createReceipt(
  prefix = "ga"
) {
  return `${prefix}_${Date.now()}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

/* ======================================================
 * EVENT OWNERSHIP HELPERS
 * ====================================================== */

function normalizeEventOwnerType(
  value
) {
  const normalized =
    String(
      value || ""
    )
      .trim()
      .toLowerCase();

  if (
    [
      "giveaura",
      "giveaura-owned",
      "giveaura_owned",
      "platform",
      "official",
    ].includes(normalized)
  ) {
    return "giveaura";
  }

  return "external";
}

function calculateEventSplit({
  grossAmount,
  eventOwnerType,
}) {
  const gross =
    roundMoney(
      grossAmount
    );

  if (
    eventOwnerType ===
    "giveaura"
  ) {
    return {
      grossAmount:
        gross,

      platformFeePercent:
        100,

      platformAmount:
        gross,

      organizerAmount:
        0,
    };
  }

  const platformAmount =
    roundMoney(
      gross *
        (EXTERNAL_EVENT_PLATFORM_FEE_PERCENT /
          100)
    );

  const organizerAmount =
    roundMoney(
      gross -
        platformAmount
    );

  return {
    grossAmount:
      gross,

    platformFeePercent:
      EXTERNAL_EVENT_PLATFORM_FEE_PERCENT,

    platformAmount,

    organizerAmount,
  };
}

/* ======================================================
 * HEALTH
 * ====================================================== */

app.get(
  "/",
  (_req, res) => {
    return res.send(
      "GiveAura payment server running"
    );
  }
);

app.get(
  "/health",
  (_req, res) => {
    return res.json({
      ok: true,

      service:
        "giveaura-payment-server",

      razorpayConfigured,

      eventBookingRoutes:
        true,

      timestamp:
        new Date().toISOString(),
    });
  }
);

/* ======================================================
 * CREATE GENERIC ORDER
 *
 * Used for:
 *
 * donation
 * boost
 * subscription
 * giveaura-ad
 *
 * Event booking should use:
 *
 * POST /api/payment/create-event-order
 * ====================================================== */

app.post(
  "/api/payment/create-order",

  async (req, res) => {
    try {
      if (
        !requireRazorpay(res)
      ) {
        return;
      }

      const {
        amount,

        purpose =
          "donation",

        campaignId =
          null,

        meta = {},
      } =
        req.body || {};

      const numericAmount =
        normalizeAmount(
          amount
        );

      const normalizedPurpose =
        normalizePurpose(
          purpose
        );

      const normalizedCampaignId =
        normalizeString(
          campaignId,
          200
        );

      /* ------------------------------------------
       * Validate amount
       * ------------------------------------------ */

      if (
        numericAmount ===
          null ||
        numericAmount <
          MIN_PAYMENT_AMOUNT_INR ||
        numericAmount >
          MAX_PAYMENT_AMOUNT_INR
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Invalid payment amount",
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
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Invalid payment purpose",
          });
      }

      /* ------------------------------------------
       * Event booking has dedicated endpoint
       * ------------------------------------------ */

      if (
        normalizedPurpose ===
          "event" ||
        normalizedPurpose ===
          "event-booking"
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Use /api/payment/create-event-order for event bookings",
          });
      }

      /* ------------------------------------------
       * Donation requires campaign
       * ------------------------------------------ */

      if (
        normalizedPurpose ===
          "donation" &&
        !normalizedCampaignId
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "campaignId is required for donation payments",
          });
      }

      /* ------------------------------------------
       * Boost requires campaign
       * ------------------------------------------ */

      if (
        normalizedPurpose ===
          "boost" &&
        !normalizedCampaignId
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "campaignId is required for boost payments",
          });
      }

      const cleanMeta =
        sanitizeNotes(meta);

      const amountPaise =
        toPaise(
          numericAmount
        );

      const receipt =
        createReceipt("ga");

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

      const order =
        await razorpay.orders.create(
          {
            amount:
              amountPaise,

            currency:
              "INR",

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
          }
        );

      return res
        .status(200)
        .json({
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

      return res
        .status(500)
        .json({
          success: false,

          message:
            "Order creation failed",
        });
    }
  }
);

/* ======================================================
 * CREATE EVENT ORDER
 *
 * Endpoint expected by paymentService.js:
 *
 * POST /api/payment/create-event-order
 *
 * Current request supports:
 *
 * {
 *   eventId,
 *   quantity,
 *   ticketPrice,
 *   userId,
 *   eventOwnerType,
 *   organizerId,
 *   eventTitle,
 *   meta
 * }
 *
 * IMPORTANT SECURITY NOTE:
 *
 * Until Firebase Admin is connected to this Render server,
 * ticketPrice/event ownership still arrive from the client.
 *
 * Razorpay amount is fixed into the order and verified again
 * during confirmation, but Firestore should eventually become
 * the authoritative source for event price and ownership.
 * ====================================================== */

app.post(
  "/api/payment/create-event-order",

  async (req, res) => {
    try {
      if (
        !requireRazorpay(res)
      ) {
        return;
      }

      const {
        eventId,

        quantity = 1,

        ticketPrice,

        amount,

        userId = null,

        eventOwnerType =
          "external",

        organizerId =
          null,

        eventTitle =
          null,

        meta = {},
      } =
        req.body || {};

      const normalizedEventId =
        normalizeString(
          eventId,
          200
        );

      if (
        !normalizedEventId
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "eventId is required",
          });
      }

      const normalizedQuantity =
        normalizeQuantity(
          quantity
        );

      if (
        !normalizedQuantity
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Invalid ticket quantity",
          });
      }

      /*
       * Support either:
       *
       * ticketPrice = price of one ticket
       *
       * OR
       *
       * amount = total amount
       *
       * ticketPrice is preferred.
       */

      let normalizedTicketPrice =
        normalizeAmount(
          ticketPrice
        );

      let grossAmount = null;

      if (
        normalizedTicketPrice !==
          null &&
        normalizedTicketPrice >=
          MIN_PAYMENT_AMOUNT_INR
      ) {
        grossAmount =
          roundMoney(
            normalizedTicketPrice *
              normalizedQuantity
          );
      } else {
        grossAmount =
          normalizeAmount(
            amount
          );

        if (
          grossAmount !==
            null &&
          grossAmount > 0
        ) {
          normalizedTicketPrice =
            roundMoney(
              grossAmount /
                normalizedQuantity
            );
        }
      }

      if (
        grossAmount ===
          null ||
        grossAmount <
          MIN_PAYMENT_AMOUNT_INR ||
        grossAmount >
          MAX_PAYMENT_AMOUNT_INR
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Event payment amount must be greater than zero",
          });
      }

      const normalizedOwnerType =
        normalizeEventOwnerType(
          eventOwnerType
        );

      const normalizedUserId =
        normalizeString(
          userId,
          200
        );

      const normalizedOrganizerId =
        normalizeString(
          organizerId,
          200
        );

      const normalizedEventTitle =
        normalizeString(
          eventTitle,
          200
        );

      const split =
        calculateEventSplit({
          grossAmount,

          eventOwnerType:
            normalizedOwnerType,
        });

      const amountPaise =
        toPaise(
          grossAmount
        );

      const receipt =
        createReceipt("gae");

      const cleanMeta =
        sanitizeNotes(meta);

      console.info(
        "[payment/create-event-order]",
        {
          eventId:
            normalizedEventId,

          quantity:
            normalizedQuantity,

          ticketPrice:
            normalizedTicketPrice,

          grossAmount,

          amountPaise,

          eventOwnerType:
            normalizedOwnerType,

          platformFeePercent:
            split.platformFeePercent,

          receipt,
        }
      );

      const order =
        await razorpay.orders.create(
          {
            amount:
              amountPaise,

            currency:
              "INR",

            receipt,

            notes: {
              purpose:
                "event-booking",

              eventId:
                normalizedEventId,

              quantity:
                String(
                  normalizedQuantity
                ),

              ticketPrice:
                String(
                  normalizedTicketPrice
                ),

              eventOwnerType:
                normalizedOwnerType,

              platformFeePercent:
                String(
                  split.platformFeePercent
                ),

              ...(normalizedUserId
                ? {
                    userId:
                      normalizedUserId,
                  }
                : {}),

              ...(normalizedOrganizerId
                ? {
                    organizerId:
                      normalizedOrganizerId,
                  }
                : {}),

              ...(normalizedEventTitle
                ? {
                    eventTitle:
                      normalizedEventTitle,
                  }
                : {}),

              ...cleanMeta,
            },
          }
        );

      return res
        .status(200)
        .json({
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
            "event-booking",

          event: {
            eventId:
              normalizedEventId,

            title:
              normalizedEventTitle,

            quantity:
              normalizedQuantity,

            ticketPrice:
              normalizedTicketPrice,

            ownerType:
              normalizedOwnerType,
          },

          breakdown: {
            ticketPrice:
              normalizedTicketPrice,

            quantity:
              normalizedQuantity,

            grossAmount:
              split.grossAmount,

            platformFeePercent:
              split.platformFeePercent,

            platformAmount:
              split.platformAmount,

            organizerAmount:
              split.organizerAmount,
          },
        });
    } catch (err) {
      console.error(
        "[payment/create-event-order] error:",
        err
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            "Event order creation failed",
        });
    }
  }
);

/* ======================================================
 * CONFIRM EVENT BOOKING
 *
 * Endpoint expected by paymentService.js:
 *
 * POST /api/payment/confirm-event-booking
 *
 * This endpoint:
 *
 * 1. verifies Razorpay signature
 * 2. fetches actual Razorpay payment
 * 3. fetches actual Razorpay order
 * 4. confirms payment belongs to order
 * 5. confirms captured status
 * 6. confirms INR
 * 7. confirms order purpose = event-booking
 * 8. confirms eventId
 * 9. calculates trusted split from PAID amount
 *
 * External event:
 * GiveAura = 12%
 * Organizer = 88%
 *
 * GiveAura-owned:
 * GiveAura = 100%
 *
 * NOTE:
 * Firestore booking/accounting write is not performed here
 * yet because Firebase Admin is not initialized in this
 * standalone Render server.
 * ====================================================== */

app.post(
  "/api/payment/confirm-event-booking",

  async (req, res) => {
    try {
      if (
        !requireRazorpay(res)
      ) {
        return;
      }

      const {
        eventId,

        paymentId,

        orderId,

        signature,

        attendee = null,

        userId = null,
      } =
        req.body || {};

      const normalizedEventId =
        normalizeString(
          eventId,
          200
        );

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
        !normalizedEventId ||
        !normalizedPaymentId ||
        !normalizedOrderId ||
        !normalizedSignature
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "eventId, paymentId, orderId and signature are required",
          });
      }

      /* ------------------------------------------
       * Verify signature
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

      if (
        !signatureValid
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            valid:
              false,

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
      ] =
        await Promise.all([
          razorpay.payments.fetch(
            normalizedPaymentId
          ),

          razorpay.orders.fetch(
            normalizedOrderId
          ),
        ]);

      if (!payment) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "Payment not found",
          });
      }

      if (!order) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "Order not found",
          });
      }

      /* ------------------------------------------
       * Payment must belong to order
       * ------------------------------------------ */

      if (
        String(
          payment.order_id ||
            ""
        ) !==
        normalizedOrderId
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "Payment does not belong to this order",
          });
      }

      /* ------------------------------------------
       * Amount verification
       * ------------------------------------------ */

      const paymentAmount =
        Number(
          payment.amount ||
            0
        );

      const orderAmount =
        Number(
          order.amount ||
            0
        );

      if (
        !paymentAmount ||
        !orderAmount ||
        paymentAmount !==
          orderAmount
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "Payment amount mismatch",
          });
      }

      /* ------------------------------------------
       * Currency verification
       * ------------------------------------------ */

      const paymentCurrency =
        String(
          payment.currency ||
            ""
        ).toUpperCase();

      const orderCurrency =
        String(
          order.currency ||
            ""
        ).toUpperCase();

      if (
        paymentCurrency !==
          "INR" ||
        orderCurrency !==
          "INR"
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "Unexpected payment currency",
          });
      }

      /* ------------------------------------------
       * Captured payment required
       * ------------------------------------------ */

      if (
        payment.status !==
          "captured"
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

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

      /* ------------------------------------------
       * Verify event booking purpose
       * ------------------------------------------ */

      if (
        String(
          notes.purpose ||
            ""
        ) !==
        "event-booking"
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "Order is not an event booking order",
          });
      }

      /* ------------------------------------------
       * Verify eventId against Razorpay order
       * ------------------------------------------ */

      if (
        String(
          notes.eventId ||
            ""
        ) !==
        normalizedEventId
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            message:
              "Event ID does not match payment order",
          });
      }

      /* ------------------------------------------
       * Read order metadata
       * ------------------------------------------ */

      const quantity =
        normalizeQuantity(
          notes.quantity ||
            1
        ) || 1;

      const eventOwnerType =
        normalizeEventOwnerType(
          notes.eventOwnerType
        );

      /*
       * Gross is derived from actual captured
       * Razorpay amount, not from frontend.
       */

      const grossAmount =
        fromPaise(
          paymentAmount
        );

      const split =
        calculateEventSplit({
          grossAmount,

          eventOwnerType,
        });

      const ticketPrice =
        roundMoney(
          grossAmount /
            quantity
        );

      const bookingReference =
        `GAB-${Date.now()
          .toString(36)
          .toUpperCase()}-${crypto
          .randomBytes(3)
          .toString("hex")
          .toUpperCase()}`;

      console.info(
        "[payment/confirm-event-booking]",
        {
          eventId:
            normalizedEventId,

          paymentId:
            normalizedPaymentId,

          orderId:
            normalizedOrderId,

          quantity,

          grossAmount,

          eventOwnerType,

          platformAmount:
            split.platformAmount,

          organizerAmount:
            split.organizerAmount,

          bookingReference,
        }
      );

      return res
        .status(200)
        .json({
          success: true,

          valid: true,

          bookingId:
            bookingReference,

          booking: {
            bookingId:
              bookingReference,

            eventId:
              normalizedEventId,

            eventTitle:
              notes.eventTitle ||
              null,

            quantity,

            ticketPrice,

            grossAmount,

            currency:
              "INR",

            attendee:
              attendee &&
              typeof attendee ===
                "object"
                ? attendee
                : null,

            userId:
              normalizeString(
                userId,
                200
              ) ||
              notes.userId ||
              null,

            organizerId:
              notes.organizerId ||
              null,

            eventOwnerType,

            paymentId:
              normalizedPaymentId,

            orderId:
              normalizedOrderId,

            paymentStatus:
              payment.status,

            bookingStatus:
              "confirmed",

            createdAt:
              new Date().toISOString(),
          },

          split: {
            grossAmount:
              split.grossAmount,

            platformFeePercent:
              split.platformFeePercent,

            giveAuraAmount:
              split.platformAmount,

            organizerAmount:
              split.organizerAmount,
          },

          message:
            "Event payment verified successfully",
        });
    } catch (err) {
      console.error(
        "[payment/confirm-event-booking] error:",
        err
      );

      return res
        .status(500)
        .json({
          success: false,

          valid:
            false,

          message:
            "Event booking confirmation failed",
        });
    }
  }
);

/* ======================================================
 * VERIFY PAYMENT
 * ====================================================== */

app.post(
  "/api/payment/verify",

  async (req, res) => {
    try {
      if (
        !requireRazorpay(res)
      ) {
        return;
      }

      const {
        paymentId,
        orderId,
        signature,
      } =
        req.body || {};

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
        return res
          .status(400)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "paymentId, orderId and signature are required",
          });
      }

      const signatureValid =
        verifyRazorpaySignature({
          orderId:
            normalizedOrderId,

          paymentId:
            normalizedPaymentId,

          signature:
            normalizedSignature,
        });

      if (
        !signatureValid
      ) {
        return res
          .status(401)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "Invalid payment signature",
          });
      }

      const [
        payment,
        order,
      ] =
        await Promise.all([
          razorpay.payments.fetch(
            normalizedPaymentId
          ),

          razorpay.orders.fetch(
            normalizedOrderId
          ),
        ]);

      if (!payment) {
        return res
          .status(404)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "Payment not found",
          });
      }

      if (!order) {
        return res
          .status(404)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "Order not found",
          });
      }

      if (
        String(
          payment.order_id ||
            ""
        ) !==
        normalizedOrderId
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "Payment does not belong to this order",
          });
      }

      const paymentAmount =
        Number(
          payment.amount ||
            0
        );

      const orderAmount =
        Number(
          order.amount ||
            0
        );

      if (
        !paymentAmount ||
        !orderAmount ||
        paymentAmount !==
          orderAmount
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "Payment amount mismatch",
          });
      }

      const paymentCurrency =
        String(
          payment.currency ||
            ""
        ).toUpperCase();

      const orderCurrency =
        String(
          order.currency ||
            ""
        ).toUpperCase();

      if (
        paymentCurrency !==
          "INR" ||
        orderCurrency !==
          "INR"
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            valid:
              false,

            message:
              "Unexpected payment currency",
          });
      }

      if (
        payment.status !==
          "captured"
      ) {
        return res
          .status(409)
          .json({
            success:
              false,

            valid:
              false,

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

      return res
        .status(200)
        .json({
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
              paymentAmount /
              100,

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
              orderAmount /
              100,

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

            eventId:
              notes.eventId ||
              null,

            notes,
          },
        });
    } catch (err) {
      console.error(
        "[payment/verify] error:",
        err
      );

      return res
        .status(500)
        .json({
          success: false,

          valid:
            false,

          message:
            "Payment verification failed",
        });
    }
  }
);

/* ======================================================
 * LEGACY VERIFY SIGNATURE
 * ====================================================== */

app.post(
  "/api/payment/verify-signature",

  async (req, res) => {
    try {
      const {
        paymentId,
        orderId,
        signature,
      } =
        req.body || {};

      if (
        !paymentId ||
        !orderId ||
        !signature
      ) {
        return res
          .status(400)
          .json({
            valid:
              false,
          });
      }

      const valid =
        verifyRazorpaySignature({
          orderId,
          paymentId,
          signature,
        });

      return res
        .status(
          valid
            ? 200
            : 401
        )
        .json({
          valid,
        });
    } catch (err) {
      console.error(
        "[verify-signature] error:",
        err
      );

      return res
        .status(500)
        .json({
          valid:
            false,
        });
    }
  }
);

/* ======================================================
 * 404
 * ====================================================== */

app.use(
  (req, res) => {
    return res
      .status(404)
      .json({
        success: false,

        message:
          "Route not found",

        path:
          req.originalUrl,

        method:
          req.method,
      });
  }
);

/* ======================================================
 * GLOBAL ERROR HANDLER
 * ====================================================== */

app.use(
  (
    err,
    req,
    res,
    next
  ) => {
    console.error(
      "[server] unhandled error:",
      err
    );

    if (
      res.headersSent
    ) {
      return next(err);
    }

    return res
      .status(500)
      .json({
        success: false,

        message:
          "Internal server error",
      });
  }
);

/* ======================================================
 * START SERVER
 * ====================================================== */

app.listen(
  PORT,
  () => {
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

    console.log(
      "Event payment routes: ENABLED"
    );

    console.log(
      "POST /api/payment/create-event-order"
    );

    console.log(
      "POST /api/payment/confirm-event-booking"
    );
  }
);
