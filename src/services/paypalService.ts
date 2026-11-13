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
  sellerEmail?: string;
  invoicerEmail?: string;
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

export interface DiagnosticTestResult {
  passed: boolean;
  durationMs: number;
  message?: string;
  status?: number;
  debugId?: string;
  details?: any;
}

export interface PaypalDiagnosticsReport {
  overallStatus: "HEALTHY" | "DEGRADED" | "FAILED";
  timestamp: string;
  environment: "sandbox" | "live";
  credentialsConfigured: {
    clientId: boolean;
    clientSecret: boolean;
    invoicerEmail: boolean;
    webhookId: boolean;
    clientIdMasked?: string;
    invoicerEmailConfigured?: string;
  };
  tests: {
    oauth: DiagnosticTestResult;
    createDraftInvoice?: DiagnosticTestResult;
    readAndCleanupDraftInvoice?: DiagnosticTestResult;
  };
  recommendations: string[];
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

export function getPaypalBaseUrl(): string {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export function maskString(str: string = "", keepStart = 4, keepEnd = 4): string {
  if (!str) return "NOT_SET";
  if (str.length <= keepStart + keepEnd) return "****";
  return `${str.slice(0, keepStart)}...${str.slice(-keepEnd)}`;
}

export async function getPaypalAccessToken(forceRefresh = false): Promise<string> {
  const clientId = (process.env.PAYPAL_CLIENT_ID || "").trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || "").trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing PayPal API credentials: Both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be configured."
    );
  }

  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt) {
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

  const debugId =
    response.headers.get("paypal-debug-id") ||
    response.headers.get("x-paypal-debug-id") ||
    undefined;

  const raw = await response.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (!response.ok) {
    const errorMsg =
      data.error_description ||
      data.error ||
      `PayPal OAuth authentication failed with HTTP ${response.status}`;
    console.error(
      `[PayPal OAuth Error] Status: ${response.status} | Error: ${data.error || "AUTH_FAILED"} | Description: ${errorMsg} | DebugID: ${debugId || "N/A"}`
    );
    const err: any = new Error(errorMsg);
    err.status = response.status;
    err.debugId = debugId;
    err.name = data.error || "OAuthAuthenticationError";
    throw err;
  }

  cachedToken = data.access_token;
  // Cache token with safe 60s buffer before expiration
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  tokenExpiresAt = Date.now() + Math.max(30, expiresIn - 60) * 1000;

  return cachedToken as string;
}

export function extractInvoiceId(data: any, locationHeader?: string | null): string | null {
  if (!data && !locationHeader) return null;

  // 1. Direct id fields
  if (typeof data?.id === "string" && data.id.trim()) {
    return data.id.trim();
  }
  if (typeof data?.invoice_id === "string" && data.invoice_id.trim()) {
    return data.invoice_id.trim();
  }
  if (typeof data?.invoice?.id === "string" && data.invoice.id.trim()) {
    return data.invoice.id.trim();
  }

  // 2. Location header (e.g. https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-...)
  const loc = locationHeader || data?._location;
  if (typeof loc === "string") {
    const match = loc.match(/\/invoices\/([A-Za-z0-9-_]+)/);
    if (match && match[1]) return match[1];
  }

  // 3. HATEOAS links in body
  if (Array.isArray(data?.links)) {
    const selfLink = data.links.find(
      (l: any) => l.rel === "self" || l.rel === "send" || l.rel === "payer-view"
    );
    if (selfLink?.href) {
      const match = selfLink.href.match(/\/invoices\/([A-Za-z0-9-_]+)/);
      if (match && match[1]) return match[1];
    }
  }

  // 4. href property
  if (typeof data?.href === "string") {
    const match = data.href.match(/\/invoices\/([A-Za-z0-9-_]+)/);
    if (match && match[1]) return match[1];
  }

  return null;
}

