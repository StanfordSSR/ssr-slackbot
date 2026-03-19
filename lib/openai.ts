import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { getReceiptModel } from "@/lib/env";
import { ReceiptExtraction } from "@/types/receipt";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const receiptSchema = z.object({
  merchant: z.string().nullable(),
  purchase_date: z.string().nullable().describe("Use YYYY-MM-DD when available, otherwise null."),
  amount_total: z.number().nullable(),
  currency: z.string().nullable().describe("Use ISO 4217 when inferable, like USD or CAD."),
  item_name: z.string().nullable().describe("A concise label for the purchase, not a long line-item list."),
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
              "You extract receipt fields for a robotics club expense workflow. Return null for uncertain fields instead of guessing. Amount must be the final total charged, not subtotal or tax. item_name must be a short, human-friendly purchase label. For handwritten or blurry receipts, lower confidence and explain uncertainty in notes.",
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
