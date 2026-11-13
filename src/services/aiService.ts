import { GenerateInvoiceRequest, InvoiceDraft, InvoiceItem } from "../types/invoice";

interface AnnotationItem {
  id?: string;
  type?: string;
  text?: string;
  billing?: {
    description?: string;
    price?: number | null;
    quantity?: number;
    currency?: string;
  };
  label?: string;
  width?: number;
  height?: number;
}

const SYSTEM_PROMPT = `You are a financial AI assistant inside an Excalidraw diagram editor.
Analyze the provided canvas image, diagram annotations, and user context to extract structured invoice line items.

CRITICAL RULES:
1. Extract prices ONLY when explicitly written in text or labels (e.g. "$500", "₹5000", "5000 INR", "Rate: $50/hr").
2. NEVER invent, fabricate, or assume prices.
3. If a service, product, or component is visible or described but lacks an explicit price, set unitPrice to null.
4. Distinguish between explicitly extracted information (source: "explicit_annotation") and inferred services/features (source: "visual_inference").
5. If information is missing or ambiguous (e.g. missing prices, client name), list it in missingInformation.
6. Do not assume every decorative shape in the drawing is a billable item. Focus on billable deliverables, services, components, or annotated items.
7. Output strictly valid JSON matching this schema:
{
  "title": string,
  "currency": "INR" | "USD" | "EUR" | "GBP",
  "clientName": string | null,
  "clientEmail": string | null,
  "businessName": string | null,
  "items": [
    {
      "description": string,
      "quantity": number,
      "unitPrice": number | null,
      "source": "explicit_annotation" | "visual_inference"
    }
  ],
  "missingInformation": string[]
}`;

export function validateAndSanitizeDraft(raw: any, fallbackTitle = "Drawing Invoice"): InvoiceDraft {
  const title = typeof raw?.title === "string" && raw.title.trim()
    ? raw.title.trim()
    : fallbackTitle;

  const validCurrencies = ["INR", "USD", "EUR", "GBP", "CAD", "AUD", "JPY"];
  const rawCurrency = String(raw?.currency || "").toUpperCase().trim();
  const currency = validCurrencies.includes(rawCurrency) ? rawCurrency : "INR";

  const clientName = typeof raw?.clientName === "string" && raw.clientName.trim()
    ? raw.clientName.trim()
    : null;

  const clientEmail = typeof raw?.clientEmail === "string" && raw.clientEmail.trim()
    ? raw.clientEmail.trim()
    : null;

  const businessName = typeof raw?.businessName === "string" && raw.businessName.trim()
    ? raw.businessName.trim()
    : null;

  const items: InvoiceItem[] = [];
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];

  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const description = typeof item.description === "string" ? item.description.trim() : "";
    if (!description) continue;

    const parsedQty = Number(item.quantity);
    const quantity = Number.isFinite(parsedQty) && parsedQty > 0 ? Math.round(parsedQty) : 1;

    let unitPrice: number | null = null;
    if (item.unitPrice !== null && item.unitPrice !== undefined && item.unitPrice !== "") {
      const parsedPrice = Number(item.unitPrice);
      if (Number.isFinite(parsedPrice) && parsedPrice >= 0) {
        unitPrice = Math.round(parsedPrice * 100) / 100;
      }
    }

    const source = item.source === "explicit_annotation" ? "explicit_annotation" : "visual_inference";
    const subtotal = unitPrice !== null ? Math.round(quantity * unitPrice * 100) / 100 : null;

    items.push({
      description,
      quantity,
      unitPrice,
      subtotal,
      source,
    });
  }

  // If no items were generated, add a placeholder inferred item
  if (items.length === 0) {
    items.push({
      description: title || "Consulting & Deliverables",
      quantity: 1,
      unitPrice: null,
      subtotal: null,
      source: "visual_inference",
    });
  }

  const missingInfoSet = new Set<string>();
  if (Array.isArray(raw?.missingInformation)) {
    for (const info of raw.missingInformation) {
      if (typeof info === "string" && info.trim()) {
        missingInfoSet.add(info.trim());
      }
    }
  }

  // Ensure missing prices and client name are tracked
  for (const item of items) {
    if (item.unitPrice === null) {
      missingInfoSet.add(`${item.description} price`);
    }
  }
  if (!clientName) {
    missingInfoSet.add("Client name");
  }

  return {
    title,
    currency,
    clientName,
    clientEmail,
    businessName,
    items,
    missingInformation: Array.from(missingInfoSet),
  };
}

