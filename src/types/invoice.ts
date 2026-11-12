export type InvoiceStatus = "DRAFT" | "SENT" | "PAID";

export type InvoiceItemSource = "explicit_annotation" | "visual_inference" | "user";

export interface InvoiceItem {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number | null;
  subtotal?: number | null;
  source?: InvoiceItemSource;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  title: string;
  userId: string;
  sceneId?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  businessName?: string | null;
  currency: string;
  issueDate: string;
  dueDate?: string | null;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  status: InvoiceStatus;
  items: InvoiceItem[];
  missingInformation?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateInvoiceInput {
  invoiceNumber?: string;
  title: string;
  sceneId?: string | null;
  clientName?: string | null;
  clientEmail?: string | null;
  businessName?: string | null;
  currency?: string;
  issueDate?: string;
  dueDate?: string | null;
  subtotal?: number;
  tax?: number;
  discount?: number;
  total?: number;
  status?: InvoiceStatus;
  items: InvoiceItem[];
  missingInformation?: string[];
}

export interface GenerateInvoiceRequest {
  image?: string;
  annotations?: Array<{
    type?: string;
    text?: string;
    billing?: {
      description?: string;
      price?: number | null;
      quantity?: number;
      currency?: string;
    };
    id?: string;
    width?: number;
    height?: number;
  }> | string[];
  context?: string;
}

export interface InvoiceDraft {
  title: string;
  currency: string;
  clientName: string | null;
  clientEmail: string | null;
  businessName: string | null;
  items: InvoiceItem[];
  missingInformation: string[];
}
