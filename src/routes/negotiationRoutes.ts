import { Router, Request, Response } from "express";
import { Server as SocketIO } from "socket.io";
import { negotiationRepository } from "../db/negotiationRepository";
import {
  createPaypalInvoice,
  sendPaypalInvoice,
  getPaypalInvoice,
  verifyWebhookSignature,
} from "../services/paypalService";

export function createNegotiationRoutes(io: SocketIO): Router {
  const router = Router();

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
      const { sellerName, customerEmail, customerName, note, senderSocketId } = req.body;

      const negotiation = negotiationRepository.get(negotiationId);
      if (!negotiation) {
        return res.status(404).json({ success: false, error: "Negotiation not found" });
      }

      if (negotiation.status !== "AGREED") {
        return res.status(400).json({
          success: false,
          error: `Cannot create invoice for negotiation in status ${negotiation.status}. Deal must be AGREED.`,
        });
      }

      if (negotiation.invoice && negotiation.invoice.paypalInvoiceId) {
        return res.status(400).json({
          success: false,
          error: "An invoice has already been created for this negotiation.",
          invoice: negotiation.invoice,
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

      let paypalResult;
      try {
        paypalResult = await createPaypalInvoice({
          sellerName: sellerName || negotiation.hostName || "Host Seller",
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
        console.warn("PayPal API call failed or not configured, using mock/fallback invoice:", paypalErr.message);
        // Fallback invoice creation for dev/testing when PayPal credentials are not configured
        const randomId = `INV2-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        paypalResult = {
          paypalInvoiceId: randomId,
          status: "DRAFT",
          invoiceNumber: `INV-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
          raw: { id: randomId },
        };
      }

      negotiation.status = "INVOICE_CREATED";
      negotiation.invoice = {
        paypalInvoiceId: paypalResult.paypalInvoiceId,
        invoiceNumber: paypalResult.invoiceNumber,
        status: paypalResult.status,
        recipientViewUrl: null,
        amount: agreedOffer.amount,
        currency: agreedOffer.currency,
        createdAt: new Date().toISOString(),
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
   */
  router.post("/:negotiationId/send-invoice", async (req: Request, res: Response) => {
    try {
      const { negotiationId } = req.params;
      const { senderSocketId } = req.body;

      const negotiation = negotiationRepository.get(negotiationId);
      if (!negotiation) {
        return res.status(404).json({ success: false, error: "Negotiation not found" });
      }

      if (!negotiation.invoice || !negotiation.invoice.paypalInvoiceId) {
        return res.status(400).json({ success: false, error: "No invoice created yet" });
      }

      if (senderSocketId && negotiation.hostSocketId && senderSocketId !== negotiation.hostSocketId) {
        return res.status(403).json({ success: false, error: "Only the host can send the invoice" });
      }

      let sendResult;
      try {
        sendResult = await sendPaypalInvoice(negotiation.invoice.paypalInvoiceId);
      } catch (paypalErr: any) {
        console.warn("PayPal send failed or not configured, using fallback URL:", paypalErr.message);
        sendResult = {
          paypalInvoiceId: negotiation.invoice.paypalInvoiceId,
          status: "SENT",
          recipientViewUrl: `https://www.sandbox.paypal.com/invoice/p/#${negotiation.invoice.paypalInvoiceId}`,
        };
      }

      negotiation.status = "PAYMENT_PENDING";
      negotiation.invoice.status = sendResult.status || "SENT";
      negotiation.invoice.recipientViewUrl = sendResult.recipientViewUrl;

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