export function heuristicCanvasAnalysis(
  annotations: AnnotationItem[] | string[] = [],
  context = "",
  fallbackTitle = "Drawing Invoice"
): InvoiceDraft {
  let detectedTitle: string | null = null;
  let detectedClient: string | null = null;
  let detectedCurrency = "INR";
  const items: InvoiceItem[] = [];
  const missingInfo: string[] = [];

  const textSnippets: string[] = [];

  for (const ann of annotations) {
    if (typeof ann === "string") {
      textSnippets.push(ann);
      continue;
    }

    // Direct billing metadata attached to element via BillingDetails component
    if (ann.billing) {
      const b = ann.billing;
      if (b.description?.trim()) {
        const qty = b.quantity && b.quantity > 0 ? b.quantity : 1;
        const price = typeof b.price === "number" && b.price >= 0 ? b.price : null;
        if (b.currency) detectedCurrency = b.currency;

        items.push({
          description: b.description.trim(),
          quantity: qty,
          unitPrice: price,
          subtotal: price !== null ? Math.round(qty * price * 100) / 100 : null,
          source: "explicit_annotation",
        });
      }
    }

    if (ann.text) {
      textSnippets.push(ann.text);
    }
  }

  // Parse text snippets for client, title, currency, and line items
  for (const snippet of textSnippets) {
    const lines = snippet.split("\n").map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      // Check currency symbols
      if (line.includes("$") || /USD/i.test(line)) detectedCurrency = "USD";
      else if (line.includes("₹") || /INR/i.test(line)) detectedCurrency = "INR";
      else if (line.includes("€") || /EUR/i.test(line)) detectedCurrency = "EUR";
      else if (line.includes("£") || /GBP/i.test(line)) detectedCurrency = "GBP";

      // Client name extraction
      const clientMatch = line.match(/(?:Client|Bill\s*To|Customer|For)\s*[:=-]\s*([A-Za-z0-9\s&.,'-]+)/i);
      if (clientMatch && !detectedClient) {
        detectedClient = clientMatch[1].trim();
        continue;
      }

      // Project or invoice title
      const titleMatch = line.match(/(?:Project|Invoice|Title)\s*[:=-]\s*([A-Za-z0-9\s&.,'-]+)/i);
      if (titleMatch && !detectedTitle) {
        detectedTitle = titleMatch[1].trim();
        continue;
      }

      // Price extraction: e.g. "Logo Design: $500", "Hosting - 5000 INR", "3x Banners @ $50"
      const pricePattern = /(.*?)(?:[:\-=–—@]\s*|\s+)([₹$€£]?)\s*([\d,]+(?:\.\d{1,2})?)\s*(INR|USD|EUR|GBP|Rs\.?|\/-)?$/i;
      const priceMatch = line.match(pricePattern);

      if (priceMatch) {
        const descCandidate = priceMatch[1].trim();
        const numericStr = priceMatch[3].replace(/,/g, "");
        const parsedPrice = parseFloat(numericStr);

        if (descCandidate.length > 1 && !isNaN(parsedPrice) && parsedPrice > 0) {
          // Check for quantity in description e.g. "3x Logo" or "5 units"
          let qty = 1;
          const qtyMatch = descCandidate.match(/^(\d+)\s*(?:x|\*|\s)\s*(.*)/i);
          let cleanDesc = descCandidate;
          if (qtyMatch) {
            qty = parseInt(qtyMatch[1], 10) || 1;
            cleanDesc = qtyMatch[2].trim() || descCandidate;
          }

          items.push({
            description: cleanDesc,
            quantity: qty,
            unitPrice: parsedPrice,
            subtotal: Math.round(qty * parsedPrice * 100) / 100,
            source: "explicit_annotation",
          });
          continue;
        }
      }

      // If it looks like a task or deliverable without price: e.g. "Dashboard UI", "Landing Page"
      if (
        line.length >= 3 &&
        line.length <= 60 &&
        !line.startsWith("#") &&
        !/^(true|false|null|undefined|http)/i.test(line)
      ) {
        // Exclude purely structural or generic labels
        if (!/^(start|end|step|yes|no|ok|cancel|test|sample)$/i.test(line)) {
          // Avoid duplicates
          const exists = items.some((it) => it.description.toLowerCase() === line.toLowerCase());
          if (!exists) {
            items.push({
              description: line,
              quantity: 1,
              unitPrice: null,
              subtotal: null,
              source: "visual_inference",
            });
          }
        }
      }
    }
  }

  // Deduplicate items by description
  const uniqueItems: InvoiceItem[] = [];
  const seenDesc = new Set<string>();
  for (const item of items) {
    const key = item.description.toLowerCase();
    if (!seenDesc.has(key)) {
      seenDesc.add(key);
      uniqueItems.push(item);
    }
  }

  const draft: InvoiceDraft = {
    title: detectedTitle || context.slice(0, 50).trim() || fallbackTitle,
    currency: detectedCurrency,
    clientName: detectedClient,
    clientEmail: null,
    businessName: null,
    items: uniqueItems,
    missingInformation: missingInfo,
  };

  return validateAndSanitizeDraft(draft, fallbackTitle);
}

export async function analyzeCanvasWithAI(request: GenerateInvoiceRequest): Promise<{
  draft: InvoiceDraft;
  metadata: {
    model: string;
    annotatedItemCount: number;
    inferredItemCount: number;
  };
}> {
  const { image, annotations = [], context = "" } = request;
  const normalizedAnnotations = Array.isArray(annotations) ? annotations : [];

  // 1. If GEMINI_API_KEY is available, use Google Gemini multimodal API
  console.log(process.env.GEMINI_API_KEY)
  if (process.env.GEMINI_API_KEY && image) {
    try {
      const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
      const mimeType = image.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";

      const promptText = `${SYSTEM_PROMPT}

Annotations extracted from Excalidraw canvas:
${JSON.stringify(normalizedAnnotations, null, 2)}

User Additional Context:
${context || "None provided"}

Analyze the image and annotations strictly following all rules. Return ONLY valid JSON.`;

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: promptText },
                  {
                    inlineData: {
                      mimeType,
                      data: base64Data,
                    },
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      if (response.ok) {
        const json = await response.json();
        const candidateText = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (candidateText) {
          const parsed = JSON.parse(candidateText);
          const sanitized = validateAndSanitizeDraft(parsed);
          const annotatedCount = sanitized.items.filter((i) => i.source === "explicit_annotation").length;
          const inferredCount = sanitized.items.filter((i) => i.source === "visual_inference").length;
          return {
            draft: sanitized,
            metadata: {
              model: "gemini-3.5-flash-lite",
              annotatedItemCount: annotatedCount,
              inferredItemCount: inferredCount,
            },
          };
        }
      } else {
        console.warn("Gemini API call returned status:", response.status, await response.text());
      }
    } catch (aiErr) {
      console.warn("Gemini multimodal call failed, falling back to heuristic analysis:", aiErr);
    }
  }

  // 2. If OPENAI_API_KEY is available, use OpenAI multimodal API
  if (process.env.OPENAI_API_KEY && image) {
    try {
      const promptText = `${SYSTEM_PROMPT}

Annotations:
${JSON.stringify(normalizedAnnotations, null, 2)}

Context:
${context || "None"}

Return JSON.`;

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: promptText },
                { type: "image_url", image_url: { url: image } },
              ],
            },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
        }),
      });

      if (response.ok) {
        const json = await response.json();
        const content = json.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          const sanitized = validateAndSanitizeDraft(parsed);
          const annotatedCount = sanitized.items.filter((i) => i.source === "explicit_annotation").length;
          const inferredCount = sanitized.items.filter((i) => i.source === "visual_inference").length;
          return {
            draft: sanitized,
            metadata: {
              model: "gpt-4o-mini",
              annotatedItemCount: annotatedCount,
              inferredItemCount: inferredCount,
            },
          };
        }
      }
    } catch (aiErr) {
      console.warn("OpenAI API call failed, falling back to heuristic analysis:", aiErr);
    }
  }

  // 3. Fallback to smart heuristic multimodal & annotation analyzer
  const heuristicDraft = heuristicCanvasAnalysis(
    normalizedAnnotations as any,
    context,
    "Canvas Drawing Invoice"
  );
  const annotatedCount = heuristicDraft.items.filter((i) => i.source === "explicit_annotation").length;
  const inferredCount = heuristicDraft.items.filter((i) => i.source === "visual_inference").length;

  return {
    draft: heuristicDraft,
    metadata: {
      model: "heuristic-multimodal-analyzer",
      annotatedItemCount: annotatedCount,
      inferredItemCount: inferredCount,
    },
  };
}

