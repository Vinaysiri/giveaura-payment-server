require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

const app = express();

/* =====================================================
 * CONFIG
 * ====================================================== */

const PORT = Number(
  process.env.PORT || 5000
);

const NODE_ENV =
  process.env.NODE_ENV ||
  "development";

const IS_PRODUCTION =
  NODE_ENV === "production";

const ALLOWED_ORIGINS = [
  "https://fundraiser-donations.web.app",
  "https://fundraiser-donations.firebaseapp.com",
  "https://giveaura.life",
  "https://www.giveaura.life",

  ...(IS_PRODUCTION
    ? []
    : [
        "http://localhost:5173",
        "http://localhost:3000",
      ]),
];

const ALLOWED_PURPOSES =
  new Set([
    "donation",
    "boost",
    "subscription",
    "giveaura-ad",
  ]);

const MIN_PAYMENT_AMOUNT_INR = 1;

const MAX_PAYMENT_AMOUNT_INR =
  10000000;

const MAX_EVENT_TICKETS_PER_ORDER =
  10;


/* ======================================================
 * DONOR SUPPORT CONFIGURATION
 *
 * Percentage options:
 * 5%
 * 12%
 * 18%
 *
 * Other:
 * fixed amount
 * default ₹45
 * ====================================================== */

const DONOR_SUPPORT_TYPES =
  Object.freeze({
    PERCENT: "percent",
    FIXED: "fixed",
  });

const DONOR_SUPPORT_PERCENTAGES = [
  5,
  12,
  18,
];

const DEFAULT_DONOR_SUPPORT_PERCENT = 18;

const DEFAULT_OTHER_SUPPORT_AMOUNT = 45;


/* ======================================================
 * CATEGORY FEE CONFIGURATION
 *
 * Category fee is deducted from the donation amount.
 * It is NOT deducted from donor support.
 * ====================================================== */

const CATEGORY_FEE_PERCENT_BY_TYPE =
  Object.freeze({
    medical: 0,
    healthcare: 0,
    health: 0,

    disaster: 2,
    emergency: 2,
    "disaster-relief": 2,
    "emergency-relief": 2,

    education: 10,
    personal: 10,

    women: 5,
    "women-welfare": 5,
    child: 5,
    "child-welfare": 5,
    "women-child-welfare": 5,

    animal: 3,
    "animal-welfare": 3,

    ngo: 2,
    trust: 2,
    csr: 2,

    other: 0,
  });


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

  if (req.method === "OPTIONS") {
    if (
      origin &&
      !ALLOWED_ORIGINS.includes(origin)
    ) {
      return res.sendStatus(403);
    }

    return res.sendStatus(204);
  }

  if (
    origin &&
    !ALLOWED_ORIGINS.includes(origin)
  ) {
    return res.status(403).json({
      success: false,
      message:
        "Origin not allowed",
    });
  }

  next();
});


/* ======================================================
 * ENVIRONMENT VALIDATION
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
    !process.env.RAZORPAY_KEY_SECRET
  ) {
    missing.push(
      "RAZORPAY_KEY_SECRET"
    );
  }

  if (missing.length > 0) {
    console.error(
      `[startup] Missing Razorpay environment variables: ${missing.join(
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
 * RAZORPAY INITIALIZATION
 * ====================================================== */

let razorpay = null;

if (razorpayConfigured) {
  try {
    razorpay = new Razorpay({
      key_id:
        process.env
          .RAZORPAY_KEY_ID,

      key_secret:
        process.env
          .RAZORPAY_KEY_SECRET,
    });

    console.info(
      "[startup] Razorpay client initialized"
    );
  } catch (error) {
    razorpay = null;

    console.error(
      "[startup] Razorpay initialization failed:",
      error
    );
  }
}


/* ======================================================
 * FIREBASE ADMIN INITIALIZATION
 * ====================================================== */

let firebaseAdminApp = null;
let adminDb = null;

try {
  if (!admin.apps.length) {
    if (
      process.env
        .FIREBASE_SERVICE_ACCOUNT_JSON
    ) {
      const serviceAccount =
        JSON.parse(
          process.env
            .FIREBASE_SERVICE_ACCOUNT_JSON
        );

      admin.initializeApp({
        credential:
          admin.credential.cert(
            serviceAccount
          ),
      });
    } else {
      admin.initializeApp({
        credential:
          admin.credential
            .applicationDefault(),
      });
    }
  }

  firebaseAdminApp =
    admin.app();

  adminDb =
    admin.firestore();

  console.info(
    "[startup] Firebase Admin initialized"
  );
} catch (error) {
  console.error(
    "[startup] Firebase Admin initialization failed:",
    error
  );
}


/* ======================================================
 * STRING / NUMBER HELPERS
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


function normalizePurpose(value) {
  return String(
    value || "donation"
  )
    .trim()
    .toLowerCase();
}


function normalizeAmount(value) {
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


function normalizeQuantity(value) {
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
    quantity >
      MAX_EVENT_TICKETS_PER_ORDER
  ) {
    return null;
  }

  return quantity;
}


function toPaise(amountInRupees) {
  return Math.round(
    Number(amountInRupees) *
      100
  );
}


function fromPaise(amountInPaise) {
  return (
    Math.round(
      Number(amountInPaise)
    ) / 100
  );
}


function roundMoney(value) {
  return (
    Math.round(
      Number(value) * 100
    ) / 100
  );
}


/* ======================================================
 * DONOR SUPPORT HELPERS
 * ====================================================== */

function normalizeSupportType(
  value
) {
  const normalized =
    String(
      value ||
        DONOR_SUPPORT_TYPES.PERCENT
    )
      .trim()
      .toLowerCase();

  if (
    normalized ===
    DONOR_SUPPORT_TYPES.FIXED
  ) {
    return DONOR_SUPPORT_TYPES.FIXED;
  }

  return DONOR_SUPPORT_TYPES.PERCENT;
}


function normalizeSupportPercent(
  value
) {
  const numeric =
    Number(value);

  if (
    DONOR_SUPPORT_PERCENTAGES.includes(
      numeric
    )
  ) {
    return numeric;
  }

  return DEFAULT_DONOR_SUPPORT_PERCENT;
}


