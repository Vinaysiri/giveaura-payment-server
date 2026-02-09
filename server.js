require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");

const app = express();

/* ======================================================
 * FIREBASE ADMIN INIT
 * ====================================================== */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

/* ======================================================
 * BASIC MIDDLEWARE
 * - Keep raw body ONLY for Razorpay webhook
 * ====================================================== */
app.use((req, res, next) => {
  if (req.originalUrl === "/api/webhooks/razorpay") {
    next();
  } else {
    express.json({ limit: "1mb" })(req, res, next);
  }
});

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
 * CREATE ORDER (DONATION / EVENT)
 * ====================================================== */
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const {
      amount,
      purpose = "donation", // donation | event
      campaignId = null,
      meta = {},
    } = req.body || {};

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    if (!["donation", "event"].includes(purpose)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid purpose" });
    }

    if (purpose === "donation" && !campaignId) {
      return res.status(400).json({
        success: false,
        message: "campaignId required for donation",
      });
    }

    if (
      !process.env.RAZORPAY_KEY_ID ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      return res
        .status(500)
        .json({ success: false, message: "Payment not configured" });
    }

    const order = await razorpay.orders.create({
      amount: Math.round(numericAmount * 100),
      currency: "INR",
      payment_capture: 1,
      notes: {
        purpose,
        ...(campaignId ? { campaignId } : {}),
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
    return res
      .status(500)
      .json({ success: false, message: "Order creation failed" });
  }
});

/* ======================================================
 * RAZORPAY WEBHOOK
 * ====================================================== */
app.post(
  "/api/webhooks/razorpay",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
        console.error("❌ RAZORPAY_WEBHOOK_SECRET missing");
        return res.status(500).send("Server misconfigured");
      }

      const signature = req.headers["x-razorpay-signature"];
      const body = req.body.toString();

      const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(body)
        .digest("hex");

      if (expectedSignature !== signature) {
        console.error("❌ Invalid Razorpay webhook signature");
        return res.status(400).send("Invalid signature");
      }

      const payload = JSON.parse(body);

      if (payload.event !== "payment.captured") {
        return res.status(200).send("Ignored");
      }

      const payment = payload.payload.payment.entity;
      const notes = payment.notes || {};

      /* ===============================
         DONATION CONFIRMATION
      =============================== */
      if (notes.purpose === "donation" && notes.campaignId) {
        const existing = await db
          .collection("donations")
          .where("paymentId", "==", payment.id)
          .limit(1)
          .get();

        if (existing.empty) {
          await db.collection("donations").add({
            campaignId: notes.campaignId,
            amount: payment.amount / 100,
            paymentId: payment.id,
            orderId: payment.order_id,
            source: "razorpay",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          await db.collection("campaigns").doc(notes.campaignId).update({
            totalRaised: admin.firestore.FieldValue.increment(
              payment.amount / 100
            ),
          });

          console.log("✅ Donation recorded:", payment.id);
        }
      }

      /* ===============================
         EVENT BOOKING CONFIRMATION
      =============================== */
      if (notes.source === "event_booking" && notes.bookingId) {
        const bookingRef = db
          .collection("event_bookings")
          .doc(notes.bookingId);

        const bookingSnap = await bookingRef.get();
        if (!bookingSnap.exists) {
          return res.status(200).send("Booking not found");
        }

        const booking = bookingSnap.data();
        if (booking.status === "confirmed") {
          return res.status(200).send("Already confirmed");
        }

        await bookingRef.update({
          status: "confirmed",
          isPaid: true,
          paymentId: payment.id,
          confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (booking.eventId && booking.seats) {
          await db.collection("events").doc(booking.eventId).update({
            seatsSold: admin.firestore.FieldValue.increment(booking.seats),
          });
        }

        console.log("✅ Event booking confirmed:", notes.bookingId);
      }

      if (!notes.purpose && !notes.source) {
        console.warn("⚠️ Payment without purpose/source:", payment.id);
      }

      return res.status(200).send("OK");
    } catch (err) {
      console.error("❌ Razorpay webhook error:", err);
      return res.status(500).send("Webhook failed");
    }
  }
);

/* ======================================================
 * VERIFY SIGNATURE (OPTIONAL UI USE)
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
