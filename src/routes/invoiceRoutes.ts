import { Router, Response } from "express";
import { AuthenticatedRequest, authMiddleware } from "../middleware/auth";
import { invoiceRepository } from "../db/invoiceRepository";
import { analyzeCanvasWithAI, enhanceInvoiceWithAI } from "../services/aiService";
import { CreateInvoiceInput } from "../types/invoice";

const router = Router();

// Apply auth middleware to all invoice endpoints
router.use(authMiddleware);

/**
 * POST /api/invoices/enhance
 * Enhances an already-prepared invoice draft using AI.
 * AI improves descriptions only — NEVER changes prices or quantities.
 */
router.post("/enhance", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { items, currency, title, context } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: "items array is required for enhancement",
      });
    }

    const { draft, metadata } = await enhanceInvoiceWithAI({
      items,
      currency,
      title,
      context,
    });

    return res.json({
      success: true,
      draft,
      metadata,
    });
  } catch (error: any) {
    console.error("AI invoice enhancement error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to enhance invoice",
    });
  }
});

/**
 * POST /api/invoices/generate
 * Generates an unsaved invoice draft from canvas image, annotations, and optional context.
 */
router.post("/generate", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { image, annotations, context } = req.body;

    if (!image && (!annotations || annotations.length === 0)) {
      return res.status(400).json({
        success: false,
        error: "Either a canvas image or annotations must be provided for AI analysis",
      });
    }

    const { draft, metadata } = await analyzeCanvasWithAI({
      image,
      annotations,
      context,
    });

    return res.json({
      success: true,
      draft,
      metadata,
    });
  } catch (error: any) {
    console.error("AI invoice generation error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to analyze canvas drawing",
    });
  }
});

/**
 * POST /api/invoices
 * Persists an invoice to the database after backend calculation & validation.
 */
router.post("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id || "user_default";
    const body = req.body;

    if (!body || typeof body !== "object") {
      return res.status(400).json({ success: false, error: "Invalid request payload" });
    }

    const title = String(body.title || "Untitled Invoice").trim();
    const rawItems = Array.isArray(body.items) ? body.items : [];

    // Recalculate totals on the backend
    let calculatedSubtotal = 0;
    const sanitizedItems = rawItems.map((item: any) => {
      const quantity = Number(item.quantity) > 0 ? Math.round(Number(item.quantity)) : 1;
      let unitPrice: number | null = null;
      if (item.unitPrice !== null && item.unitPrice !== undefined && item.unitPrice !== "") {
        const parsed = Number(item.unitPrice);
        if (Number.isFinite(parsed) && parsed >= 0) {
          unitPrice = Math.round(parsed * 100) / 100;
        }
      }

      const itemSubtotal = unitPrice !== null ? Math.round(quantity * unitPrice * 100) / 100 : null;
      if (itemSubtotal !== null) {
        calculatedSubtotal += itemSubtotal;
      }

      return {
        description: String(item.description || "").trim(),
        quantity,
        unitPrice,
        subtotal: itemSubtotal,
        source: item.source || "user",
      };
    });

    calculatedSubtotal = Math.round(calculatedSubtotal * 100) / 100;

    // Tax calculation
    let calculatedTax = 0;
    if (typeof body.taxRate === "number" && body.taxRate > 0) {
      calculatedTax = Math.round(calculatedSubtotal * (body.taxRate / 100) * 100) / 100;
    } else if (typeof body.tax === "number" && body.tax >= 0) {
      calculatedTax = Math.round(body.tax * 100) / 100;
    }

    // Discount calculation
    const calculatedDiscount = Math.round(Math.max(0, Number(body.discount) || 0) * 100) / 100;

    // Total calculation
    const calculatedTotal = Math.round(Math.max(0, calculatedSubtotal + calculatedTax - calculatedDiscount) * 100) / 100;

    const input: CreateInvoiceInput = {
      invoiceNumber: body.invoiceNumber,
      title,
      sceneId: body.sceneId || null,
      clientName: body.clientName?.trim() || null,
      clientEmail: body.clientEmail?.trim() || null,
      businessName: body.businessName?.trim() || null,
      currency: body.currency || "INR",
      issueDate: body.issueDate || new Date().toISOString(),
      dueDate: body.dueDate || null,
      subtotal: calculatedSubtotal,
      tax: calculatedTax,
      discount: calculatedDiscount,
      total: calculatedTotal,
      status: body.status || "DRAFT",
      items: sanitizedItems,
      missingInformation: Array.isArray(body.missingInformation) ? body.missingInformation : [],
    };

    const savedInvoice = await invoiceRepository.create(userId, input);

    return res.status(201).json({
      success: true,
      id: savedInvoice.id,
      invoice: savedInvoice,
    });
  } catch (error: any) {
    console.error("Failed to save invoice:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to save invoice",
    });
  }
});

/**
 * GET /api/invoices
 * Retrieves invoices belonging to the authenticated user.
 */
router.get("/", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id || "user_default";
    const invoices = await invoiceRepository.findByUserId(userId);

    return res.json({
      success: true,
      invoices,
    });
  } catch (error: any) {
    console.error("Failed to retrieve invoices:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve invoices",
    });
  }
});

/**
 * GET /api/invoices/:id
 * Retrieves a specific invoice after verifying authorization.
 */
router.get("/:id", async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.id || "user_default";
    const invoice = await invoiceRepository.findById(req.params.id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        error: "Invoice not found",
      });
    }

    // Enforce authorization
    if (invoice.userId !== userId) {
      return res.status(403).json({
        success: false,
        error: "Forbidden: You are not authorized to access this invoice",
      });
    }

    return res.json({
      success: true,
      invoice,
    });
  } catch (error: any) {
    console.error("Failed to retrieve invoice:", error);
    return res.status(500).json({
      success: false,
      error: error.message || "Failed to retrieve invoice",
    });
  }
});

export default router;
