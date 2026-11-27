import express from "express";
import https from "https";
import dotenv from "dotenv";
import { requireAuth } from '../middleware/requireAuth.js';

dotenv.config();

const aiInvoiceRouter = express.Router();

// Models to try in order - confirmed available for new API keys
const MODEL_CANDIDATES = [
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-flash-latest",
];

function buildInvoicePrompt(promptText) {
  const invoiceTemplate = {
    invoiceNumber: `INV-${Math.floor(Math.random() * 9000) + 1000}`,
    issueDate: new Date().toISOString().slice(0, 10),
    dueDate: "",
    fromBusinessName: "",
    fromEmail: "",
    fromAddress: "",
    fromPhone: "",
    client: {
      name: "",
      email: "",
      address: "",
      phone: "",
    },
    items: [
      {
        id: "1",
        description: "",
        qty: 1,
        unitPrice: 0,
      },
    ],
    taxPercent: 0,
    notes: "",
  };

  return `You are an invoice generation assistant.

Task:
- Analyze the user's input text.
- Produce a valid JSON object only.
- Do not return markdown.
- Do not return code fences.
- Do not return explanations.
- The JSON must include all fields from the schema below, even if empty.
- Dates must be in YYYY-MM-DD format.
- qty, unitPrice, and taxPercent must be numbers.

Schema:
${JSON.stringify(invoiceTemplate, null, 2)}

User input:
${promptText}

Return JSON only.`;
}

// Call Gemini REST API directly - no SDK needed
function callGeminiRest(modelName, promptText, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }]
    });

    const req = https.request({
      hostname: "generativelanguage.googleapis.com",
      path: `/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject({ statusCode: res.statusCode, error: json?.error });
            return;
          }
          // Extract text from response
          const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            reject({ statusCode: res.statusCode, error: { message: "Empty response from model" } });
            return;
          }
          resolve({ text, model: modelName });
        } catch (e) {
          reject({ statusCode: res.statusCode, error: { message: "Failed to parse Gemini response" } });
        }
      });
    });

    req.on("error", (e) => reject({ statusCode: 0, error: { message: e.message } }));
    req.write(body);
    req.end();
  });
}

function extractJsonObject(text) {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;
  return text.slice(firstBrace, lastBrace + 1);
}

function classifyError(statusCode, error) {
  const msg = error?.message || "";

  if (statusCode === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    return { type: "QUOTA_EXCEEDED", message: "Gemini quota exceeded. Try again later." };
  }
  if (statusCode === 400 && /API key not valid|invalid.*key/i.test(msg)) {
    return { type: "INVALID_KEY", message: "Gemini API key is invalid." };
  }
  if (statusCode === 403 || /PERMISSION_DENIED|leaked/i.test(msg)) {
    return { type: "PERMISSION_DENIED", message: "Gemini API key is blocked or permission denied." };
  }
  if (statusCode === 404 || /NOT_FOUND|no longer available|not found/i.test(msg)) {
    return { type: "MODEL_NOT_FOUND", message: `Model not available: ${msg}` };
  }
  return { type: "UNKNOWN", message: msg || `HTTP ${statusCode}` };
}

aiInvoiceRouter.post("/generate", requireAuth, async (req, res) => {
  try {
    const API_KEY = process.env.GEMINI_API_KEY;

    if (!API_KEY) {
      return res.status(500).json({
        success: false,
        message: "Server configuration error: GEMINI_API_KEY not set.",
      });
    }

    const { prompt } = req.body || {};

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({
        success: false,
        message: "Prompt text is required.",
      });
    }

    const fullPrompt = buildInvoicePrompt(String(prompt).trim());

    let lastError = null;
    let result = null;

    for (const modelName of MODEL_CANDIDATES) {
      try {
        console.log(`Trying model: ${modelName}`);
        result = await callGeminiRest(modelName, fullPrompt, API_KEY);
        console.log(`Success with model: ${modelName}`);
        break;
      } catch (err) {
        const classified = classifyError(err.statusCode, err.error);
        console.warn(`Model ${modelName} failed (${err.statusCode}):`, classified.message);
        lastError = { ...err, classified };

        // Stop immediately for fatal key errors
        if (classified.type === "INVALID_KEY" || classified.type === "PERMISSION_DENIED") {
          return res.status(502).json({
            success: false,
            message: classified.message,
            errorType: classified.type,
          });
        }
        // Otherwise try next model
        continue;
      }
    }

    if (!result) {
      const classified = lastError?.classified || { message: "All models failed." };
      return res.status(502).json({
        success: false,
        message: classified.message,
        errorType: classified.type,
      });
    }

    const jsonText = extractJsonObject(result.text);
    if (!jsonText) {
      return res.status(502).json({
        success: false,
        message: "AI returned malformed response — no JSON found.",
        model: result.model,
        raw: result.text.slice(0, 500),
      });
    }

    let data;
    try {
      data = JSON.parse(jsonText);
    } catch {
      return res.status(502).json({
        success: false,
        message: "AI returned invalid JSON.",
        model: result.model,
        raw: result.text.slice(0, 500),
      });
    }

    return res.status(200).json({
      success: true,
      model: result.model,
      data,
    });

  } catch (err) {
    console.error("AI invoice generation error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal server error during AI invoice generation.",
      detail: err?.message || String(err),
    });
  }
});

export default aiInvoiceRouter;
