import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { getChatModel, getReceiptModel } from "@/lib/env";
import { AmazonOrderExtraction, ReceiptExtraction } from "@/types/receipt";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const receiptSchema = z.object({
  merchant: z.string().nullable(),
  purchase_date: z.string().nullable().describe("Use YYYY-MM-DD when available, otherwise null."),
  amount_total: z.number().nullable(),
  currency: z.string().nullable().describe("Use ISO 4217 when inferable, like USD or CAD."),
  item_name: z.string().nullable().describe("A concise label for the purchase, not a long line-item list."),
  category: z.enum(["equipment", "food", "travel"]).describe("Pick the closest HQ category for the purchase."),
  payment_method: z
    .enum(["reimbursement", "credit_card", "amazon", "unknown"])
    .describe("Use unknown when the receipt does not clearly show the payment method."),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

const amazonOrderSchema = z.object({
  item_name: z.string().nullable().describe("The main ordered item name. Keep it concise."),
  amount_total: z.number().nullable().describe("The grand total cost for the order, not a line-item subtotal."),
  currency: z.string().nullable().describe("ISO 4217 currency code like USD when inferable."),
  purchase_date: z.string().nullable().describe("Use YYYY-MM-DD when clear, otherwise null."),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable(),
});

export async function extractReceiptFromImage(input: { dataUrl: string; mimeType: string; filename: string }): Promise<ReceiptExtraction> {
  const fileContent =
    input.mimeType === "application/pdf"
      ? {
          type: "input_file" as const,
          file_data: input.dataUrl,
          filename: input.filename,
        }
      : {
          type: "input_image" as const,
          image_url: input.dataUrl,
          detail: "auto" as const,
        };

  const response = await client.responses.parse({
    model: getReceiptModel(),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You extract receipt fields for a robotics club expense workflow. Return null for uncertain free-text fields instead of guessing. Amount must be the final total charged, not subtotal or tax. item_name must be a short, human-friendly purchase label. category must always be exactly one of equipment, food, or travel based on the best fit for the purchase. payment_method must always be exactly one of reimbursement, credit_card, amazon, or unknown; use amazon only for clear Amazon orders and unknown when the receipt does not prove the method. For handwritten or blurry receipts, lower confidence and explain uncertainty in notes.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Extract the key fields from this receipt image or document preview. Filename: ${input.filename}`,
          },
          fileContent,
        ],
      },
    ],
    text: {
      format: zodTextFormat(receiptSchema, "receipt_extraction"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI did not return parsed receipt output.");
  }

  return response.output_parsed as ReceiptExtraction;
}

export async function answerSlackMention(input: {
  prompt: string;
  history: Array<{ speaker: string; text: string }>;
}) {
  const historyText =
    input.history.length > 0
      ? input.history.map((message) => `${message.speaker}: ${message.text}`).join("\n")
      : "(No recent channel context.)";

  const response = await client.responses.create({
    model: getChatModel(),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are SSR_HQ, the Stanford Student Robotics HQ Slack bot. You love robotics and have a kawaii personality: cheerful, warm, lightly playful, and encouraging without being overly cutesy. Sound like a casual, chill teammate in Slack. Answer the user's current message directly first. Keep replies extremely short by default: usually 1 short sentence, or 2 short sentences only if needed for clarity. Do not add extra framing, recap, or follow-up unless it is genuinely helpful. Use the recent Slack messages only as background context to resolve references or avoid repeating things. Do not summarize or narrate the recent channel history unless the user explicitly asks for a summary or recap. Do not volunteer your features, workflow, or receipt-processing capabilities unless the user asks about them or they are directly relevant to the question. For casual messages, respond casually instead of turning the reply into work talk. If you are unsure about a fact or a club policy, say so instead of inventing details.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Recent channel context (oldest to newest):\n${historyText}\n\nCurrent message for SSR_HQ:\n${input.prompt}\n\nReply as SSR_HQ in a natural Slack tone.`,
          },
        ],
      },
    ],
  });

  const text = response.output_text?.trim();
  if (!text) {
    throw new Error("OpenAI did not return a Slack reply.");
  }

  return text;
}

export async function extractAmazonOrderFromEmail(input: {
  subject: string | null;
  senderEmail: string | null;
  receivedAt: string | null;
  bodyText: string;
}): Promise<AmazonOrderExtraction> {
  const response = await client.responses.parse({
    model: getChatModel(),
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You extract Amazon order purchase data from transactional emails for a robotics club finance workflow. Return one order-level purchase only. item_name should be the clearest single main ordered item label. amount_total must be the grand total for the order. Do not invent values. If item name or total is unclear, return null for that field and explain in notes.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Amazon email metadata:\nSubject: ${input.subject || "(none)"}\nFrom: ${input.senderEmail || "(unknown)"}\nReceived: ${input.receivedAt || "(unknown)"}\n\nEmail body:\n${input.bodyText.slice(0, 12000)}`,
          },
        ],
      },
    ],
    text: {
      format: zodTextFormat(amazonOrderSchema, "amazon_order_extraction"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI did not return parsed Amazon order output.");
  }

  return response.output_parsed as AmazonOrderExtraction;
}
