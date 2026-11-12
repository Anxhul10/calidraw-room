export interface PaypalInvoiceItem {
  name: string;
  description?: string;
  quantity: string;
  unit_amount: {
    currency_code: string;
    value: string;
  };
}

export interface CreatePaypalInvoiceParams {
  sellerName?: string;
  customerName?: string;
  customerEmail: string;
  currency: string;
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
  }>;
  note?: string;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

function getPaypalBaseUrl(): string {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export async function getPaypalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing PayPal API credentials (PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET).");
  }

  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${getPaypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "PayPal authentication failed.");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken as string;
}

export async function paypalRequest<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await getPaypalAccessToken();
  const response = await fetch(`${getPaypalBaseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });

  const raw = await response.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (!response.ok) {
    const message =
      data.message ||
      data.details?.[0]?.description ||
      data.name ||
      "PayPal request failed.";
    const error: any = new Error(message);
    error.status = response.status;
    error.details = data.details;
    throw error;
  }

  return data as T;
}

function splitName(name: string = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return {
    given_name: parts[0] || "Customer",
    surname: parts.slice(1).join(" ") || " ",
  };
}

export async function createPaypalInvoice(params: CreatePaypalInvoiceParams) {
  const { sellerName, customerName, customerEmail, currency, items, note } = params;

  if (!customerEmail || !customerEmail.includes("@")) {
    throw new Error("Valid customer email is required.");
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("At least one invoice item is required.");
  }

  const paypalItems: PaypalInvoiceItem[] = items.map((item) => {
    const description = String(item.description || "Deliverable").trim();
    const qty = Number(item.quantity) || 1;
    const price = Number(item.unitPrice) || 0;
    return {
      name: description.slice(0, 100),
      description: description.slice(0, 200),
      quantity: String(qty),
      unit_amount: {
        currency_code: currency || "USD",
        value: price.toFixed(2),
      },
    };
  });

  const custNameObj = splitName(customerName);
  const sellerNameObj = splitName(sellerName);

  const payload = {
    detail: {
      currency_code: currency || "USD",
      invoice_date: new Date().toISOString().slice(0, 10),
      payment_term: {
        term_type: "DUE_ON_RECEIPT",
      },
      note: note || "Thank you for agreeing on the terms! Please complete payment via PayPal.",
    },
    invoicer: {
      name: sellerNameObj,
      ...(sellerName ? { business_name: sellerName } : {}),
    },
    primary_recipients: [
      {
        billing_info: {
          email_address: customerEmail.trim(),
          name: custNameObj,
        },
      },
    ],
    items: paypalItems,
  };

  const paypalInvoice = await paypalRequest("/v2/invoicing/invoices", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return {
    paypalInvoiceId: paypalInvoice.id,
    status: paypalInvoice.status,
    invoiceNumber: paypalInvoice.detail?.invoice_number || null,
    raw: paypalInvoice,
  };
}

export async function sendPaypalInvoice(paypalInvoiceId: string) {
  const sendResult = await paypalRequest(
    `/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/send`,
    {
      method: "POST",
      body: JSON.stringify({
        send_to_recipient: true,
        send_to_invoicer: true,
      }),
    },
  );

  const invoice = await paypalRequest(
    `/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}`,
    { method: "GET" },
  );

  const payerLink =
    invoice.metadata?.recipient_view_url ||
    sendResult.links?.find((link: any) => link.rel === "payer-view")?.href ||
    null;

  return {
    paypalInvoiceId: invoice.id,
    status: invoice.status,
    recipientViewUrl: payerLink,
    invoice,
  };
}

export async function getPaypalInvoice(paypalInvoiceId: string) {
  return paypalRequest(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}`, {
    method: "GET",
  });
}

/**
 * Verifies webhook signature against PayPal's verification endpoint.
 */
export async function verifyWebhookSignature(params: {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  webhookEvent: any;
}): Promise<boolean> {
  const {
    authAlgo,
    certUrl,
    transmissionId,
    transmissionSig,
    transmissionTime,
    webhookId,
    webhookEvent,
  } = params;

  if (!webhookId) {
    // If webhook ID is not set in env, we cannot verify via PayPal API
    console.warn("PAYPAL_WEBHOOK_ID not set; skipping webhook signature verification");
    return true;
  }

  try {
    const verificationPayload = {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: webhookEvent,
    };

    const result = await paypalRequest<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        body: JSON.stringify(verificationPayload),
      },
    );

    return result.verification_status === "SUCCESS";
  } catch (err) {
    console.error("Webhook signature verification failed:", err);
    return false;
  }
}
