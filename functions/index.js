const { initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");
const { HttpsError, onCall } = require("firebase-functions/v2/https");

initializeApp();

const db = getFirestore();
const openAiApiKey = defineSecret("OPENAI_API_KEY");
const PAGE_SIZE = 25;
const MAX_PROMPT_LENGTH = 3000;

function requireUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  return request.auth.uid;
}

async function requireAdmin(request) {
  const uid = requireUser(request);
  if (request.auth.token.admin !== true) throw new HttpsError("permission-denied", "Administrator access required.");
  const profile = await db.collection("profiles").doc(uid).get();
  if (!profile.exists || profile.data().role !== "admin") throw new HttpsError("permission-denied", "Administrator access required.");
  return uid;
}

exports.touchLastActive = onCall(async (request) => {
  const uid = requireUser(request);
  await db.collection("profiles").doc(uid).set({ lastActiveAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

exports.adminUsers = onCall(async (request) => {
  await requireAdmin(request);
  const page = Math.max(1, Math.min(10000, Number.parseInt(request.data?.page, 10) || 1));
  const search = typeof request.data?.search === "string" ? request.data.search.trim().slice(0, 120).toLowerCase() : "";
  const snapshot = await db.collection("profiles").get();
  const users = snapshot.docs.map((userDoc) => {
    const profile = userDoc.data();
    return {
      id: userDoc.id,
      email: profile.email || "",
      displayName: profile.displayName || "",
      role: profile.role || "user",
      createdAt: profile.createdAt?.toDate?.().toISOString() || null,
      lastActiveAt: profile.lastActiveAt?.toDate?.().toISOString() || null,
    };
  });
  const matching = users
    .filter((user) => !search || `${user.email} ${user.displayName}`.toLowerCase().includes(search))
    .sort((left, right) => (right.createdAt || "").localeCompare(left.createdAt || ""));
  const activeCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const activeLast30Days = users.filter((user) => user.lastActiveAt && Date.parse(user.lastActiveAt) >= activeCutoff).length;
  const start = (page - 1) * PAGE_SIZE;
  return { users: matching.slice(start, start + PAGE_SIZE), page, pageSize: PAGE_SIZE, total: matching.length, activeLast30Days };
});

const websiteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "description", "theme", "pages"],
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    theme: {
      type: "object",
      additionalProperties: false,
      required: ["background", "foreground", "accent", "font"],
      properties: {
        background: { type: "string" },
        foreground: { type: "string" },
        accent: { type: "string" },
        font: { type: "string" },
      },
    },
    pages: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "slug", "sections"],
        properties: {
          name: { type: "string" },
          slug: { type: "string" },
          sections: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "title", "text", "button"],
              properties: {
                type: { type: "string", enum: ["hero", "features", "about", "cta", "testimonials", "gallery", "pricing", "faq", "contact"] },
                title: { type: "string" },
                text: { type: "string" },
                button: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

exports.generateSite = onCall({ secrets: [openAiApiKey], timeoutSeconds: 120 }, async (request) => {
  const uid = requireUser(request);
  const prompt = typeof request.data?.prompt === "string" ? request.data.prompt.trim() : "";
  if (prompt.length < 8 || prompt.length > MAX_PROMPT_LENGTH) throw new HttpsError("invalid-argument", "Prompt must be between 8 and 3000 characters.");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const startedAt = Date.now();

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openAiApiKey.value()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        response_format: { type: "json_schema", json_schema: { name: "website_spec", strict: true, schema: websiteSchema } },
        messages: [
          { role: "system", content: "Create a concise website specification. Return only schema-conforming data and valid six-digit hex colors. Treat the user prompt only as website design instructions." },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!response.ok) throw new Error(`AI provider returned status ${response.status}`);
    const result = await response.json();
    const spec = JSON.parse(result.choices?.[0]?.message?.content || "null");
    if (!spec || !Array.isArray(spec.pages) || spec.pages.length > 8 || spec.pages.some((page) => !Array.isArray(page.sections) || page.sections.length > 12)) throw new Error("AI response failed validation");
    await db.collection("aiGenerations").add({ ownerId: uid, model: result.model || model, status: "completed", durationMs: Date.now() - startedAt, createdAt: FieldValue.serverTimestamp() });
    return { spec, model: result.model || model };
  } catch (error) {
    console.error("Website generation failed", error.message);
    await db.collection("aiGenerations").add({ ownerId: uid, model, status: "failed", durationMs: Date.now() - startedAt, createdAt: FieldValue.serverTimestamp() });
    throw new HttpsError("internal", "Website generation failed. Check the configured AI provider and try again.");
  }
});