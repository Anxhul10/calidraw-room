import { Router, Request, Response } from "express";
import { Server as SocketIO } from "socket.io";
import { negotiationRepository } from "../db/negotiationRepository";
import {
  createPaypalInvoice,
  sendPaypalInvoice,
  getPaypalInvoice,
  verifyWebhookSignature,
  runPaypalDiagnostics,
} from "../services/paypalService";

export function createNegotiationRoutes(io: SocketIO): Router {
  const router = Router();

  /**
   * GET /diagnostics (or /api/paypal/diagnostics)
   * Protected diagnostic endpoint to verify PayPal OAuth, Invoicing, and API permissions.
   */
  router.get("/diagnostics", async (req: Request, res: Response) => {
    try {
      const adminKey = (
        req.headers["x-admin-key"] ||
        req.query.adminKey ||
        req.query.key ||
        ""
      ).toString();

      const configuredKey = (
        process.env.ADMIN_DIAGNOSTIC_KEY ||
        process.env.PAYPAL_DIAGNOSTIC_SECRET ||
        ""
      ).trim();

      // Protected access: in production, require configured key
      if (process.env.NODE_ENV === "production" && !configuredKey) {
        return res.status(403).json({
          success: false,
          error: "Diagnostics disabled: Configure ADMIN_DIAGNOSTIC_KEY in server environment.",
        });
      }

      if (configuredKey && adminKey !== configuredKey) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized: Invalid or missing diagnostic secret key.",
        });
      }

      const report = await runPaypalDiagnostics();
      const statusCode = report.overallStatus === "FAILED" ? 502 : 200;
      return res.status(statusCode).json({
        success: report.overallStatus !== "FAILED",
        ...report,
      });
    } catch (err: any) {
      console.error("[PayPal Diagnostics Error]", err);
      return res.status(500).json({ success: false, error: err.message || "Diagnostic test error" });
    }
  });

  /**
   * GET /api/negotiation/:roomId
   * Fetch latest negotiation state for a collaboration room (e.g. for reconnects/late joiners)
   */
  router.get("/:roomId", (req: Request, res: Response) => {
    const { roomId } = req.params;
    const negotiation = negotiationRepository.getLatestByRoomId(roomId);
    if (!negotiation) {
      return res.status(404).json({ success: false, error: "No negotiation found for this room" });
    }
    return res.json({ success: true, negotiation });
  });

  /**
   * POST /api/negotiation/:negotiationId/create-invoice
   * Host creates a PayPal invoice for an AGREED negotiation.
   */
  router.post("/:negotiationId/create-invoice", async (req: Request, res: Response) => {
    try {
      const { negotiationId } = req.params;
      const {
        sellerName,
        sellerEmail,
        invoicerEmail,
        customerEmail,
        customerName,
        note,
        senderSocketId,
      } = req.body;

      const negotiation = negotiationRepository.get(negotiationId);
      if (!negotiation) {
        return res.status(404).json({ success: false, error: "Negotiation not found" });
      }

      // If an invoice has already been created for this negotiation, return it idempotently
      if (negotiation.invoice && negotiation.invoice.paypalInvoiceId) {
        return res.status(200).json({
          success: true,
          message: "Invoice already created for this negotiation.",
          invoice: negotiation.invoice,
          negotiation,
        });
      }

      if (negotiation.status !== "AGREED") {
        return res.status(400).json({
          success: false,
          error: `Cannot create invoice for negotiation in status ${negotiation.status}. Deal must be AGREED.`,
        });
      }

      // Check host authorization if socketId provided
      if (senderSocketId && negotiation.hostSocketId && senderSocketId !== negotiation.hostSocketId) {
        return res.status(403).json({ success: false, error: "Only the host can create the invoice" });
      }

      // Latest offer contains the agreed items and amount
      const agreedOffer = negotiation.offers.find((o) => o.status === "ACCEPTED") ||
        negotiation.offers[negotiation.offers.length - 1];

      if (!agreedOffer || !Array.isArray(agreedOffer.items) || agreedOffer.items.length === 0) {
        return res.status(400).json({ success: false, error: "No agreed line items found" });
      }

      const allowMock = process.env.PAYPAL_MOCK === "true" || process.env.ALLOW_MOCK_PAYPAL === "true";
      let paypalResult;

      try {
        paypalResult = await createPaypalInvoice({
          sellerName: sellerName || negotiation.hostName || "Host Seller",
          sellerEmail: sellerEmail || invoicerEmail,
          invoicerEmail: invoicerEmail || sellerEmail,
          customerName: customerName || negotiation.collaboratorName || "Collaborator",
          customerEmail: customerEmail || "buyer@example.com",
          currency: agreedOffer.currency || negotiation.currency || "USD",
          items: agreedOffer.items.map((it) => ({
            description: it.description,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
          })),
          note,
        });
      } catch (paypalErr: any) {
        if (allowMock) {
          console.warn(`[PayPal Mock] Using mock invoice for local testing (PAYPAL_MOCK=true): ${paypalErr.message}`);
          const randomId = `INV2-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
          paypalResult = {
            paypalInvoiceId: randomId,
            status: "DRAFT",
            invoiceNumber: `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
            recipientViewUrl: null,
            payerViewUrl: null,
            invoicerViewUrl: null,
            raw: { id: randomId },
          };
        } else {
          console.error(
            `[PayPal Invoice Error] Failed to create invoice for negotiation ${negotiationId}:`,
            paypalErr.message,
            paypalErr.debugId ? `(DebugID: ${paypalErr.debugId})` : ""
          );
          const statusCode =
            typeof paypalErr.status === "number" && paypalErr.status >= 400 && paypalErr.status < 600
              ? paypalErr.status
              : 502;
          return res.status(statusCode).json({
            success: false,
            error: paypalErr.message || "Failed to create PayPal invoice",
            name: paypalErr.name || "PAYPAL_ERROR",
            debugId: paypalErr.debugId || null,
            details: paypalErr.details || null,
          });
        }
      }

      if (!paypalResult.paypalInvoiceId) {
        return res.status(502).json({
          success: false,
          error: "PayPal invoice was created, but no valid invoice ID could be determined from the response.",
        });
      }

      negotiation.status = "INVOICE_CREATED";
      negotiation.invoice = {
        negotiationId: negotiation.negotiationId,
        roomId: negotiation.roomId,
        paypalInvoiceId: paypalResult.paypalInvoiceId,
        invoiceNumber: paypalResult.invoiceNumber,
        status: paypalResult.status || "DRAFT",
        invoiceStatus: paypalResult.status || "DRAFT",
        recipientViewUrl: paypalResult.recipientViewUrl || paypalResult.payerViewUrl || null,
        payerViewUrl: paypalResult.payerViewUrl || paypalResult.recipientViewUrl || null,
        invoicerViewUrl: paypalResult.invoicerViewUrl || null,
        amount: agreedOffer.amount,
        currency: agreedOffer.currency,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      negotiationRepository.update(negotiation);

      // Broadcast to room
      io.in(negotiation.roomId).emit("payment:invoice-created", {
        negotiationId: negotiation.negotiationId,
        invoice: negotiation.invoice,
        negotiation,
      });

      return res.status(201).json({
        success: true,
        invoice: negotiation.invoice,
        negotiation,
      });
    } catch (err: any) {
      console.error("Create invoice error:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to create invoice" });
    }
  });

  /**
   * POST /api/negotiation/:negotiationId/send-invoice
   * Host sends the created invoice to the collaborator.
   * If a draft invoice already exists, it sends that draft.
   * If no invoice exists yet, it creates the draft invoice first, persists it, and then sends it.
   */
  router.post("/:negotiationId/send-invoice", async (req: Request, res: Response) => {
    try {
      const { negotiationId } = req.params;
      const { senderSocketId } = req.body;

      const negotiation = negotiationRepository.get(negotiationId);
      if (!negotiation) {
        return res.status(404).json({ success: false, error: "Negotiation not found" });
      }

      if (senderSocketId && negotiation.hostSocketId && senderSocketId !== negotiation.hostSocketId) {
        return res.status(403).json({ success: false, error: "Only the host can send the invoice" });
      }

      const allowMock = process.env.PAYPAL_MOCK === "true" || process.env.ALLOW_MOCK_PAYPAL === "true";

      // If no invoice was created yet, but deal is AGREED, create the draft invoice first!
      if (!negotiation.invoice || !negotiation.invoice.paypalInvoiceId) {
        if (negotiation.status !== "AGREED") {
          return res.status(400).json({
            success: false,
            error: `Cannot send invoice: Deal is in status ${negotiation.status} and no invoice was created yet. Deal must be AGREED.`,
          });
        }

        const agreedOffer = negotiation.offers.find((o) => o.status === "ACCEPTED") ||
          negotiation.offers[negotiation.offers.length - 1];

        if (!agreedOffer || !Array.isArray(agreedOffer.items) || agreedOffer.items.length === 0) {
          return res.status(400).json({ success: false, error: "No agreed line items found to create invoice" });
        }

        console.info(`[Negotiation] Creating draft invoice on-demand for ${negotiationId} before sending...`);

        let draftResult;
        try {
          draftResult = await createPaypalInvoice({
            sellerName: negotiation.hostName || "Host Seller",
            customerName: negotiation.collaboratorName || "Collaborator",
            customerEmail: "buyer@example.com",
            currency: agreedOffer.currency || negotiation.currency || "USD",
            items: agreedOffer.items.map((it) => ({
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
            })),
          });
        } catch (createErr: any) {
          if (allowMock) {
            const randomId = `INV2-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
            draftResult = {
              paypalInvoiceId: randomId,
              status: "DRAFT",
              invoiceNumber: `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
              recipientViewUrl: null,
              payerViewUrl: null,
              invoicerViewUrl: null,
              raw: { id: randomId },
            };
          } else {
            console.error(`[PayPal Error] Failed to create draft invoice on send:`, createErr.message);
            const statusCode =
              typeof createErr.status === "number" && createErr.status >= 400 && createErr.status < 600
                ? createErr.status
                : 502;
            return res.status(statusCode).json({
              success: false,
              error: `Failed to create draft invoice: ${createErr.message}`,
              name: createErr.name || "PAYPAL_ERROR",
              debugId: createErr.debugId || null,
            });
          }
        }

        negotiation.status = "INVOICE_CREATED";
        negotiation.invoice = {
          negotiationId: negotiation.negotiationId,
          roomId: negotiation.roomId,
          paypalInvoiceId: draftResult.paypalInvoiceId,
          invoiceNumber: draftResult.invoiceNumber,
          status: draftResult.status || "DRAFT",
          invoiceStatus: draftResult.status || "DRAFT",
          recipientViewUrl: draftResult.recipientViewUrl || draftResult.payerViewUrl || null,
          payerViewUrl: draftResult.payerViewUrl || draftResult.recipientViewUrl || null,
          invoicerViewUrl: draftResult.invoicerViewUrl || null,
          amount: agreedOffer.amount,
          currency: agreedOffer.currency,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        negotiationRepository.update(negotiation);
      }

      // Safe send: Re-use the existing draft invoice ID (NO DUPLICATES)
      const invoiceIdToSend = negotiation.invoice.paypalInvoiceId;
      let sendResult;

      try {
        sendResult = await sendPaypalInvoice(invoiceIdToSend);
      } catch (paypalErr: any) {
        if (allowMock) {
          console.warn(`[PayPal Mock] Using fallback URL for local testing (PAYPAL_MOCK=true): ${paypalErr.message}`);
          sendResult = {
            paypalInvoiceId: invoiceIdToSend,
            status: "SENT",
            recipientViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${invoiceIdToSend}`,
            payerViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${invoiceIdToSend}`,
            invoicerViewUrl: null,
          };
        } else {
          console.error(
            `[PayPal Send Error] Draft invoice ${invoiceIdToSend} exists, but sending failed:`,
            paypalErr.message,
            paypalErr.debugId ? `(DebugID: ${paypalErr.debugId})` : ""
          );
          // Draft invoice is preserved in DRAFT state so user can safely retry sending
          const statusCode =
            typeof paypalErr.status === "number" && paypalErr.status >= 400 && paypalErr.status < 600
              ? paypalErr.status
              : 502;
          return res.status(statusCode).json({
            success: false,
            error: `Draft invoice ${invoiceIdToSend} was created, but sending failed: ${paypalErr.message}. You can safely retry sending.`,
            name: paypalErr.name || "PAYPAL_SEND_ERROR",
            debugId: paypalErr.debugId || null,
            invoice: negotiation.invoice,
            canRetry: true,
          });
        }
      }

      const effectivePayerUrl = sendResult.payerViewUrl || sendResult.recipientViewUrl;
      if (!effectivePayerUrl && !allowMock) {
        return res.status(502).json({
          success: false,
          error: "PayPal invoice was sent, but PayPal did not return a valid payer-facing view URL.",
          invoice: negotiation.invoice,
        });
      }

      negotiation.status = "PAYMENT_PENDING";
      negotiation.invoice.status = sendResult.status || "SENT";
      negotiation.invoice.invoiceStatus = sendResult.status || "SENT";
      negotiation.invoice.recipientViewUrl = effectivePayerUrl;
      negotiation.invoice.payerViewUrl = effectivePayerUrl;
      negotiation.invoice.invoicerViewUrl = sendResult.invoicerViewUrl || negotiation.invoice.invoicerViewUrl || null;
      negotiation.invoice.updatedAt = new Date().toISOString();

      negotiationRepository.update(negotiation);

      // Broadcast to room
      io.in(negotiation.roomId).emit("payment:invoice-sent", {
        negotiationId: negotiation.negotiationId,
        invoice: negotiation.invoice,
        negotiation,
      });

      return res.json({
        success: true,
        invoice: negotiation.invoice,
        negotiation,
      });
    } catch (err: any) {
      console.error("Send invoice error:", err);
      return res.status(500).json({ success: false, error: err.message || "Failed to send invoice" });
    }
  });

  /**
   * POST /api/paypal/webhook
   * Listens for PayPal Invoicing and Payment Webhook events.
   */
  router.post("/webhook", async (req: Request, res: Response) => {
    try {
      const headers = req.headers;
      const event = req.body;

      console.log("[PayPal Webhook] Received event:", event?.event_type, event?.id);

      if (!event || !event.event_type) {
        return res.status(400).send("Invalid event payload");
      }

      // Verify webhook signature
      const authAlgo = String(headers["paypal-auth-algo"] || "");
      const certUrl = String(headers["paypal-cert-url"] || "");
      const transmissionId = String(headers["paypal-transmission-id"] || "");
      const transmissionSig = String(headers["paypal-transmission-sig"] || "");
      const transmissionTime = String(headers["paypal-transmission-time"] || "");
      const webhookId = process.env.PAYPAL_WEBHOOK_ID || "";

      if (authAlgo && certUrl && transmissionSig && webhookId) {
        const isValid = await verifyWebhookSignature({
          authAlgo,
          certUrl,
          transmissionId,
          transmissionSig,
          transmissionTime,
          webhookId,
          webhookEvent: event,
        });

        if (!isValid) {
          console.warn("[PayPal Webhook] Signature verification failed!");
          return res.status(401).send("Invalid signature");
        }
      }

      const eventType = event.event_type;
      const resource = event.resource || {};
      const invoiceId = resource.invoice?.id || resource.id;

      if (!invoiceId) {
        return res.status(200).send("Ignored: no invoice ID found");
      }

      const negotiation = negotiationRepository.getByPaypalInvoiceId(invoiceId);
      if (!negotiation) {
        console.info(`[PayPal Webhook] No active negotiation matching invoice ID ${invoiceId}`);
        return res.status(200).send("Ignored: invoice not found in local system");
      }

      // Check for duplicate event (idempotency)
      if (negotiation.payments.some((p) => p.eventId === event.id)) {
        console.info(`[PayPal Webhook] Duplicate event ${event.id} already processed`);
        return res.status(200).send("Already processed");
      }

      let paymentStatus = "PAID";
      let amountReceived = negotiation.agreedAmount || 0;
      let currency = negotiation.currency || "USD";

      if (resource.amount?.value) {
        amountReceived = parseFloat(resource.amount.value);
      }
      if (resource.amount?.currency_code) {
        currency = resource.amount.currency_code;
      }

      if (eventType.includes("PARTIALLY_PAID") || resource.status === "PARTIALLY_PAID") {
        paymentStatus = "PARTIALLY_PAID";
      } else if (eventType.includes("PAID") || resource.status === "PAID") {
        paymentStatus = "PAID";
      } else if (eventType.includes("CANCELLED") || resource.status === "CANCELLED") {
        paymentStatus = "CANCELLED";
      } else {
        paymentStatus = resource.status || "PAID";
      }

      // Update negotiation record
      const paymentRecord = {
        eventId: event.id,
        paypalInvoiceId: invoiceId,
        status: paymentStatus,
        amountReceived,
        currency,
        verifiedAt: new Date().toISOString(),
      };

      negotiation.payments.push(paymentRecord);
      negotiation.status = paymentStatus as any;
      if (negotiation.invoice) {
        negotiation.invoice.status = paymentStatus;
        if (paymentStatus === "PAID") {
          negotiation.invoice.paidAt = new Date().toISOString();
        }
      }

      negotiationRepository.update(negotiation);

      // Broadcast PAID stamp event to all clients in the collaboration room!
      io.in(negotiation.roomId).emit("payment:paid", {
        negotiationId: negotiation.negotiationId,
        roomId: negotiation.roomId,
        selectedElementIds: negotiation.selectedElementIds,
        status: paymentStatus,
        amountPaid: amountReceived,
        currency,
        invoiceNumber: negotiation.invoice?.invoiceNumber || invoiceId,
        paymentTime: paymentRecord.verifiedAt,
      });

      console.log(`[PayPal Webhook] Broadcasted ${paymentStatus} to room ${negotiation.roomId}`);
      return res.status(200).send("Webhook handled successfully");
    } catch (err: any) {
      console.error("[PayPal Webhook Error]", err);
      return res.status(500).send("Webhook processing error");
    }
  });

  return router;
}
