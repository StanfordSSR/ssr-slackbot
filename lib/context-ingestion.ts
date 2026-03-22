import OpenAI from "openai";
import { createHash } from "node:crypto";
import { toDataUrl } from "@/lib/receipt-utils";
import { buildOrgProfileFromSources, summarizeBinaryDocument, summarizeContextDocument } from "@/lib/analyst-openai";
import {
  createContextSource,
  getRuntimeConfig,
  listCanonicalContextSources,
  searchContextSources,
  setRuntimeConfig,
  updateContextSourceReady,
  markContextSourceFailed,
  getTeamDirectory,
} from "@/lib/analyst-store";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

type ParsedContextInput = {
  corpus: "org" | "internal";
  scope: "org" | "team";
  teamId: string | null;
  tags: string[];
  isCanonical: boolean;
  canonicalKind: string | null;
  payloadText: string;
};

export function parseAddContextInput(text: string) {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  let url: string | null = null;
  const parsed: ParsedContextInput = {
    corpus: "org",
    scope: "org",
    teamId: null,
    tags: [],
    isCanonical: false,
    canonicalKind: null,
    payloadText: text.trim(),
  };

  for (const token of tokens) {
    if (/^https?:\/\//i.test(token)) {
      url = token;
      continue;
    }
    if (token === "internal" || token === "corpus:internal") {
      parsed.corpus = "internal";
      continue;
    }
    if (token === "org" || token === "corpus:org") {
      parsed.corpus = "org";
      continue;
    }
    if (token === "canonical" || token.startsWith("canonical:")) {
      parsed.isCanonical = true;
      parsed.canonicalKind = token.split(":")[1] || parsed.canonicalKind || "general";
      continue;
    }
    if (token.startsWith("team:")) {
      parsed.scope = "team";
      parsed.teamId = token.slice("team:".length) || null;
      continue;
    }
    if (token.startsWith("tag:")) {
      parsed.tags.push(token.slice("tag:".length));
      continue;
    }
  }

  return { url, parsed };
}