export async function paypalRequest<T = any>(
  path: string,
  options: RequestInit = {},
  operationName = "paypalRequest"
): Promise<T> {
  let token = await getPaypalAccessToken();

  const makeCall = async (authToken: string) => {
    return fetch(`${getPaypalBaseUrl()}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        Prefer: "return=representation",
        ...(options.headers || {}),
      },
    });
  };

  let response = await makeCall(token);

  // If token expired upstream (401), force refresh once and retry
  if (response.status === 401) {
    console.warn(`[PayPal] 401 Unauthorized encountered during ${operationName}. Refreshing access token...`);
    token = await getPaypalAccessToken(true);
    response = await makeCall(token);
  }

  const debugId =
    response.headers.get("paypal-debug-id") ||
    response.headers.get("x-paypal-debug-id") ||
    undefined;

  const locationHeader = response.headers.get("location");

  const raw = await response.text();
  let data: any = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { message: raw };
  }

  if (data && typeof data === "object") {
    data._httpStatus = response.status;
    data._debugId = debugId;
    if (locationHeader) {
      data._location = locationHeader;
    }
  }

  if (!response.ok) {
    const errorName = data.name || data.error || "PAYPAL_API_ERROR";
    const errorMessage =
      data.message ||
      data.error_description ||
      data.details?.[0]?.description ||
      `PayPal API call failed with HTTP status ${response.status}`;

    console.error(
      `[PayPal Error] Operation: ${operationName} | Path: ${path} | HTTP Status: ${response.status} | Name: ${errorName} | Message: ${errorMessage} | DebugID: ${debugId || data.debug_id || "N/A"}`
    );
    if (data.details && Array.isArray(data.details)) {
      console.error(
        `[PayPal Error Details]`,
        JSON.stringify(
          data.details.map((d: any) => ({
            field: d.field,
            issue: d.issue,
            description: d.description,
          }))
        )
      );
    }

    const error: any = new Error(
      `PayPal ${operationName} failed (${response.status} ${errorName}): ${errorMessage}`
    );
    error.status = response.status;
    error.name = errorName;
    error.debugId = debugId || data.debug_id;
    error.details = data.details;
    error.paypalData = data;
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
  const { sellerName, sellerEmail, invoicerEmail, customerName, customerEmail, currency, items, note } = params;

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

  // In PayPal Invoicing API v2:
  // If invoicer is provided, email_address is REQUIRED and must match the authenticated merchant account.
  // We check process.env.PAYPAL_INVOICER_EMAIL, then invoicerEmail / sellerEmail.
  const resolvedInvoicerEmail = (
    process.env.PAYPAL_INVOICER_EMAIL ||
    invoicerEmail ||
    sellerEmail ||
    ""
  ).trim();

  const payload: any = {
    detail: {
      currency_code: currency || "USD",
      invoice_date: new Date().toISOString().slice(0, 10),
      payment_term: {
        term_type: "DUE_ON_RECEIPT",
      },
      note: note || "Thank you for agreeing on the terms! Please complete payment via PayPal.",
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

  // Only attach invoicer block if email_address is known, to avoid 403 NOT_AUTHORIZED due to incomplete invoicer schema.
  // When omitted, PayPal Invoicing v2 defaults the invoicer to the authenticated merchant account tied to the credentials.
  if (resolvedInvoicerEmail) {
    payload.invoicer = {
      email_address: resolvedInvoicerEmail,
      name: sellerNameObj,
      ...(sellerName ? { business_name: sellerName } : {}),
    };
  } else if (sellerName) {
    // If sellerName is given but no invoicer email is set, log informative hint
    console.info(
      "[PayPal] Note: PAYPAL_INVOICER_EMAIL not set. Omitting explicit invoicer object so PayPal defaults to the authenticated merchant profile."
    );
  }

  const rawResponse = await paypalRequest<any>(
    "/v2/invoicing/invoices",
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    },
    "createPaypalInvoice"
  );

  const invoiceId = extractInvoiceId(rawResponse, rawResponse?._location);

  if (!invoiceId) {
    console.error("[PayPal Error] Could not extract invoice ID from response:", JSON.stringify(rawResponse));
    throw new Error(
      "PayPal invoice was created (HTTP 201), but an invoice ID could not be extracted from the response."
    );
  }

  // If minimal response was returned and detail/metadata is missing, retrieve the full representation
  let invoiceData = rawResponse;
  if (!invoiceData.detail || !invoiceData.detail.metadata) {
    try {
      const fullInvoice = await getPaypalInvoice(invoiceId);
      if (fullInvoice && (fullInvoice.id || fullInvoice.detail)) {
        invoiceData = fullInvoice;
      }
    } catch (fetchErr: any) {
      console.warn(`[PayPal] Could not fetch representation for draft invoice ${invoiceId}:`, fetchErr.message);
    }
  }

  const payerViewUrl =
    invoiceData.detail?.metadata?.recipient_view_url ||
    invoiceData.links?.find((l: any) => l.rel === "payer-view")?.href ||
    null;

  const invoicerViewUrl =
    invoiceData.detail?.metadata?.invoicer_view_url ||
    invoiceData.links?.find((l: any) => l.rel === "invoicer-view" || l.rel === "self")?.href ||
    null;

  return {
    paypalInvoiceId: invoiceId,
    status: invoiceData.status || "DRAFT",
    invoiceNumber: invoiceData.detail?.invoice_number || null,
    recipientViewUrl: payerViewUrl,
    payerViewUrl,
    invoicerViewUrl,
    raw: invoiceData,
  };
}

export async function sendPaypalInvoice(paypalInvoiceId: string) {
  if (!paypalInvoiceId || !paypalInvoiceId.trim()) {
    throw new Error("sendPaypalInvoice requires a valid paypalInvoiceId");
  }

  const trimmedId = paypalInvoiceId.trim();

  const sendResult = await paypalRequest<any>(
    `/v2/invoicing/invoices/${encodeURIComponent(trimmedId)}/send`,
    {
      method: "POST",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        send_to_recipient: true,
        send_to_invoicer: true,
      }),
    },
    "sendPaypalInvoice"
  );

  const invoice = await paypalRequest<any>(
    `/v2/invoicing/invoices/${encodeURIComponent(trimmedId)}`,
    { method: "GET" },
    "getPaypalInvoice"
  );

  // PayPal Invoicing v2 stores the payer URL in:
  // 1. sendResult.links[rel === 'payer-view']
  // 2. invoice.detail?.metadata?.recipient_view_url
  // 3. invoice.links[rel === 'payer-view']
  const payerLink =
    sendResult?.links?.find((link: any) => link.rel === "payer-view")?.href ||
    invoice?.detail?.metadata?.recipient_view_url ||
    invoice?.links?.find((link: any) => link.rel === "payer-view")?.href ||
    invoice?.metadata?.recipient_view_url ||
    null;

  const invoicerLink =
    invoice?.detail?.metadata?.invoicer_view_url ||
    invoice?.links?.find((link: any) => link.rel === "invoicer-view" || link.rel === "self")?.href ||
    invoice?.metadata?.invoicer_view_url ||
    null;

  if (!payerLink) {
    console.warn(
      `[PayPal Warning] Payer-view URL not returned by PayPal for invoice ${trimmedId}. Status: ${invoice.status}`
    );
  }

  return {
    paypalInvoiceId: invoice.id || trimmedId,
    status: invoice.status || "SENT",
    invoiceNumber: invoice.detail?.invoice_number || null,
    recipientViewUrl: payerLink,
    payerViewUrl: payerLink,
    invoicerViewUrl: invoicerLink,
    invoice,
  };
}

export async function getPaypalInvoice(paypalInvoiceId: string) {
  return paypalRequest<any>(
    `/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}`,
    { method: "GET" },
    "getPaypalInvoice"
  );
}

export async function deletePaypalDraftInvoice(paypalInvoiceId: string): Promise<boolean> {
  try {
    await paypalRequest<any>(
      `/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}`,
      { method: "DELETE" },
      "deletePaypalDraftInvoice"
    );
    return true;
  } catch (err: any) {
    console.warn(`[PayPal] Failed to delete draft invoice ${paypalInvoiceId}:`, err.message);
    return false;
  }
}

/**
 * Runs active diagnostic tests against the configured PayPal environment:
 * - Test A: OAuth token acquisition & latency
 * - Test B: Draft invoice creation
 * - Test C: Invoice retrieval & cleanup
 */
export async function runPaypalDiagnostics(): Promise<PaypalDiagnosticsReport> {
  const envMode = (process.env.PAYPAL_ENV === "live" ? "live" : "sandbox") as "live" | "sandbox";
  const clientId = (process.env.PAYPAL_CLIENT_ID || "").trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || "").trim();
  const invoicerEmail = (process.env.PAYPAL_INVOICER_EMAIL || "").trim();
  const webhookId = (process.env.PAYPAL_WEBHOOK_ID || "").trim();

  const report: PaypalDiagnosticsReport = {
    overallStatus: "HEALTHY",
    timestamp: new Date().toISOString(),
    environment: envMode,
    credentialsConfigured: {
      clientId: Boolean(clientId),
      clientSecret: Boolean(clientSecret),
      invoicerEmail: Boolean(invoicerEmail),
      webhookId: Boolean(webhookId),
      clientIdMasked: maskString(clientId, 6, 6),
      invoicerEmailConfigured: invoicerEmail ? maskString(invoicerEmail, 3, 8) : "NOT_CONFIGURED",
    },
    tests: {
      oauth: { passed: false, durationMs: 0 },
    },
    recommendations: [],
  };

  if (!clientId || !clientSecret) {
    report.overallStatus = "FAILED";
    report.tests.oauth = {
      passed: false,
      durationMs: 0,
      message: "Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in environment.",
    };
    report.recommendations.push(
      "Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from PayPal Developer Dashboard to your environment variables."
    );
    return report;
  }

  // --- Test A: OAuth Token Acquisition ---
  const t0 = Date.now();
  try {
    await getPaypalAccessToken(true);
    report.tests.oauth = {
      passed: true,
      durationMs: Date.now() - t0,
      message: "OAuth 2.0 token successfully generated using HTTP Basic authentication.",
    };
  } catch (oauthErr: any) {
    report.overallStatus = "FAILED";
    report.tests.oauth = {
      passed: false,
      durationMs: Date.now() - t0,
      message: oauthErr.message,
      status: oauthErr.status,
      debugId: oauthErr.debugId,
    };
    report.recommendations.push(
      `OAuth failed (${oauthErr.status || "Unknown"}). Verify PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in ${envMode} mode.`
    );
    return report;
  }

  // --- Test B: Create Draft Invoice ---
  const t1 = Date.now();
  let createdTestInvoiceId: string | null = null;
  try {
    const testPayload: CreatePaypalInvoiceParams = {
      sellerName: "Calidraw Diagnostic Seller",
      customerName: "Diagnostic Test Payer",
      customerEmail: "diagnostic-buyer@example.com",
      currency: "USD",
      items: [
        {
          description: "Calidraw Diagnostic Verification Item",
          quantity: 1,
          unitPrice: 1.0,
        },
      ],
      note: "Automated PayPal Invoicing Diagnostic Check (Safe to ignore)",
    };

    const draftResult = await createPaypalInvoice(testPayload);
    createdTestInvoiceId = draftResult.paypalInvoiceId;

    report.tests.createDraftInvoice = {
      passed: true,
      durationMs: Date.now() - t1,
      message: `Draft invoice ${draftResult.paypalInvoiceId} created successfully in status ${draftResult.status}.`,
    };
  } catch (draftErr: any) {
    report.overallStatus = "FAILED";
    report.tests.createDraftInvoice = {
      passed: false,
      durationMs: Date.now() - t1,
      message: draftErr.message,
      status: draftErr.status,
      debugId: draftErr.debugId,
      details: draftErr.details,
    };

    if (draftErr.status === 403 || draftErr.name === "NOT_AUTHORIZED") {
      report.recommendations.push(
        "PayPal returned 403 NOT_AUTHORIZED: Ensure Invoicing capability is enabled on your REST App in PayPal Developer Dashboard. If specifying an invoicer email, ensure PAYPAL_INVOICER_EMAIL matches your Sandbox Business account email exactly."
      );
    } else {
      report.recommendations.push(
        `Draft invoice creation failed with status ${draftErr.status || 500}: ${draftErr.message}`
      );
    }
  }

  // --- Test C: Read & Clean Up Draft Invoice ---
  if (createdTestInvoiceId) {
    const t2 = Date.now();
    try {
      await getPaypalInvoice(createdTestInvoiceId);
      const cleaned = await deletePaypalDraftInvoice(createdTestInvoiceId);
      report.tests.readAndCleanupDraftInvoice = {
        passed: true,
        durationMs: Date.now() - t2,
        message: `Draft invoice verified and cleaned up (deleted = ${cleaned}).`,
      };
    } catch (cleanErr: any) {
      report.overallStatus = report.overallStatus === "HEALTHY" ? "DEGRADED" : report.overallStatus;
      report.tests.readAndCleanupDraftInvoice = {
        passed: false,
        durationMs: Date.now() - t2,
        message: cleanErr.message,
        status: cleanErr.status,
        debugId: cleanErr.debugId,
      };
    }
  }

  if (report.overallStatus === "HEALTHY") {
    report.recommendations.push(
      "All PayPal Invoicing tests passed. The backend is properly authorized and ready to issue live invoices."
    );
  }

  return report;
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
    console.warn("[PayPal Webhook] PAYPAL_WEBHOOK_ID not set; skipping webhook signature verification");
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
      "verifyWebhookSignature"
    );

    return result.verification_status === "SUCCESS";
  } catch (err) {
    console.error("[PayPal Webhook] Signature verification failed:", err);
    return false;
  }
}