// ─── Invoice Enhancement (descriptions only, prices/quantities preserved) ────

interface BillingLineItem {
  componentId?: string | null;
  description: string;
  quantity: number;
  unitPrice: number | null;
  source?: string;
}

interface EnhanceRequest {
  items: BillingLineItem[];
  currency?: string;
  title?: string;
  context?: string;
}

interface EnhancedDraft {
  title: string;
  items: { description: string }[];
  missingInformation: string[];
}

const ENHANCE_SYSTEM_PROMPT = `You are a professional invoice writer AI.
You receive a list of invoice line items (with their existing descriptions, quantities, and prices).
Your job is ONLY to:
1. Rewrite descriptions to be clearer and more professional.
2. Suggest a professional invoice title.
3. Identify any missing information (e.g. client name, missing prices).

CRITICAL RULES — you MUST follow these:
- Do NOT change quantities.
- Do NOT change unit prices.
- Do NOT add or remove line items.
- Do NOT invent prices, quantities, tax rates, client names, or business names.
- Preserve the number and order of items exactly.
- Output strictly valid JSON with this schema:
{
  "title": string,
  "items": [{ "description": string }],
  "missingInformation": string[]
}`;

export async function enhanceInvoiceWithAI(request: EnhanceRequest): Promise<{
  draft: EnhancedDraft;
  metadata: { model: string };
}> {
  const { items = [], currency = "INR", title = "", context = "" } = request;

  const itemsJson = JSON.stringify(
    items.map((it, i) => ({
      index: i,
      description: it.description,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
    })),
    null,
    2,
  );

  const userPrompt = `${ENHANCE_SYSTEM_PROMPT}

Invoice Title: ${title || "Unknown"}
Currency: ${currency}
Context: ${context || "None"}

Line Items (DO NOT change quantities or unit prices):
${itemsJson}

Return ONLY valid JSON.`;

  // Attempt Gemini
    
  if (process.env.GEMINI_API_KEY) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: userPrompt }] }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: "application/json",
            },
          }),
        }
      );

      const responseText = await response.text();

      if (!response.ok) {
        console.error("Gemini enhancement HTTP error:", response.status);
        console.error("Gemini response:", responseText);
      } else {
        try {
          const json = JSON.parse(responseText);
          const candidateText =
            json.candidates?.[0]?.content?.parts?.[0]?.text;

          if (candidateText) {
            const parsed = JSON.parse(candidateText);

            return {
              draft: sanitizeEnhancedDraft(parsed, items, title),
              metadata: { model: "gemini-3.5-flash-lite" },
            };
          }

          console.error("Gemini returned no candidate text:", responseText);
        } catch (parseError) {
          console.error("Gemini response parsing failed:", parseError);
          console.error("Gemini raw response:", responseText);
        }
      }
    } catch (err) {
      console.warn("Gemini enhance failed, falling back:", err);
    }
  }

  // Attempt OpenAI
  if (process.env.OPENAI_API_KEY) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [{ role: "user", content: userPrompt }],
            response_format: { type: "json_object" },
            temperature: 0.2,
          }),
        },
      );

      if (response.ok) {
        const json = await response.json();
        const content = json.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          return {
            draft: sanitizeEnhancedDraft(parsed, items, title),
            metadata: { model: "gpt-4o-mini" },
          };
        }
      }
    } catch (err) {
      console.warn("OpenAI enhance failed, falling back:", err);
    }
  }

  // Fallback: return original items unchanged
  return {
    draft: sanitizeEnhancedDraft({ title, items: items.map(i => ({ description: i.description })), missingInformation: [] }, items, title),
    metadata: { model: "passthrough" },
  };
}

function sanitizeEnhancedDraft(
  raw: any,
  originalItems: BillingLineItem[],
  fallbackTitle: string,
): EnhancedDraft {
  const title =
    typeof raw?.title === "string" && raw.title.trim()
      ? raw.title.trim()
      : fallbackTitle || "Invoice";

  // Ensure we have exactly the same number of items as the original
  const rawItems = Array.isArray(raw?.items) ? raw.items : [];
  const items = originalItems.map((orig, idx) => {
    const enhanced = rawItems[idx];
    const description =
      typeof enhanced?.description === "string" && enhanced.description.trim()
        ? enhanced.description.trim()
        : orig.description;
    return { description };
  });

  const missingInformation: string[] = [];
  if (Array.isArray(raw?.missingInformation)) {
    for (const info of raw.missingInformation) {
      if (typeof info === "string" && info.trim()) {
        missingInformation.push(info.trim());
      }
    }
  }

  return { title, items, missingInformation };
}