function normalizeNonNegativeMoney(
  value,
  fieldName = "Amount"
) {
  const numeric =
    Number(value);

  if (
    !Number.isFinite(numeric) ||
    numeric < 0
  ) {
    throw new Error(
      `${fieldName} must be zero or greater`
    );
  }

  return roundMoney(numeric);
}


/* ======================================================
 * CAMPAIGN CATEGORY FEE
 * ====================================================== */

function normalizeCampaignCategory(
  campaign = {}
) {
  const rawCategory =
    campaign.category ||
    campaign.campaignType ||
    campaign.type ||
    campaign.categoryType ||
    "";

  return String(
    rawCategory
  )
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/\s+/g, "-");
}


function getCategoryFeePercent(
  campaign = {}
) {
  const category =
    normalizeCampaignCategory(
      campaign
    );

  if (
    Object.prototype.hasOwnProperty.call(
      CATEGORY_FEE_PERCENT_BY_TYPE,
      category
    )
  ) {
    return CATEGORY_FEE_PERCENT_BY_TYPE[
      category
    ];
  }

  return 0;
}


/* ======================================================
 * DONATION CALCULATION
 *
 * Donation:
 *   ₹1,000
 *
 * 5%:
 *   Support = ₹50
 *   Total = ₹1,050
 *
 * 12%:
 *   Support = ₹120
 *   Total = ₹1,120
 *
 * 18%:
 *   Support = ₹180
 *   Total = ₹1,180
 *
 * Other:
 *   ₹45
 *   Total = ₹1,045
 *
 * Category fee is deducted from donation amount.
 * Donor support is separate.
 * ====================================================== */

function calculateDonationBreakdown({
  baseDonationAmount,
  supportType =
    DONOR_SUPPORT_TYPES.PERCENT,
  supportPercent =
    DEFAULT_DONOR_SUPPORT_PERCENT,
  supportAmount = null,
  campaign,
}) {
  const base =
    roundMoney(
      baseDonationAmount
    );

  if (
    !Number.isFinite(base) ||
    base <= 0
  ) {
    throw new Error(
      "Invalid base donation amount"
    );
  }

  const normalizedSupportType =
    normalizeSupportType(
      supportType
    );

  let donorSupportPercent =
    null;

  let donorSupportAmount =
    0;

  if (
    normalizedSupportType ===
    DONOR_SUPPORT_TYPES.FIXED
  ) {
    const fixedSupport =
      normalizeNonNegativeMoney(
        supportAmount ??
          DEFAULT_OTHER_SUPPORT_AMOUNT,
        "GiveAura support amount"
      );

    donorSupportAmount =
      fixedSupport;
  } else {
    const support =
      Number(
        supportPercent
      );

    if (
      !DONOR_SUPPORT_PERCENTAGES.includes(
        support
      )
    ) {
      throw new Error(
        "Invalid donor support percentage"
      );
    }

    donorSupportPercent =
      support;

    donorSupportAmount =
      roundMoney(
        base *
          (support / 100)
      );
  }

  const categoryFeePercent =
    getCategoryFeePercent(
      campaign
    );

  const categoryFeeAmount =
    roundMoney(
      base *
        (categoryFeePercent / 100)
    );

  /*
   * Category fee comes from the donation.
   *
   * It does NOT come from donor support.
   */

  const beneficiaryNetAmount =
    roundMoney(
      base -
        categoryFeeAmount
    );

  /*
   * Donor pays:
   *
   * Donation + GiveAura support
   */

  const totalPaid =
    roundMoney(
      base +
        donorSupportAmount
    );

  /*
   * GiveAura revenue:
   *
   * Donor support + category fee
   */

  const giveAuraRevenue =
    roundMoney(
      donorSupportAmount +
        categoryFeeAmount
    );

  return {
    baseDonationAmount:
      base,

    supportType:
      normalizedSupportType,

    donorSupportType:
      normalizedSupportType,

    donorSupportPercent:
      donorSupportPercent,

    donorSupportAmount,

    categoryFeePercent,

    categoryFeeAmount,

    beneficiaryNetAmount,

    giveAuraRevenue,

    totalPaid,
  };
}


/* ======================================================
 * NOTES SANITIZER
 * ====================================================== */

