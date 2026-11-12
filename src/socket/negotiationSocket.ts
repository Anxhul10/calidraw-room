import { Server as SocketIO, Socket } from "socket.io";
import crypto from "crypto";
import {
  negotiationRepository,
  NegotiationRecord,
  NegotiationOffer,
} from "../db/negotiationRepository";

export function setupNegotiationSocketHandlers(io: SocketIO, socket: Socket) {
  /**
   * Helper to generate unique IDs
   */
  const generateId = (prefix: string) =>
    `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

  /**
   * payment:request
   * Host initiates a payment request for selected elements with an initial offer.
   */
  socket.on("payment:request", (payload: {
    roomId: string;
    senderName: string;
    selectedElementIds: string[];
    currency: string;
    items: Array<{
      componentId: string;
      description: string;
      quantity: number;
      unitPrice: number;
      subtotal: number;
    }>;
    message?: string;
  }) => {
    try {
      const { roomId, senderName, selectedElementIds, currency, items, message } = payload;

      if (!roomId || !Array.isArray(items) || items.length === 0) {
        socket.emit("payment:error", { message: "Invalid payment request payload" });
        return;
      }

      // Calculate total securely on server
      let total = 0;
      const sanitizedItems = items.map((it) => {
        const qty = Math.max(1, Number(it.quantity) || 1);
        const price = Math.max(0, Number(it.unitPrice) || 0);
        const sub = Math.round(qty * price * 100) / 100;
        total += sub;
        return {
          componentId: String(it.componentId || ""),
          description: String(it.description || "Deliverable").trim(),
          quantity: qty,
          unitPrice: price,
          subtotal: sub,
        };
      });

      const negotiationId = generateId("neg");
      const offerId = generateId("off");

      const initialOffer: NegotiationOffer = {
        offerId,
        negotiationId,
        senderRole: "host",
        senderSocketId: socket.id,
        senderName: senderName || "Host",
        amount: Math.round(total * 100) / 100,
        currency: currency || "USD",
        items: sanitizedItems,
        message: message || "",
        createdAt: new Date().toISOString(),
        status: "PENDING",
      };

      const record: NegotiationRecord = {
        negotiationId,
        roomId,
        hostSocketId: socket.id,
        hostName: senderName || "Host",
        selectedElementIds: Array.isArray(selectedElementIds) ? selectedElementIds : [],
        currentOfferId: offerId,
        status: "OFFER_REQUESTED",
        currency: currency || "USD",
        offers: [initialOffer],
        payments: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      negotiationRepository.create(record);

      // Broadcast to room
      io.in(roomId).emit("payment:offer", {
        negotiationId,
        offer: initialOffer,
        negotiation: record,
      });

      console.log(`[Negotiation] Created negotiation ${negotiationId} in room ${roomId}`);
    } catch (err: any) {
      console.error("[payment:request error]", err);
      socket.emit("payment:error", { message: err.message || "Failed to create payment request" });
    }
  });

  /**
   * payment:counteroffer
   * Collaborator submits a counter-offer.
   */
  socket.on("payment:counteroffer", (payload: {
    negotiationId: string;
    senderName: string;
    amount: number;
    message?: string;
  }) => {
    try {
      const { negotiationId, senderName, amount, message } = payload;
      const neg = negotiationRepository.get(negotiationId);
      if (!neg) {
        socket.emit("payment:error", { message: "Negotiation not found" });
        return;
      }

      if (neg.status === "ON_HOLD") {
        socket.emit("payment:error", { message: "Deal is on hold. Counteroffers are not allowed." });
        return;
      }

      if (neg.status === "AGREED" || neg.status === "PAID" || neg.status === "CANCELLED") {
        socket.emit("payment:error", { message: `Cannot counteroffer when deal is ${neg.status}` });
        return;
      }

      const parsedAmount = Math.max(0.01, Number(amount) || 0);

      // Register collaborator identity
      neg.collaboratorSocketId = socket.id;
      neg.collaboratorName = senderName || "Collaborator";

      // Inherit item descriptions from previous offer
      const lastOffer = neg.offers[neg.offers.length - 1];
      const items = lastOffer ? lastOffer.items : [];

      const offerId = generateId("off");
      const counterOffer: NegotiationOffer = {
        offerId,
        negotiationId,
        senderRole: "collaborator",
        senderSocketId: socket.id,
        senderName: senderName || "Collaborator",
        amount: Math.round(parsedAmount * 100) / 100,
        currency: neg.currency,
        items,
        message: message || "",
        createdAt: new Date().toISOString(),
        status: "PENDING",
      };

      neg.status = "COUNTEROFFER_RECEIVED";
      negotiationRepository.addOffer(negotiationId, counterOffer);

      io.in(neg.roomId).emit("payment:counteroffer", {
        negotiationId,
        offer: counterOffer,
        previousAmount: lastOffer ? lastOffer.amount : null,
        difference: lastOffer ? Math.round((parsedAmount - lastOffer.amount) * 100) / 100 : null,
        negotiation: neg,
      });

      console.log(`[Negotiation] Counteroffer submitted for ${negotiationId}: ${parsedAmount} ${neg.currency}`);
    } catch (err: any) {
      console.error("[payment:counteroffer error]", err);
      socket.emit("payment:error", { message: err.message || "Failed to submit counteroffer" });
    }
  });

  /**
   * payment:raise
   * Host raises or alters the offer price.
   */
  socket.on("payment:raise", (payload: {
    negotiationId: string;
    amount: number;
    message?: string;
  }) => {
    try {
      const { negotiationId, amount, message } = payload;
      const neg = negotiationRepository.get(negotiationId);
      if (!neg) {
        socket.emit("payment:error", { message: "Negotiation not found" });
        return;
      }

      if (neg.status === "ON_HOLD") {
        socket.emit("payment:error", { message: "Deal is on hold. Resume first." });
        return;
      }

      const parsedAmount = Math.max(0.01, Number(amount) || 0);
      const lastOffer = neg.offers[neg.offers.length - 1];
      const items = lastOffer ? lastOffer.items : [];

      const offerId = generateId("off");
      const newOffer: NegotiationOffer = {
        offerId,
        negotiationId,
        senderRole: "host",
        senderSocketId: socket.id,
        senderName: neg.hostName,
        amount: Math.round(parsedAmount * 100) / 100,
        currency: neg.currency,
        items,
        message: message || "",
        createdAt: new Date().toISOString(),
        status: "PENDING",
      };

      neg.status = "OFFER_REQUESTED";
      negotiationRepository.addOffer(negotiationId, newOffer);

      io.in(neg.roomId).emit("payment:raise", {
        negotiationId,
        offer: newOffer,
        negotiation: neg,
      });

      console.log(`[Negotiation] Host raised offer for ${negotiationId}: ${parsedAmount}`);
    } catch (err: any) {
      console.error("[payment:raise error]", err);
      socket.emit("payment:error", { message: err.message || "Failed to raise price" });
    }
  });

  /**
   * payment:accept
   * Either party accepts the latest pending offer (Host accepts counteroffer, or Collaborator accepts host offer).
   */
  socket.on("payment:accept", (payload: {
    negotiationId: string;
    offerId: string;
  }) => {
    try {
      const { negotiationId, offerId } = payload;
      const neg = negotiationRepository.get(negotiationId);
      if (!neg) {
        socket.emit("payment:error", { message: "Negotiation not found" });
        return;
      }

      if (neg.status === "ON_HOLD") {
        socket.emit("payment:error", { message: "Deal is on hold. Cannot accept." });
        return;
      }

      const targetOffer = neg.offers.find((o) => o.offerId === offerId);
      if (!targetOffer) {
        socket.emit("payment:error", { message: "Offer not found" });
        return;
      }

      targetOffer.status = "ACCEPTED";
      neg.status = "AGREED";
      neg.agreedAmount = targetOffer.amount;
      negotiationRepository.update(neg);

      io.in(neg.roomId).emit("payment:offer-accepted", {
        negotiationId,
        agreedOffer: targetOffer,
        agreedAmount: targetOffer.amount,
        currency: targetOffer.currency,
        negotiation: neg,
      });

      console.log(`[Negotiation] Deal AGREED for ${negotiationId} at ${targetOffer.amount} ${targetOffer.currency}`);
    } catch (err: any) {
      console.error("[payment:accept error]", err);
      socket.emit("payment:error", { message: err.message || "Failed to accept offer" });
    }
  });

  /**
   * payment:hold / payment:resume
   * Host pauses or resumes negotiation.
   */
  socket.on("payment:hold", (payload: { negotiationId: string }) => {
    const neg = negotiationRepository.get(payload.negotiationId);
    if (!neg) return;
    neg.status = "ON_HOLD";
    negotiationRepository.update(neg);
    io.in(neg.roomId).emit("payment:hold", { negotiationId: neg.negotiationId, negotiation: neg });
  });

  socket.on("payment:resume", (payload: { negotiationId: string }) => {
    const neg = negotiationRepository.get(payload.negotiationId);
    if (!neg) return;
    // Resume to the previous active status
    const lastOffer = neg.offers[neg.offers.length - 1];
    neg.status = lastOffer?.senderRole === "collaborator" ? "COUNTEROFFER_RECEIVED" : "OFFER_REQUESTED";
    negotiationRepository.update(neg);
    io.in(neg.roomId).emit("payment:resume", { negotiationId: neg.negotiationId, negotiation: neg });
  });

  /**
   * payment:cancel / payment:decline
   * Either party cancels or declines.
   */
  socket.on("payment:cancel", (payload: { negotiationId: string; reason?: string }) => {
    const neg = negotiationRepository.get(payload.negotiationId);
    if (!neg) return;
    neg.status = "CANCELLED";
    negotiationRepository.update(neg);
    io.in(neg.roomId).emit("payment:cancel", {
      negotiationId: neg.negotiationId,
      reason: payload.reason || "Deal cancelled",
      negotiation: neg,
    });
  });

  /**
   * payment:sync
   * Request latest deal status for this room (useful on join/reconnect)
   */
  socket.on("payment:sync", (payload: { roomId: string }) => {
    const neg = negotiationRepository.getLatestByRoomId(payload.roomId);
    if (neg) {
      socket.emit("payment:status-updated", { negotiation: neg });
    }
  });
}