function stripHtml(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function inferTags(title: string, text: string, existingTags: string[]) {
  const tags = new Set(existingTags.map((tag) => tag.toLowerCase()));
  const haystack = `${title}\n${text}`.toLowerCase();
  const candidates = ["policy", "grants", "fundraising", "finance", "stanford", "audit", "compliance", "teams"];
  for (const candidate of candidates) {
    if (haystack.includes(candidate)) tags.add(candidate);
  }
  return [...tags].slice(0, 8);
}

async function getOrCreateVectorStoreId(corpus: "org" | "internal") {
  const configKey = corpus === "org" ? "openai_vector_store_org" : "openai_vector_store_internal";
  const existing = await getRuntimeConfig<{ id?: string }>(configKey);
  if (existing?.id) return existing.id;

  const created = await client.vectorStores.create({
    name: corpus === "org" ? "SSR Org Context" : "SSR Internal Context",
  });
  await setRuntimeConfig(configKey, { id: created.id, createdAt: new Date().toISOString() });
  return created.id;
}

async function uploadFileToVectorStore(params: {
  vectorStoreId: string;
  bytes: ArrayBuffer;
  filename: string;
  mimeType: string;
}) {
  const file = new File([params.bytes], params.filename, { type: params.mimeType });
  const uploaded = await client.files.create({
    file,
    purpose: "assistants",
  });
  await client.vectorStores.files.create(params.vectorStoreId, { file_id: uploaded.id });
  return uploaded.id;
}

async function refreshOrgProfileArtifact() {
  const canonical = await listCanonicalContextSources();
  const teams = await getTeamDirectory();
  const built = await buildOrgProfileFromSources({
    canonicalTexts: canonical.map((item) => ({
      title: item.title,
      text: item.content_text || item.content_summary || "",
    })),
    teamDirectory: teams.map((team) => ({
      id: team.id as string,
      name: team.name as string,
      slug: (team.slug as string | null) ?? null,
    })),
  });

  await setRuntimeConfig("org_profile_cache", {
    text: built.profileText,
    updatedAt: new Date().toISOString(),
  });
}

export async function getCachedOrgProfile() {
  const cached = await getRuntimeConfig<{ text?: string }>("org_profile_cache");
  if (cached?.text) return cached.text;
  await refreshOrgProfileArtifact();
  const refreshed = await getRuntimeConfig<{ text?: string }>("org_profile_cache");
  return refreshed?.text ?? null;
}

export async function ingestUrlContext(params: {
  linkedByProfileId: string;
  url: string;
  corpus: "org" | "internal";
  scope: "org" | "team";
  teamId?: string | null;
  tags: string[];
  isCanonical: boolean;
  canonicalKind?: string | null;
}) {
  const created = await createContextSource({
    linkedByProfileId: params.linkedByProfileId,
    sourceType: "url",
    sourceUrl: params.url,
    title: params.url,
    corpus: params.corpus,
    scope: params.scope,
    teamId: params.teamId ?? null,
    tags: params.tags,
    isCanonical: params.isCanonical,
    canonicalKind: params.canonicalKind ?? null,
  });

  try {
    const response = await fetch(params.url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`URL fetch failed: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "text/html";
    const arrayBuffer = await response.arrayBuffer();
    const title = new URL(params.url).hostname;
    const vectorStoreId = await getOrCreateVectorStoreId(params.corpus);
    const filename = createHash("sha1").update(params.url).digest("hex").slice(0, 12) + guessExtension(contentType);
    const openaiFileId = await uploadFileToVectorStore({
      vectorStoreId,
      bytes: arrayBuffer,
      filename,
      mimeType: contentType,
    });

    let contentText: string | null = null;
    let contentSummary = "";

    if (contentType.includes("html") || contentType.includes("text")) {
      contentText = stripHtml(Buffer.from(arrayBuffer).toString("utf8"));
      const summarized = await summarizeContextDocument({
        title,
        text: contentText,
        tags: inferTags(title, contentText, params.tags),
      });
      contentSummary = summarized.summary;
    } else {
      const summarized = await summarizeBinaryDocument({
        title,
        filename,
        mimeType: contentType,
        dataUrl: toDataUrl(arrayBuffer, contentType),
        tags: params.tags,
      });
      contentSummary = summarized.summary;
    }

    await updateContextSourceReady({
      sourceId: created.id,
      title,
      contentText,
      contentSummary,
      openaiFileId,
      openaiVectorStoreId: vectorStoreId,
    });

    if (params.isCanonical) {
      await refreshOrgProfileArtifact();
    }

    return { sourceId: created.id, title, contentSummary };
  } catch (error) {
    await markContextSourceFailed(created.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function ingestSlackFileContext(params: {
  linkedByProfileId: string;
  slackFileId: string;
  title: string;
  mimeType: string;
  bytes: ArrayBuffer;
  corpus: "org" | "internal";
  scope: "org" | "team";
  teamId?: string | null;
  tags: string[];
  isCanonical: boolean;
  canonicalKind?: string | null;
}) {
  const created = await createContextSource({
    linkedByProfileId: params.linkedByProfileId,
    sourceType: "slack_file",
    slackFileId: params.slackFileId,
    title: params.title,
    corpus: params.corpus,
    scope: params.scope,
    teamId: params.teamId ?? null,
    tags: params.tags,
    isCanonical: params.isCanonical,
    canonicalKind: params.canonicalKind ?? null,
    mimeType: params.mimeType,
  });

  try {
    const vectorStoreId = await getOrCreateVectorStoreId(params.corpus);
    const openaiFileId = await uploadFileToVectorStore({
      vectorStoreId,
      bytes: params.bytes,
      filename: params.title,
      mimeType: params.mimeType,
    });

    let contentText: string | null = null;
    let contentSummary = "";

    if (params.mimeType.includes("text") || params.mimeType.includes("json") || params.mimeType.includes("html") || params.mimeType.includes("markdown")) {
      contentText = params.mimeType.includes("html")
        ? stripHtml(Buffer.from(params.bytes).toString("utf8"))
        : Buffer.from(params.bytes).toString("utf8");
      const summarized = await summarizeContextDocument({
        title: params.title,
        text: contentText,
        tags: inferTags(params.title, contentText, params.tags),
      });
      contentSummary = summarized.summary;
    } else {
      const summarized = await summarizeBinaryDocument({
        title: params.title,
        dataUrl: toDataUrl(params.bytes, params.mimeType),
        filename: params.title,
        mimeType: params.mimeType,
        tags: params.tags,
      });
      contentSummary = summarized.summary;
    }

    await updateContextSourceReady({
      sourceId: created.id,
      title: params.title,
      contentText,
      contentSummary,
      openaiFileId,
      openaiVectorStoreId: vectorStoreId,
    });

    if (params.isCanonical) {
      await refreshOrgProfileArtifact();
    }

    return { sourceId: created.id, title: params.title, contentSummary };
  } catch (error) {
    await markContextSourceFailed(created.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function searchContextForQuestion(params: {
  query: string;
  corpus?: "org" | "internal";
  tags?: string[];
  teamId?: string | null;
  limit: number;
}) {
  return searchContextSources({
    query: params.query,
    corpus: params.corpus,
    tags: params.tags,
    teamId: params.teamId ?? null,
    limit: params.limit,
  });
}

function guessExtension(mimeType: string) {
  if (mimeType.includes("pdf")) return ".pdf";
  if (mimeType.includes("html")) return ".html";
  if (mimeType.includes("json")) return ".json";
  if (mimeType.includes("markdown")) return ".md";
  if (mimeType.includes("text")) return ".txt";
  return ".bin";
}
