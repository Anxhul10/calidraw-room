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
  socket.on("payment:request", async (payload: {
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
  }, callback?: (res: any) => void) => {
    try {
      const { roomId, senderName, selectedElementIds, currency, items, message } = payload;

      if (!roomId || !Array.isArray(items) || items.length === 0) {
        const errMsg = "Invalid payment request payload";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      // Ensure host socket is part of the room
      if (!socket.rooms.has(roomId)) {
        await socket.join(roomId);
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

      // Broadcast incoming payment offer ONLY to other participants (collaborators) in the room
      socket.to(roomId).emit("payment:offer", {
        negotiationId,
        offer: initialOffer,
        negotiation: record,
      });

      // Send outgoing confirmation / acknowledgement to the host
      socket.emit("payment:request-sent", {
        negotiationId,
        offer: initialOffer,
        negotiation: record,
      });

      console.log(`[Negotiation Socket] Event: payment:request | Room: ${roomId} | NegId: ${negotiationId} | Host: ${socket.id} | Amount: ${initialOffer.amount} ${initialOffer.currency}`);

      if (typeof callback === "function") {
        callback({ ok: true, negotiationId, negotiation: record });
      }
    } catch (err: any) {
      console.error("[Negotiation Socket] payment:request error:", err);
      if (typeof callback === "function") callback({ ok: false, error: err.message || "Failed to create payment request" });
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
  }, callback?: (res: any) => void) => {
    try {
      const { negotiationId, senderName, amount, message } = payload;
      const neg = negotiationRepository.get(negotiationId);
      if (!neg) {
        if (typeof callback === "function") callback({ ok: false, error: "Negotiation not found" });
        socket.emit("payment:error", { message: "Negotiation not found" });
        return;
      }

      if (neg.status === "ON_HOLD") {
        const errMsg = "Deal is on hold. Counteroffers are not allowed.";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      if (neg.status === "AGREED" || neg.status === "PAID" || neg.status === "CANCELLED") {
        const errMsg = `Cannot counteroffer when deal is ${neg.status}`;
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      if (neg.hostSocketId && neg.hostSocketId === socket.id) {
        const errMsg = "Host cannot counteroffer their own request. Use raise instead.";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
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

      // Broadcast incoming counteroffer to host (and other participants)
      socket.to(neg.roomId).emit("payment:counteroffer", {
        negotiationId,
        offer: counterOffer,
        previousAmount: lastOffer ? lastOffer.amount : null,
        difference: lastOffer ? Math.round((parsedAmount - lastOffer.amount) * 100) / 100 : null,
        negotiation: neg,
      });

      // Send outgoing confirmation to collaborator
      socket.emit("payment:counteroffer-sent", {
        negotiationId,
        offer: counterOffer,
        previousAmount: lastOffer ? lastOffer.amount : null,
        difference: lastOffer ? Math.round((parsedAmount - lastOffer.amount) * 100) / 100 : null,
        negotiation: neg,
      });

      console.log(`[Negotiation Socket] Event: payment:counteroffer | Room: ${neg.roomId} | NegId: ${negotiationId} | Collaborator: ${socket.id} | Amount: ${parsedAmount} ${neg.currency}`);

      if (typeof callback === "function") {
        callback({ ok: true, negotiation: neg });
      }
    } catch (err: any) {
      console.error("[Negotiation Socket] payment:counteroffer error:", err);
      if (typeof callback === "function") callback({ ok: false, error: err.message || "Failed to submit counteroffer" });
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
  }, callback?: (res: any) => void) => {
    try {
      const { negotiationId, amount, message } = payload;
      const neg = negotiationRepository.get(negotiationId);
      if (!neg) {
        if (typeof callback === "function") callback({ ok: false, error: "Negotiation not found" });
        socket.emit("payment:error", { message: "Negotiation not found" });
        return;
      }

      if (neg.status === "ON_HOLD") {
        const errMsg = "Deal is on hold. Resume first.";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      if (neg.hostSocketId && neg.hostSocketId !== socket.id) {
        const errMsg = "Only the host can raise the offer price.";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
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

      // Collaborator receives updated offer
      socket.to(neg.roomId).emit("payment:raise", {
        negotiationId,
        offer: newOffer,
        negotiation: neg,
      });

      // Host receives confirmation
      socket.emit("payment:raise-sent", {
        negotiationId,
        offer: newOffer,
        negotiation: neg,
      });

      console.log(`[Negotiation Socket] Event: payment:raise | Room: ${neg.roomId} | NegId: ${negotiationId} | Host: ${socket.id} | Amount: ${parsedAmount} ${neg.currency}`);

      if (typeof callback === "function") {
        callback({ ok: true, negotiation: neg });
      }
    } catch (err: any) {
      console.error("[Negotiation Socket] payment:raise error:", err);
      if (typeof callback === "function") callback({ ok: false, error: err.message || "Failed to raise price" });
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
  }, callback?: (res: any) => void) => {
    try {
      const { negotiationId, offerId } = payload;
      const neg = negotiationRepository.get(negotiationId);
      if (!neg) {
        if (typeof callback === "function") callback({ ok: false, error: "Negotiation not found" });
        socket.emit("payment:error", { message: "Negotiation not found" });
        return;
      }

      if (neg.status === "ON_HOLD") {
        const errMsg = "Deal is on hold. Cannot accept.";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      const targetOffer = neg.offers.find((o) => o.offerId === offerId);
      if (!targetOffer) {
        const errMsg = "Offer not found";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      if (targetOffer.senderSocketId === socket.id) {
        const errMsg = "You cannot accept your own offer.";
        if (typeof callback === "function") callback({ ok: false, error: errMsg });
        socket.emit("payment:error", { message: errMsg });
        return;
      }

      targetOffer.status = "ACCEPTED";
      neg.status = "AGREED";
      neg.agreedAmount = targetOffer.amount;
      negotiationRepository.update(neg);

      // Broadcast immediately to ALL participants in the room
      io.in(neg.roomId).emit("payment:offer-accepted", {
        negotiationId,
        agreedOffer: targetOffer,
        agreedAmount: targetOffer.amount,
        currency: targetOffer.currency,
        negotiation: neg,
      });

      console.log(`[Negotiation Socket] Event: payment:offer-accepted | Room: ${neg.roomId} | NegId: ${negotiationId} | AcceptedBy: ${socket.id} | Amount: ${targetOffer.amount} ${targetOffer.currency}`);

      if (typeof callback === "function") {
        callback({ ok: true, negotiation: neg });
      }
    } catch (err: any) {
      console.error("[Negotiation Socket] payment:accept error:", err);
      if (typeof callback === "function") callback({ ok: false, error: err.message || "Failed to accept offer" });
      socket.emit("payment:error", { message: err.message || "Failed to accept offer" });
    }
  });

  /**
   * payment:hold / payment:resume
   * Host pauses or resumes negotiation.
   */
  socket.on("payment:hold", (payload: { negotiationId: string }, callback?: (res: any) => void) => {
    const neg = negotiationRepository.get(payload.negotiationId);
    if (!neg) {
      if (typeof callback === "function") callback({ ok: false, error: "Negotiation not found" });
      return;
    }
    if (neg.hostSocketId && neg.hostSocketId !== socket.id) {
      const errMsg = "Only the host can pause negotiation.";
      if (typeof callback === "function") callback({ ok: false, error: errMsg });
      socket.emit("payment:error", { message: errMsg });
      return;
    }
    neg.status = "ON_HOLD";
    negotiationRepository.update(neg);
    io.in(neg.roomId).emit("payment:hold", { negotiationId: neg.negotiationId, negotiation: neg });
    console.log(`[Negotiation Socket] Event: payment:hold | Room: ${neg.roomId} | NegId: ${neg.negotiationId} | Host: ${socket.id}`);
    if (typeof callback === "function") callback({ ok: true, negotiation: neg });
  });

  socket.on("payment:resume", (payload: { negotiationId: string }, callback?: (res: any) => void) => {
    const neg = negotiationRepository.get(payload.negotiationId);
    if (!neg) {
      if (typeof callback === "function") callback({ ok: false, error: "Negotiation not found" });
      return;
    }
    if (neg.hostSocketId && neg.hostSocketId !== socket.id) {
      const errMsg = "Only the host can resume negotiation.";
      if (typeof callback === "function") callback({ ok: false, error: errMsg });
      socket.emit("payment:error", { message: errMsg });
      return;
    }
    // Resume to the previous active status
    const lastOffer = neg.offers[neg.offers.length - 1];
    neg.status = lastOffer?.senderRole === "collaborator" ? "COUNTEROFFER_RECEIVED" : "OFFER_REQUESTED";
    negotiationRepository.update(neg);
    io.in(neg.roomId).emit("payment:resume", { negotiationId: neg.negotiationId, negotiation: neg });
    console.log(`[Negotiation Socket] Event: payment:resume | Room: ${neg.roomId} | NegId: ${neg.negotiationId} | Host: ${socket.id}`);
    if (typeof callback === "function") callback({ ok: true, negotiation: neg });
  });

  /**
   * payment:cancel / payment:decline
   * Either party cancels or declines.
   */
  socket.on("payment:cancel", (payload: { negotiationId: string; reason?: string }, callback?: (res: any) => void) => {
    const neg = negotiationRepository.get(payload.negotiationId);
    if (!neg) {
      if (typeof callback === "function") callback({ ok: false, error: "Negotiation not found" });
      return;
    }
    neg.status = "CANCELLED";
    negotiationRepository.update(neg);
    io.in(neg.roomId).emit("payment:cancel", {
      negotiationId: neg.negotiationId,
      reason: payload.reason || "Deal cancelled",
      negotiation: neg,
    });
    console.log(`[Negotiation Socket] Event: payment:cancel | Room: ${neg.roomId} | NegId: ${neg.negotiationId} | CancelledBy: ${socket.id}`);
    if (typeof callback === "function") callback({ ok: true, negotiation: neg });
  });

  /**
   * payment:sync
   * Request latest deal status for this room (useful on join/reconnect)
   */
  socket.on("payment:sync", (payload: { roomId: string }, callback?: (res: any) => void) => {
    const neg = negotiationRepository.getLatestByRoomId(payload.roomId);
    console.log(`[Negotiation Socket] Event: payment:sync | Room: ${payload.roomId} | Socket: ${socket.id} | Found: ${!!neg}`);
    if (neg) {
      socket.emit("payment:status-updated", { negotiation: neg });
      if (typeof callback === "function") callback({ ok: true, negotiation: neg });
    } else {
      if (typeof callback === "function") callback({ ok: true, negotiation: null });
    }
  });
}
