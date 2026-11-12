import fs from "fs";
import path from "path";
import crypto from "crypto";

export type NegotiationStatus =
  | "OFFER_REQUESTED"
  | "COUNTEROFFER_RECEIVED"
  | "ON_HOLD"
  | "AGREED"
  | "INVOICE_CREATED"
  | "PAYMENT_PENDING"
  | "PARTIALLY_PAID"
  | "PAID"
  | "CANCELLED";

export interface NegotiationItem {
  componentId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
}

export interface NegotiationOffer {
  offerId: string;
  negotiationId: string;
  senderRole: "host" | "collaborator";
  senderSocketId: string;
  senderName: string;
  amount: number;
  currency: string;
  items: NegotiationItem[];
  message?: string;
  createdAt: string;
  status: "PENDING" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
}

export interface NegotiationInvoice {
  paypalInvoiceId: string;
  invoiceNumber: string | null;
  status: string; // DRAFT, SENT, PAID, PARTIALLY_PAID, etc.
  recipientViewUrl: string | null;
  amount: number;
  currency: string;
  createdAt: string;
  paidAt?: string | null;
}

export interface NegotiationPayment {
  eventId: string;
  paypalInvoiceId: string;
  status: string;
  amountReceived: number;
  currency: string;
  verifiedAt: string;
}

export interface NegotiationRecord {
  negotiationId: string;
  roomId: string;
  hostSocketId: string;
  hostName: string;
  collaboratorSocketId?: string | null;
  collaboratorName?: string | null;
  selectedElementIds: string[];
  currentOfferId: string;
  status: NegotiationStatus;
  currency: string;
  agreedAmount?: number | null;
  offers: NegotiationOffer[];
  invoice?: NegotiationInvoice | null;
  payments: NegotiationPayment[];
  createdAt: string;
  updatedAt: string;
}

const DATA_DIR = path.resolve(__dirname, "../../data");
const NEGOTIATIONS_FILE = path.join(DATA_DIR, "negotiations.json");

let memoryNegotiations: Map<string, NegotiationRecord> = new Map();
let isInitialized = false;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadNegotiationsFromFile() {
  if (isInitialized) return;
  ensureDataDir();

  try {
    if (fs.existsSync(NEGOTIATIONS_FILE)) {
      const content = fs.readFileSync(NEGOTIATIONS_FILE, "utf-8");
      const list: NegotiationRecord[] = JSON.parse(content);
      memoryNegotiations = new Map(list.map((neg) => [neg.negotiationId, neg]));
    }
  } catch (err) {
    console.warn("Unable to load negotiations from file, initializing empty:", err);
    memoryNegotiations = new Map();
  }
  isInitialized = true;
}

function saveNegotiationsToFile() {
  ensureDataDir();
  try {
    const list = Array.from(memoryNegotiations.values());
    const tempFile = `${NEGOTIATIONS_FILE}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), "utf-8");
    fs.renameSync(tempFile, NEGOTIATIONS_FILE);
  } catch (err) {
    console.error("Failed to save negotiations to file:", err);
  }
}

export const negotiationRepository = {
  get(negotiationId: string): NegotiationRecord | null {
    loadNegotiationsFromFile();
    return memoryNegotiations.get(negotiationId) || null;
  },

  getActiveByRoomId(roomId: string): NegotiationRecord | null {
    loadNegotiationsFromFile();
    const list = Array.from(memoryNegotiations.values());
    for (const neg of list) {
      if (
        neg.roomId === roomId &&
        neg.status !== "CANCELLED" &&
        neg.status !== "PAID"
      ) {
        return neg;
      }
    }
    return null;
  },

  getLatestByRoomId(roomId: string): NegotiationRecord | null {
    loadNegotiationsFromFile();
    const list = Array.from(memoryNegotiations.values());
    const matches: NegotiationRecord[] = [];
    for (const neg of list) {
      if (neg.roomId === roomId) {
        matches.push(neg);
      }
    }
    matches.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return matches[0] || null;
  },

  getByPaypalInvoiceId(paypalInvoiceId: string): NegotiationRecord | null {
    loadNegotiationsFromFile();
    const list = Array.from(memoryNegotiations.values());
    for (const neg of list) {
      if (neg.invoice?.paypalInvoiceId === paypalInvoiceId) {
        return neg;
      }
    }
    return null;
  },

  create(record: NegotiationRecord): NegotiationRecord {
    loadNegotiationsFromFile();
    memoryNegotiations.set(record.negotiationId, record);
    saveNegotiationsToFile();
    return record;
  },

  update(record: NegotiationRecord): NegotiationRecord {
    loadNegotiationsFromFile();
    record.updatedAt = new Date().toISOString();
    memoryNegotiations.set(record.negotiationId, record);
    saveNegotiationsToFile();
    return record;
  },

  addOffer(negotiationId: string, offer: NegotiationOffer): NegotiationRecord | null {
    const neg = this.get(negotiationId);
    if (!neg) return null;

    // Mark previous offers as superseded if pending
    neg.offers.forEach((o) => {
      if (o.status === "PENDING") {
        o.status = "SUPERSEDED";
      }
    });

    neg.offers.push(offer);
    neg.currentOfferId = offer.offerId;
    return this.update(neg);
  },
};
