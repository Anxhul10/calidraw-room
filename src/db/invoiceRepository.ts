import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Invoice, CreateInvoiceInput } from "../types/invoice";

const DATA_DIR = path.resolve(__dirname, "../../data");
const INVOICES_FILE = path.join(DATA_DIR, "invoices.json");

let memoryInvoices: Map<string, Invoice> = new Map();
let isInitialized = false;

// Prisma client reference (lazy loaded if available)
let prismaClient: any = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadInvoicesFromFile() {
  if (isInitialized) return;
  ensureDataDir();

  try {
    if (fs.existsSync(INVOICES_FILE)) {
      const content = fs.readFileSync(INVOICES_FILE, "utf-8");
      const list: Invoice[] = JSON.parse(content);
      memoryInvoices = new Map(list.map((inv) => [inv.id, inv]));
    }
  } catch (err) {
    console.warn("Unable to load invoices from file, initializing empty:", err);
    memoryInvoices = new Map();
  }
  isInitialized = true;
}

function saveInvoicesToFile() {
  ensureDataDir();
  try {
    const list = Array.from(memoryInvoices.values());
    const tempFile = `${INVOICES_FILE}.${Date.now()}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(list, null, 2), "utf-8");
    fs.renameSync(tempFile, INVOICES_FILE);
  } catch (err) {
    console.error("Failed to save invoices to file:", err);
  }
}

async function getPrismaClient() {
  if (prismaClient) return prismaClient;
  if (!process.env.DATABASE_URL) return null;

  try {
    // Attempt dynamic require of @prisma/client if installed
    const { PrismaClient } = require("@prisma/client");
    prismaClient = new PrismaClient();
    // Test connection with a fast query
    await prismaClient.$connect();
    console.log("Successfully connected to PostgreSQL via Prisma");
    return prismaClient;
  } catch (err) {
    console.warn("Prisma Client unavailable or DB unreachable, using persistent JSON repository:", err);
    prismaClient = null;
    return null;
  }
}

export function generateInvoiceNumber(): string {
  loadInvoicesFromFile();
  const year = new Date().getFullYear();
  const count = memoryInvoices.size + 1;
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  return `INV-${year}-${String(count).padStart(3, "0")}${randomSuffix % 100}`;
}

export const invoiceRepository = {
  async create(userId: string, input: CreateInvoiceInput): Promise<Invoice> {
    const prisma = await getPrismaClient();
    const now = new Date().toISOString();
    const invoiceNumber = input.invoiceNumber?.trim() || generateInvoiceNumber();

    const uuid =
      typeof (crypto as any).randomUUID === "function"
        ? (crypto as any).randomUUID()
        : `inv_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;

    const invoice: Invoice = {
      id: uuid,
      invoiceNumber,
      title: input.title || "Untitled Invoice",
      userId,
      sceneId: input.sceneId ?? null,
      clientName: input.clientName ?? null,
      clientEmail: input.clientEmail ?? null,
      businessName: input.businessName ?? null,
      currency: input.currency || "INR",
      issueDate: input.issueDate || now,
      dueDate: input.dueDate ?? null,
      subtotal: Number(input.subtotal ?? 0),
      tax: Number(input.tax ?? 0),
      discount: Number(input.discount ?? 0),
      total: Number(input.total ?? 0),
      status: input.status || "DRAFT",
      items: Array.isArray(input.items) ? input.items : [],
      missingInformation: Array.isArray(input.missingInformation) ? input.missingInformation : [],
      createdAt: now,
      updatedAt: now,
    };

    if (prisma) {
      try {
        const created = await prisma.invoice.create({
          data: {
            id: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            title: invoice.title,
            userId: invoice.userId,
            sceneId: invoice.sceneId,
            clientName: invoice.clientName,
            clientEmail: invoice.clientEmail,
            currency: invoice.currency,
            issueDate: new Date(invoice.issueDate),
            dueDate: invoice.dueDate ? new Date(invoice.dueDate) : null,
            subtotal: invoice.subtotal,
            tax: invoice.tax,
            discount: invoice.discount,
            total: invoice.total,
            status: invoice.status,
            items: invoice.items,
          },
        });
        return {
          ...invoice,
          id: created.id,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        };
      } catch (prismaError) {
        console.warn("Prisma invoice creation failed, falling back to local store:", prismaError);
      }
    }

    loadInvoicesFromFile();
    memoryInvoices.set(invoice.id, invoice);
    saveInvoicesToFile();
    return invoice;
  },

  async findById(id: string): Promise<Invoice | null> {
    const prisma = await getPrismaClient();
    if (prisma) {
      try {
        const found = await prisma.invoice.findUnique({ where: { id } });
        if (found) {
          return {
            ...found,
            issueDate: found.issueDate ? found.issueDate.toISOString() : "",
            dueDate: found.dueDate ? found.dueDate.toISOString() : null,
            createdAt: found.createdAt.toISOString(),
            updatedAt: found.updatedAt.toISOString(),
            items: found.items as any,
          };
        }
        return null;
      } catch (prismaError) {
        console.warn("Prisma findById failed, falling back to local store:", prismaError);
      }
    }

    loadInvoicesFromFile();
    return memoryInvoices.get(id) ?? null;
  },

  async findByUserId(userId: string): Promise<Invoice[]> {
    const prisma = await getPrismaClient();
    if (prisma) {
      try {
        const list = await prisma.invoice.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
        });
        return list.map((found: any) => ({
          ...found,
          issueDate: found.issueDate ? found.issueDate.toISOString() : "",
          dueDate: found.dueDate ? found.dueDate.toISOString() : null,
          createdAt: found.createdAt.toISOString(),
          updatedAt: found.updatedAt.toISOString(),
          items: found.items as any,
        }));
      } catch (prismaError) {
        console.warn("Prisma findByUserId failed, falling back to local store:", prismaError);
      }
    }

    loadInvoicesFromFile();
    return Array.from(memoryInvoices.values())
      .filter((inv) => inv.userId === userId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  async update(id: string, userId: string, updates: Partial<CreateInvoiceInput>): Promise<Invoice | null> {
    loadInvoicesFromFile();
    const existing = memoryInvoices.get(id);
    if (!existing) return null;
    if (existing.userId !== userId) return null;

    const now = new Date().toISOString();
    const updated: Invoice = {
      ...existing,
      ...updates,
      updatedAt: now,
    };

    memoryInvoices.set(id, updated);
    saveInvoicesToFile();
    return updated;
  },

  async delete(id: string, userId: string): Promise<boolean> {
    loadInvoicesFromFile();
    const existing = memoryInvoices.get(id);
    if (!existing || existing.userId !== userId) return false;

    memoryInvoices.delete(id);
    saveInvoicesToFile();
    return true;
  },
};