function sanitizeNotes(meta = {}) {
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
    "source",
    "campaignTitle",
    "referenceId",
  ];

  for (const key of allowedKeys) {
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
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
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


/* ======================================================
 * SIGNATURE HELPERS
 * ====================================================== */

function safeCompareHex(a, b) {
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
  const secret =
    process.env
      .RAZORPAY_KEY_SECRET;

  if (
    !orderId ||
    !paymentId ||
    !signature ||
    !secret
  ) {
    return false;
  }

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        secret
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


/* ======================================================
 * SERVICE READINESS HELPERS
 * ====================================================== */

function requireRazorpay(res) {
  if (
    !razorpayConfigured ||
    !razorpay
  ) {
    res.status(503).json({
      success: false,

      code:
        "PAYMENT_GATEWAY_UNAVAILABLE",

      message:
        "Payment gateway is temporarily unavailable",
    });

    return false;
  }

  return true;
}


function requireFirebaseAdmin(res) {
  if (
    !firebaseAdminApp ||
    !adminDb
  ) {
    res.status(503).json({
      success: false,

      code:
        "DATABASE_SERVICE_UNAVAILABLE",

      message:
        "Database service is temporarily unavailable",
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
 * AUTH HELPERS
 * ====================================================== */

function getBearerToken(req) {
  const value =
    String(
      req.headers.authorization ||
        ""
    ).trim();

  return value
    .toLowerCase()
    .startsWith("bearer ")
    ? value.slice(7).trim()
    : null;
}


async function getOptionalAuthUser(
  req
) {
  const token =
    getBearerToken(req);

  if (!token) {
    return null;
  }

  if (!firebaseAdminApp) {
    throw new Error(
      "Firebase Admin is not configured"
    );
  }

  return admin
    .auth()
    .verifyIdToken(token);
}


async function requireAuthUser(
  req,
  res
) {
  const token =
    getBearerToken(req);

  if (!token) {
    res.status(401).json({
      success: false,
      message:
        "Authentication required",
    });

    return null;
  }

  if (!firebaseAdminApp) {
    res.status(503).json({
      success: false,
      message:
        "Authentication service unavailable",
    });

    return null;
  }

  try {
    return await admin
      .auth()
      .verifyIdToken(token);
  } catch (error) {
    console.warn(
      "[auth] Invalid Firebase token:",
      error?.code ||
        error?.message
    );

    res.status(401).json({
      success: false,
      message:
        "Invalid or expired authentication",
    });

    return null;
  }
}


/* ======================================================
 * EVENT OWNERSHIP HELPERS
 * ====================================================== */

function normalizeEventOwnerType(
  value
) {
  const normalized =
    String(value || "")
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


function determineEventOwnerType(
  eventData = {}
) {
  for (const value of [
    eventData.creatorType,
    eventData.eventOwnerType,
    eventData.ownerType,
    eventData.organizerType,
    eventData.createdByType,
  ]) {
    if (
      normalizeEventOwnerType(
        value
      ) === "giveaura"
    ) {
      return "giveaura";
    }
  }

  if (
    eventData.isGiveAuraEvent ===
      true ||
    eventData.createdByAdmin ===
      true ||
    eventData.platformOwned ===
      true
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
    roundMoney(grossAmount);

  if (
    eventOwnerType ===
    "giveaura"
  ) {
    return {
      grossAmount: gross,

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
    grossAmount: gross,

    platformFeePercent:
      EXTERNAL_EVENT_PLATFORM_FEE_PERCENT,

    platformAmount,

    organizerAmount,
  };
}


function getEventBookedSeats(
  eventData = {}
) {
  for (const value of [
    eventData.bookedSeats,
    eventData.registeredCount,
    eventData.seatsSold,
    eventData.attendees,
  ]) {
    const numeric =
      Number(value);

    if (
      Number.isFinite(numeric) &&
      numeric >= 0
    ) {
      return Math.floor(
        numeric
      );
    }
  }

  return 0;
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
    const ready =
      Boolean(
        razorpayConfigured &&
          razorpay &&
          firebaseAdminApp &&
          adminDb
      );

    return res
      .status(
        ready ? 200 : 503
      )
      .json({
        ok: ready,

        service:
          "giveaura-payment-server",

        paymentGateway:
          Boolean(
            razorpayConfigured &&
              razorpay
          ),

        database:
          Boolean(adminDb),

        eventBookingRoutes:
          true,

        timestamp:
          new Date().toISOString(),
      });
  }
);


/* ======================================================
 * CREATE GENERIC PAYMENT ORDER
 *
 * Donation orders are calculated server-side.
 *
 * Client sends:
 *
 * donationAmount
 * supportType
 * supportPercent
 * supportAmount
 *
 * Server calculates:
 *
 * donation + support
 *
 * and creates the Razorpay order using
 * the server-calculated total.
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

        donationAmount = null,

        purpose = "donation",

        campaignId = null,

        supportType = null,

        supportPercent = null,

        supportAmount = null,

        meta = {},
      } = req.body || {};

      const normalizedPurpose =
        normalizePurpose(
          purpose
        );

      const normalizedCampaignId =
        normalizeString(
          campaignId,
          200
        );

      if (
        !ALLOWED_PURPOSES.has(
          normalizedPurpose
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid payment purpose",
          });
      }

      if (
        normalizedPurpose ===
          "donation" &&
        !normalizedCampaignId
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "campaignId is required for donation payments",
          });
      }

      if (
        normalizedPurpose ===
          "boost" &&
        !normalizedCampaignId
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "campaignId is required for boost payments",
          });
      }

      let numericAmount =
        normalizeAmount(amount);

      let donationBreakdown =
        null;

      let normalizedDonationAmount =
        null;

      let normalizedSupportType =
        null;

      let normalizedSupportPercent =
        null;

      let normalizedSupportAmount =
        null;

      /* ==================================================
       * DONATION
       *
       * Firestore campaign + support selection determine
       * the authoritative Razorpay amount.
       * ================================================== */

      if (
        normalizedPurpose ===
        "donation"
      ) {
        if (
          !requireFirebaseAdmin(res)
        ) {
          return;
        }

        const metaDonationAmount =
          meta?.donationAmount ??
          meta?.baseDonationAmount ??
          null;

        const metaSupportType =
          meta?.supportType ??
          null;

        const metaSupportPercent =
          meta?.supportPercent ??
          null;

        const metaSupportAmount =
          meta?.supportAmount ??
          null;

        normalizedDonationAmount =
          normalizeAmount(
            donationAmount ??
              metaDonationAmount
          );

        if (
          normalizedDonationAmount ===
            null ||
          normalizedDonationAmount <
            MIN_PAYMENT_AMOUNT_INR ||
          normalizedDonationAmount >
            MAX_PAYMENT_AMOUNT_INR
        ) {
          return res
            .status(400)
            .json({
              success: false,

              message:
                "Invalid donation amount",
            });
        }

        normalizedSupportType =
          normalizeSupportType(
            supportType ??
              metaSupportType ??
              DONOR_SUPPORT_TYPES.PERCENT
          );

        if (
          normalizedSupportType ===
          DONOR_SUPPORT_TYPES.FIXED
        ) {
          normalizedSupportAmount =
            normalizeNonNegativeMoney(
              supportAmount ??
                metaSupportAmount ??
                DEFAULT_OTHER_SUPPORT_AMOUNT,
              "GiveAura support amount"
            );

          normalizedSupportPercent =
            null;
        } else {
          normalizedSupportPercent =
            normalizeSupportPercent(
              supportPercent ??
                metaSupportPercent ??
                DEFAULT_DONOR_SUPPORT_PERCENT
            );

          normalizedSupportAmount =
            null;
        }

        const campaignRef =
          adminDb
            .collection("campaigns")
            .doc(
              normalizedCampaignId
            );

        const campaignSnap =
          await campaignRef.get();

        if (
          !campaignSnap.exists
        ) {
          return res
            .status(404)
            .json({
              success: false,

              message:
                "Campaign not found",
            });
        }

        const campaign =
          campaignSnap.data() ||
          {};

        donationBreakdown =
          calculateDonationBreakdown({
            baseDonationAmount:
              normalizedDonationAmount,

            supportType:
              normalizedSupportType,

            supportPercent:
              normalizedSupportPercent,

            supportAmount:
              normalizedSupportAmount,

            campaign,
          });

        numericAmount =
          donationBreakdown.totalPaid;
      }

      /* ==================================================
       * NON-DONATION PAYMENT
       * ================================================== */

      if (
        normalizedPurpose !==
        "donation"
      ) {
        if (
          numericAmount === null ||
          numericAmount <
            MIN_PAYMENT_AMOUNT_INR ||
          numericAmount >
            MAX_PAYMENT_AMOUNT_INR
        ) {
          return res
            .status(400)
            .json({
              success: false,

              message:
                "Invalid payment amount",
            });
        }
      }

      if (
        numericAmount === null ||
        numericAmount <
          MIN_PAYMENT_AMOUNT_INR ||
        numericAmount >
          MAX_PAYMENT_AMOUNT_INR
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Invalid payment amount",
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

          donationAmount:
            normalizedDonationAmount,

          supportType:
            normalizedSupportType,

          supportPercent:
            normalizedSupportPercent,

          supportAmount:
            normalizedSupportAmount,

          receipt,
        }
      );

      /*
       * IMPORTANT:
       *
       * For donations, trusted accounting values are written
       * explicitly AFTER cleanMeta so the client cannot
       * overwrite them through meta.
       */

      const orderNotes = {
        ...cleanMeta,

        purpose:
          normalizedPurpose,

        ...(normalizedCampaignId
          ? {
              campaignId:
                normalizedCampaignId,
            }
          : {}),
      };

      if (
        normalizedPurpose ===
        "donation"
      ) {
        orderNotes.donationAmount =
          String(
            donationBreakdown
              .baseDonationAmount
          );

        orderNotes.baseDonationAmount =
          String(
            donationBreakdown
              .baseDonationAmount
          );

        orderNotes.supportType =
          donationBreakdown
            .supportType;

        orderNotes.supportPercent =
          donationBreakdown
            .donorSupportPercent ===
          null
            ? ""
            : String(
                donationBreakdown
                  .donorSupportPercent
              );

        orderNotes.supportAmount =
          String(
            donationBreakdown
              .donorSupportAmount
          );

        orderNotes.categoryFeePercent =
          String(
            donationBreakdown
              .categoryFeePercent
          );

        orderNotes.categoryFeeAmount =
          String(
            donationBreakdown
              .categoryFeeAmount
          );

        orderNotes.beneficiaryNetAmount =
          String(
            donationBreakdown
              .beneficiaryNetAmount
          );

        orderNotes.giveAuraRevenue =
          String(
            donationBreakdown
              .giveAuraRevenue
          );

        orderNotes.totalPaid =
          String(
            donationBreakdown
              .totalPaid
          );
      }

      const order =
        await razorpay.orders.create({
          amount:
            amountPaise,

          currency:
            "INR",

          receipt,

          notes:
            orderNotes,
        });

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

          ...(donationBreakdown
            ? {
                breakdown:
                  donationBreakdown,
              }
            : {}),
        });
    } catch (error) {
      console.error(
        "[payment/create-order] error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            error?.message ||
            "Order creation failed",
        });
    }
  }
);


/* ======================================================
 * CREATE EVENT ORDER
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

      if (
        !requireFirebaseAdmin(res)
      ) {
        return;
      }

      const authUser =
        await requireAuthUser(
          req,
          res
        );

      if (!authUser) {
        return;
      }

      const {
        eventId,

        quantity = 1,
      } = req.body || {};

      const normalizedEventId =
        normalizeString(
          eventId,
          200
        );

      const normalizedQuantity =
        normalizeQuantity(
          quantity
        );

      if (!normalizedEventId) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "eventId is required",
          });
      }

      if (!normalizedQuantity) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              `Ticket quantity must be between 1 and ${MAX_EVENT_TICKETS_PER_ORDER}`,
          });
      }

      const eventRef =
        adminDb
          .collection("events")
          .doc(
            normalizedEventId
          );

      const eventSnap =
        await eventRef.get();

      if (!eventSnap.exists) {
        return res
          .status(404)
          .json({
            success: false,

            message:
              "Event not found",
          });
      }

      const eventData =
        eventSnap.data() || {};

      if (
        eventData.bookingEnabled !==
          true ||
        String(
          eventData.ticketType ||
            ""
        )
          .trim()
          .toLowerCase() !==
          "paid"
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Paid booking is not enabled for this event",
          });
      }

      const ticketPrice =
        normalizeAmount(
          eventData.ticketPrice
        );

      if (
        ticketPrice === null ||
        ticketPrice <
          MIN_PAYMENT_AMOUNT_INR
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Event has an invalid ticket price",
          });
      }

      const totalSeats =
        Number(
          eventData.totalSeats ||
            0
        );

      const bookedSeats =
        getEventBookedSeats(
          eventData
        );

      if (
        Number.isFinite(
          totalSeats
        ) &&
        totalSeats > 0 &&
        bookedSeats +
          normalizedQuantity >
          totalSeats
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Not enough seats are available",

            availableSeats:
              Math.max(
                totalSeats -
                  bookedSeats,
                0
              ),
          });
      }

      const grossAmount =
        roundMoney(
          ticketPrice *
            normalizedQuantity
        );

      const eventOwnerType =
        determineEventOwnerType(
          eventData
        );

      const split =
        calculateEventSplit({
          grossAmount,

          eventOwnerType,
        });

      const organizerId =
        normalizeString(
          eventData.organizerId ||
            eventData.creatorId ||
            eventData
              .createdByUid ||
            null,
          200
        );

      const receipt =
        createReceipt("gae");

      const order =
        await razorpay.orders.create({
          amount:
            toPaise(grossAmount),

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
              String(ticketPrice),

            eventOwnerType,

            platformFeePercent:
              String(
                split.platformFeePercent
              ),

            userId:
              authUser.uid,

            ...(organizerId
              ? {
                  organizerId,
                }
              : {}),

            eventTitle:
              String(
                eventData.title ||
                  "GiveAura Event"
              ).slice(
                0,
                200
              ),
          },
        });

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
              eventData.title ||
              null,

            quantity:
              normalizedQuantity,

            ticketPrice,

            ownerType:
              eventOwnerType,
          },

          breakdown: {
            ticketPrice,

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
    } catch (error) {
      console.error(
        "[payment/create-event-order] error:",
        error
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

      if (
        !requireFirebaseAdmin(res)
      ) {
        return;
      }

      const authUser =
        await requireAuthUser(
          req,
          res
        );

      if (!authUser) {
        return;
      }

      const {
        eventId,

        paymentId,

        orderId,

        signature,

        attendee = {},

        quantity:
          requestedQuantity = 1,

        notes:
          attendeeNotes = "",
      } = req.body || {};

      const eid =
        normalizeString(
          eventId,
          200
        );

      const pid =
        normalizeString(
          paymentId,
          200
        );

      const oid =
        normalizeString(
          orderId,
          200
        );

      const sig =
        normalizeString(
          signature,
          500
        );

      if (
        !eid ||
        !pid ||
        !oid ||
        !sig
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "eventId, paymentId, orderId and signature are required",
          });
      }

      const signatureValid =
        verifyRazorpaySignature({
          orderId: oid,

          paymentId: pid,

          signature: sig,
        });

      if (!signatureValid) {
        return res
          .status(401)
          .json({
            success: false,

            valid: false,

            message:
              "Invalid payment signature",
          });
      }

      const [
        payment,
        order,
      ] = await Promise.all([
        razorpay.payments.fetch(
          pid
        ),

        razorpay.orders.fetch(
          oid
        ),
      ]);

      if (
        !payment ||
        !order ||
        String(
          payment.order_id ||
            ""
        ) !== oid
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Payment/order verification failed",
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
        !paymentAmount ||
        paymentAmount !==
          orderAmount ||
        paymentCurrency !==
          "INR" ||
        orderCurrency !==
          "INR" ||
        payment.status !==
          "captured"
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Payment is not a valid captured INR payment for this order",
          });
      }

      const orderNotes =
        order.notes &&
        typeof order.notes ===
          "object"
          ? order.notes
          : {};

      if (
        String(
          orderNotes.purpose ||
            ""
        ) !==
          "event-booking" ||
        String(
          orderNotes.eventId ||
            ""
        ) !== eid
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Order does not match this event booking",
          });
      }

      if (
        orderNotes.userId &&
        String(
          orderNotes.userId
        ) !== authUser.uid
      ) {
        return res
          .status(403)
          .json({
            success: false,

            message:
              "This payment order belongs to another user",
          });
      }

      const quantity =
        normalizeQuantity(
          orderNotes.quantity
        );

      const clientQuantity =
        normalizeQuantity(
          requestedQuantity
        );

      if (
        !quantity ||
        !clientQuantity ||
        quantity !==
          clientQuantity
      ) {
        return res
          .status(409)
          .json({
            success: false,

            message:
              "Ticket quantity mismatch",
          });
      }

      const normalizedAttendee =
        {
          fullName:
            normalizeString(
              attendee?.fullName,
              150
            ) || "",

          email:
            String(
              normalizeString(
                attendee?.email,
                200
              ) || ""
            ).toLowerCase(),

          phone:
            normalizeString(
              attendee?.phone,
              50
            ) || "",
        };

      if (
        !normalizedAttendee.fullName ||
        !normalizedAttendee.email ||
        !normalizedAttendee.phone
      ) {
        return res
          .status(400)
          .json({
            success: false,

            message:
              "Complete attendee details are required",
          });
      }

      const eventRef =
        adminDb
          .collection("events")
          .doc(eid);

      const ledgerRef =
        adminDb
          .collection(
            "paymentLedger"
          )
          .doc(pid);

      const bookingRef =
        adminDb
          .collection(
            "eventBookings"
          )
          .doc();

      const revenueRef =
        adminDb
          .collection(
            "eventRevenue"
          )
          .doc(eid);

      let result = null;

      await adminDb.runTransaction(
        async (tx) => {
          const [
            eventSnap,
            ledgerSnap,
            revenueSnap,
          ] = await Promise.all([
            tx.get(eventRef),

            tx.get(ledgerRef),

            tx.get(revenueRef),
          ]);

          if (ledgerSnap.exists) {
            const existing =
              ledgerSnap.data() ||
              {};

            if (
              existing.purpose !==
                "event-booking" ||
              existing.eventId !==
                eid ||
              existing.userId !==
                authUser.uid
            ) {
              throw new Error(
                "Payment has already been used for another transaction"
              );
            }

            result = {
              alreadyProcessed:
                true,

              bookingId:
                existing.bookingId ||
                null,

              breakdown:
                existing.breakdown ||
                null,
            };

            return;
          }

          if (!eventSnap.exists) {
            throw new Error(
              "Event no longer exists"
            );
          }

          const eventData =
            eventSnap.data() ||
            {};

          if (
            eventData.bookingEnabled !==
              true ||
            String(
              eventData.ticketType ||
                ""
            )
              .trim()
              .toLowerCase() !==
              "paid"
          ) {
            throw new Error(
              "Event booking is no longer available"
            );
          }

          const ticketPrice =
            normalizeAmount(
              eventData.ticketPrice
            );

          if (
            ticketPrice === null ||
            ticketPrice <= 0
          ) {
            throw new Error(
              "Event ticket price is invalid"
            );
          }

          const expectedGross =
            roundMoney(
              ticketPrice *
                quantity
            );

          if (
            toPaise(
              expectedGross
            ) !== paymentAmount
          ) {
            throw new Error(
              "Paid amount does not match current event ticket price"
            );
          }

          const totalSeats =
            Number(
              eventData.totalSeats ||
                0
            );

          const currentBooked =
            getEventBookedSeats(
              eventData
            );

          if (
            Number.isFinite(
              totalSeats
            ) &&
            totalSeats > 0 &&
            currentBooked +
              quantity >
              totalSeats
          ) {
            throw new Error(
              "Not enough seats remain to confirm this booking"
            );
          }

          const eventOwnerType =
            determineEventOwnerType(
              eventData
            );

          const split =
            calculateEventSplit({
              grossAmount:
                fromPaise(
                  paymentAmount
                ),

              eventOwnerType,
            });

          const organizerId =
            normalizeString(
              eventData.organizerId ||
                eventData.creatorId ||
                eventData
                  .createdByUid ||
                orderNotes.organizerId ||
                null,
              200
            );

          const breakdown = {
            ticketPrice,

            quantity,

            grossAmount:
              split.grossAmount,

            eventOwnerType,

            platformCommissionPercent:
              split.platformFeePercent,

            platformCommissionAmount:
              split.platformAmount,

            organizerNetAmount:
              split.organizerAmount,
          };

          const serverTimestamp =
            admin.firestore
              .FieldValue
              .serverTimestamp();

          tx.set(
            bookingRef,
            {
              bookingId:
                bookingRef.id,

              eventId: eid,

              eventTitle:
                eventData.title ||
                orderNotes.eventTitle ||
                null,

              attendee:
                normalizedAttendee,

              quantity,

              ticketPrice,

              grossAmount:
                split.grossAmount,

              currency: "INR",

              userId:
                authUser.uid,

              organizerId:
                organizerId ||
                null,

              eventOwnerType,

              paymentId: pid,

              orderId: oid,

              paymentStatus:
                payment.status,

              bookingStatus:
                "confirmed",

              notes:
                normalizeString(
                  attendeeNotes,
                  500
                ) || "",

              createdAt:
                serverTimestamp,

              updatedAt:
                serverTimestamp,
            }
          );

          tx.set(
            ledgerRef,
            {
              paymentId: pid,

              orderId: oid,

              purpose:
                "event-booking",

              eventId: eid,

              bookingId:
                bookingRef.id,

              userId:
                authUser.uid,

              organizerId:
                organizerId ||
                null,

              amountPaise:
                paymentAmount,

              currency: "INR",

              status:
                "captured",

              breakdown,

              createdAt:
                serverTimestamp,
            }
          );

          const oldRevenue =
            revenueSnap.exists
              ? revenueSnap.data() ||
                {}
              : {};

          tx.set(
            revenueRef,
            {
              eventId: eid,

              eventTitle:
                eventData.title ||
                null,

              eventOwnerType,

              organizerId:
                organizerId ||
                null,

              grossRevenue:
                roundMoney(
                  Number(
                    oldRevenue.grossRevenue ||
                      0
                  ) +
                    split.grossAmount
                ),

              platformRevenue:
                roundMoney(
                  Number(
                    oldRevenue.platformRevenue ||
                      0
                  ) +
                    split.platformAmount
                ),

              organizerPayable:
                roundMoney(
                  Number(
                    oldRevenue.organizerPayable ||
                      0
                  ) +
                    split.organizerAmount
                ),

              ticketsSold:
                Number(
                  oldRevenue.ticketsSold ||
                    0
                ) + quantity,

              bookingCount:
                Number(
                  oldRevenue.bookingCount ||
                    0
                ) + 1,

              updatedAt:
                serverTimestamp,

              ...(!revenueSnap.exists
                ? {
                    createdAt:
                      serverTimestamp,
                  }
                : {}),
            },
            {
              merge: true,
            }
          );

          const newBooked =
            currentBooked +
            quantity;

          tx.update(
            eventRef,
            {
              bookedSeats:
                newBooked,

              registeredCount:
                newBooked,

              attendees:
                newBooked,

              updatedAt:
                serverTimestamp,
            }
          );

          result = {
            alreadyProcessed:
              false,

            bookingId:
              bookingRef.id,

            breakdown,
          };
        }
      );

      return res
        .status(200)
        .json({
          success: true,

          valid: true,

          alreadyProcessed:
            Boolean(
              result?.alreadyProcessed
            ),

          bookingId:
            result?.bookingId ||
            null,

          breakdown:
            result?.breakdown ||
            null,

          message:
            result?.alreadyProcessed
              ? "Booking was already confirmed"
              : "Event booking confirmed successfully",
        });
    } catch (error) {
      console.error(
        "[payment/confirm-event-booking] error:",
        error
      );

      const knownConflictMessages =
        [
          "Event no longer exists",
          "Event booking is no longer available",
          "Event ticket price is invalid",
          "Paid amount does not match current event ticket price",
          "Not enough seats remain to confirm this booking",
          "Payment has already been used for another transaction",
        ];

      const message =
        error?.message ||
        "Event booking confirmation failed";

      const isConflict =
        knownConflictMessages.includes(
          message
        );

      return res
        .status(
          isConflict ? 409 : 500
        )
        .json({
          success: false,

          valid: false,

          message:
            isConflict
              ? message
              : "Event booking confirmation failed",
        });
    }
  }
);


/* ======================================================
 * VERIFY PAYMENT
 *
 * Generic verification only.
 *
 * Does NOT create donation accounting.
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
        return res
          .status(400)
          .json({
            success: false,

            valid: false,

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

      if (!signatureValid) {
        return res
          .status(401)
          .json({
            success: false,

            valid: false,

            message:
              "Invalid payment signature",
          });
      }

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
        return res
          .status(404)
          .json({
            success: false,

            valid: false,

            message:
              "Payment not found",
          });
      }

      if (!order) {
        return res
          .status(404)
          .json({
            success: false,

            valid: false,

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
            success: false,

            valid: false,

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
            success: false,

            valid: false,

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
            success: false,

            valid: false,

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
    } catch (error) {
      console.error(
        "[payment/verify] error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          valid: false,

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
      if (
        !requireRazorpay(res)
      ) {
        return;
      }

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
        return res
          .status(400)
          .json({
            success: false,
            valid: false,
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
          valid ? 200 : 401
        )
        .json({
          success: valid,

          valid,
        });
    } catch (error) {
      console.error(
        "[verify-signature] error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          valid: false,
        });
    }
  }
);


/* ======================================================
 * CONFIRM DONATION
 *
 * Server verifies:
 *
 * 1. Razorpay signature
 * 2. Razorpay payment
 * 3. Razorpay order
 * 4. payment/order relationship
 * 5. captured payment status
 * 6. INR currency
 * 7. donation amount
 * 8. GiveAura support selection
 * 9. campaign existence
 *
 * Then writes:
 *
 * - donations
 * - paymentLedger
 * - campaign fundsRaised
 * - campaign donationCount
 *
 * IMPORTANT:
 *
 * Razorpay ORDER NOTES are the trusted source for:
 *
 * supportType
 * supportPercent
 * supportAmount
 * donationAmount
 * totalPaid
 * ====================================================== */

app.post(
  "/api/payment/confirm-donation",

  async (req, res) => {
    try {
      if (
        !requireRazorpay(res)
      ) {
        return;
      }

      if (
        !requireFirebaseAdmin(res)
      ) {
        return;
      }

      const {
        campaignId,
        paymentId,
        orderId,
        signature,

        donationAmount,

        supportType =
          DONOR_SUPPORT_TYPES.PERCENT,

        supportPercent =
          DEFAULT_DONOR_SUPPORT_PERCENT,

        supportAmount = null,

        donor = {},

        meta = {},
      } = req.body || {};

      const cid =
        normalizeString(
          campaignId,
          200
        );

      const pid =
        normalizeString(
          paymentId,
          200
        );

      const oid =
        normalizeString(
          orderId,
          200
        );

      const sig =
        normalizeString(
          signature,
          500
        );

      const baseDonationAmount =
        normalizeAmount(
          donationAmount
        );

      if (
        !cid ||
        !pid ||
        !oid ||
        !sig ||
        baseDonationAmount ===
          null
      ) {
        return res
          .status(400)
          .json({
            success: false,

            valid: false,

            message:
              "campaignId, paymentId, orderId, signature and donationAmount are required",
          });
      }

      if (
        baseDonationAmount <
          MIN_PAYMENT_AMOUNT_INR ||
        baseDonationAmount >
          MAX_PAYMENT_AMOUNT_INR
      ) {
        return res
          .status(400)
          .json({
            success: false,

            valid: false,

            message:
              "Invalid donation amount",
          });
      }

      /* ==================================================
       * VERIFY RAZORPAY SIGNATURE
       * ================================================== */

      const signatureValid =
        verifyRazorpaySignature({
          orderId: oid,

          paymentId: pid,

          signature: sig,
        });

      if (!signatureValid) {
        return res
          .status(401)
          .json({
            success: false,

            valid: false,

            message:
              "Invalid payment signature",
          });
      }

      /* ==================================================
       * FETCH PAYMENT + ORDER
       * ================================================== */

      const [
        payment,
        order,
      ] = await Promise.all([
        razorpay.payments.fetch(
          pid
        ),

        razorpay.orders.fetch(
          oid
        ),
      ]);

      if (
        !payment ||
        !order ||
        String(
          payment.order_id || ""
        ) !== oid
      ) {
        return res
          .status(409)
          .json({
            success: false,

            valid: false,

            message:
              "Payment/order verification failed",
          });
      }

      /* ==================================================
       * VERIFY PAYMENT
       * ================================================== */

      const paymentAmountPaise =
        Number(
          payment.amount || 0
        );

      const orderAmountPaise =
        Number(
          order.amount || 0
        );

      const paymentCurrency =
        String(
          payment.currency || ""
        ).toUpperCase();

      const orderCurrency =
        String(
          order.currency || ""
        ).toUpperCase();

      if (
        !paymentAmountPaise ||
        paymentAmountPaise !==
          orderAmountPaise ||
        paymentCurrency !==
          "INR" ||
        orderCurrency !==
          "INR" ||
        payment.status !==
          "captured"
      ) {
        return res
          .status(409)
          .json({
            success: false,

            valid: false,

            message:
              "Payment is not a valid captured INR payment for this order",
          });
      }

      /* ==================================================
       * READ RAZORPAY ORDER NOTES
       * ================================================== */

      const orderNotes =
        order.notes &&
        typeof order.notes ===
          "object"
          ? order.notes
          : {};

      if (
        String(
          orderNotes.purpose ||
            ""
        ) !== "donation" ||
        String(
          orderNotes.campaignId ||
            ""
        ) !== cid
      ) {
        return res
          .status(409)
          .json({
            success: false,

            valid: false,

            message:
              "Order does not match this donation campaign",
          });
      }

      /* ==================================================
       * VERIFY DONATION AMOUNT AGAINST ORDER
       *
       * The amount stored in Razorpay notes came from the
       * server when the order was created.
       * ================================================== */

      const trustedDonationAmount =
        normalizeAmount(
          orderNotes.donationAmount ??
            orderNotes.baseDonationAmount
        );

      if (
        trustedDonationAmount ===
          null ||
        trustedDonationAmount !==
          baseDonationAmount
      ) {
        return res
          .status(409)
          .json({
            success: false,

            valid: false,

            message:
              "Donation amount does not match the payment order",
          });
      }

      /* ==================================================
       * TRUST SUPPORT INFORMATION FROM RAZORPAY NOTES
       * ================================================== */

      const trustedSupportType =
        normalizeSupportType(
          orderNotes.supportType ||
            supportType
        );

      let trustedSupportPercent =
        null;

      let trustedSupportAmount =
        null;

      if (
        trustedSupportType ===
        DONOR_SUPPORT_TYPES.FIXED
      ) {
        trustedSupportAmount =
          normalizeNonNegativeMoney(
            orderNotes.supportAmount ??
              supportAmount ??
              DEFAULT_OTHER_SUPPORT_AMOUNT,

            "GiveAura support amount"
          );

        trustedSupportPercent =
          null;
      } else {
        trustedSupportPercent =
          Number(
            orderNotes.supportPercent ??
              supportPercent
          );

        if (
          !DONOR_SUPPORT_PERCENTAGES.includes(
            trustedSupportPercent
          )
        ) {
          return res
            .status(409)
            .json({
              success: false,

              valid: false,

              message:
                "Invalid donor support percentage",
            });
        }

        trustedSupportAmount =
          null;
      }

      /* ==================================================
       * LOAD CAMPAIGN
       * ================================================== */

      const campaignRef =
        adminDb
          .collection("campaigns")
          .doc(cid);

      const campaignSnap =
        await campaignRef.get();

      if (!campaignSnap.exists) {
        return res
          .status(404)
          .json({
            success: false,

            valid: false,

            message:
              "Campaign not found",
          });
      }

      const campaign =
        campaignSnap.data() ||
        {};

      /* ==================================================
       * SERVER-SIDE BREAKDOWN
       * ================================================== */

      const breakdown =
        calculateDonationBreakdown({
          baseDonationAmount,

          supportType:
            trustedSupportType,

          supportPercent:
            trustedSupportPercent,

          supportAmount:
            trustedSupportAmount,

          campaign,
        });

      /* ==================================================
       * VERIFY ACTUAL RAZORPAY TOTAL
       * ================================================== */

      const expectedTotalPaise =
        toPaise(
          breakdown.totalPaid
        );

      if (
        paymentAmountPaise !==
        expectedTotalPaise
      ) {
        return res
          .status(409)
          .json({
            success: false,

            valid: false,

            message:
              "Paid amount does not match the server donation calculation",
          });
      }

      /* ==================================================
       * IDEMPOTENT PAYMENT LEDGER
       * ================================================== */

      const ledgerRef =
        adminDb
          .collection("paymentLedger")
          .doc(pid);

      const existingLedger =
        await ledgerRef.get();

      if (
        existingLedger.exists
      ) {
        const existing =
          existingLedger.data() ||
          {};

        if (
          existing.purpose !==
            "donation" ||
          existing.campaignId !==
            cid
        ) {
          return res
            .status(409)
            .json({
              success: false,

              valid: false,

              message:
                "Payment has already been used for another transaction",
            });
        }

        return res
          .status(200)
          .json({
            success: true,

            valid: true,

            alreadyProcessed:
              true,

            paymentId:
              pid,

            breakdown:
              existing.breakdown ||
              breakdown,

            message:
              "Donation was already confirmed",
          });
      }

      /* ==================================================
       * DONOR DATA
       * ================================================== */

      const normalizedDonor = {
        name:
          normalizeString(
            donor?.name,
            150
          ) || "",

        email:
          String(
            normalizeString(
              donor?.email,
              200
            ) || ""
          ).toLowerCase(),

        phone:
          normalizeString(
            donor?.phone,
            50
          ) || "",
      };

      /* ==================================================
       * DONATION TRANSACTION
       * ================================================== */

      const donationRef =
        adminDb
          .collection("donations")
          .doc();

      const serverTimestamp =
        admin.firestore.FieldValue
          .serverTimestamp();

      await adminDb.runTransaction(
        async (tx) => {
          const [
            freshCampaignSnap,
            freshLedgerSnap,
          ] = await Promise.all([
            tx.get(campaignRef),

            tx.get(ledgerRef),
          ]);

          if (
            freshLedgerSnap.exists
          ) {
            return;
          }

          if (
            !freshCampaignSnap.exists
          ) {
            throw new Error(
              "Campaign not found"
            );
          }

          const freshCampaign =
            freshCampaignSnap.data() ||
            {};

          const freshBreakdown =
            calculateDonationBreakdown({
              baseDonationAmount,

              supportType:
                trustedSupportType,

              supportPercent:
                trustedSupportPercent,

              supportAmount:
                trustedSupportAmount,

              campaign:
                freshCampaign,
            });

          /* ----------------------------------------------
           * CREATE DONATION
           * ---------------------------------------------- */

          tx.set(
            donationRef,
            {
              donationId:
                donationRef.id,

              campaignId:
                cid,

              donor:
                normalizedDonor,

              paymentId:
                pid,

              orderId:
                oid,

              amount:
                freshBreakdown
                  .baseDonationAmount,

              donationAmount:
                freshBreakdown
                  .baseDonationAmount,

              donorSupportType:
                freshBreakdown
                  .supportType,

              supportType:
                freshBreakdown
                  .supportType,

              donorSupportPercent:
                freshBreakdown
                  .donorSupportPercent,

              donorSupportAmount:
                freshBreakdown
                  .donorSupportAmount,

              categoryFeePercent:
                freshBreakdown
                  .categoryFeePercent,

              categoryFeeAmount:
                freshBreakdown
                  .categoryFeeAmount,

              beneficiaryNetAmount:
                freshBreakdown
                  .beneficiaryNetAmount,

              giveAuraRevenue:
                freshBreakdown
                  .giveAuraRevenue,

              totalPaid:
                freshBreakdown
                  .totalPaid,

              currency:
                "INR",

              paymentStatus:
                "captured",

              status:
                "completed",

              createdAt:
                serverTimestamp,

              updatedAt:
                serverTimestamp,

              meta:
                sanitizeNotes(meta),
            }
          );

          /* ----------------------------------------------
           * PAYMENT LEDGER
           * ---------------------------------------------- */

          tx.set(
            ledgerRef,
            {
              paymentId:
                pid,

              orderId:
                oid,

              purpose:
                "donation",

              campaignId:
                cid,

              donationId:
                donationRef.id,

              amountPaise:
                paymentAmountPaise,

              currency:
                "INR",

              status:
                "captured",

              breakdown:
                freshBreakdown,

              createdAt:
                serverTimestamp,
            }
          );

          /* ----------------------------------------------
           * CAMPAIGN FUNDS
           *
           * Only beneficiaryNetAmount is added to the
           * campaign fundsRaised.
           *
           * Donor support is GiveAura support revenue.
           * ---------------------------------------------- */

          const currentFundsRaised =
            Number(
              freshCampaign
                .fundsRaised || 0
            );

          const currentDonationCount =
            Number(
              freshCampaign
                .donationCount || 0
            );

          tx.update(
            campaignRef,
            {
              fundsRaised:
                roundMoney(
                  currentFundsRaised +
                    freshBreakdown
                      .beneficiaryNetAmount
                ),

              donationCount:
                currentDonationCount +
                1,

              updatedAt:
                serverTimestamp,
            }
          );
        }
      );

      return res
        .status(200)
        .json({
          success: true,

          valid: true,

          alreadyProcessed:
            false,

          donationId:
            donationRef.id,

          paymentId:
            pid,

          breakdown,

          message:
            "Donation confirmed successfully",
        });
    } catch (error) {
      console.error(
        "[payment/confirm-donation] error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          valid: false,

          message:
            error?.message ||
            "Donation confirmation failed",
        });
    }
  }
);


/* ======================================================
 * 404
 * ====================================================== */

app.use((req, res) => {
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
});


/* ======================================================
 * GLOBAL ERROR HANDLER
 * ====================================================== */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[server] unhandled error:",
      error
    );

    if (res.headersSent) {
      return next(error);
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
      `Environment: ${NODE_ENV}`
    );

    console.log(
      `Razorpay configured: ${
        razorpayConfigured &&
        razorpay
          ? "YES"
          : "NO"
      }`
    );

    console.log(
      `Firebase Admin configured: ${
        firebaseAdminApp &&
        adminDb
          ? "YES"
          : "NO"
      }`
    );

    console.log(
      "Payment routes:"
    );

    console.log(
      "POST /api/payment/create-order"
    );

    console.log(
      "POST /api/payment/create-event-order"
    );

    console.log(
      "POST /api/payment/confirm-event-booking"
    );

    console.log(
      "POST /api/payment/confirm-donation"
    );

    console.log(
      "POST /api/payment/verify"
    );

    console.log(
      "POST /api/payment/verify-signature"
    );
  }
);
