const asyncHandler = require("express-async-handler");
const AnthropicPkg = require("@anthropic-ai/sdk");
// CJS interop: the constructor is the default export on recent builds.
const Anthropic = AnthropicPkg.default || AnthropicPkg;

// Lazy client so the server still boots without the key (the feature just
// returns a clear error until ANTHROPIC_API_KEY is set in the env).
let _client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_client) _client = new Anthropic();
  return _client;
}

// The shape we force Claude to return — it mirrors the structured-question
// builder, so the extracted output drops straight into it. Strict structured
// output requires every field present + additionalProperties:false, so the
// model fills empty strings/arrays where a field doesn't apply.
const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          // Cm = single-choice, Cs = multi-select, Co = open, Cma = matching.
          type: { type: "string", enum: ["Cm", "Cs", "Co", "Cma"] },
          text: { type: "string" },
          latex: { type: "string" },
          choices: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { text: { type: "string" }, latex: { type: "string" } },
              required: ["text", "latex"],
            },
          },
          // Correct choice indices — ONLY when the PDF explicitly marks them;
          // otherwise an empty array (the teacher marks the answer).
          correct: { type: "array", items: { type: "integer" } },
          pairs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                left: { type: "string" },
                leftLatex: { type: "string" },
                right: { type: "string" },
                rightLatex: { type: "string" },
              },
              required: ["left", "leftLatex", "right", "rightLatex"],
            },
          },
          // True when the question relies on a figure/diagram the teacher must
          // upload manually (Claude can read a figure but can't hand back an image).
          hasFigure: { type: "boolean" },
          openAnswer: { type: "string" },
          explanation: { type: "string" },
        },
        required: [
          "type",
          "text",
          "latex",
          "choices",
          "correct",
          "pairs",
          "hasFigure",
          "openAnswer",
          "explanation",
        ],
      },
    },
  },
  required: ["questions"],
};

const SYSTEM_PROMPT = `You extract exam questions from a PDF into structured data for a math exam platform. The exam content is in Azerbaijani; keep all text in its original language.

Output one item per question, in document order, using these types:
- "Cm": single correct answer among options.
- "Cs": multiple correct answers among options (only when the question clearly allows more than one).
- "Co": open / free-text answer (no options).
- "Cma": matching (left column items paired with right column items).

Rules:
- "text": the question statement as plain text. Put any mathematical formula in "latex" as a valid KaTeX/LaTeX string (e.g. "\\\\frac{a}{b}", "\\\\int_0^1 x^2\\\\,dx"). Use "latex" on a choice/pair side the same way. If there is no formula, use an empty string "".
- "choices": for Cm/Cs, one object per option in the order shown (drop the A/B/C labels — they are implicit by position). For Co/Cma, use an empty array.
- "correct": indices (0-based) into "choices" of the correct option(s) — ONLY if the PDF itself marks/states the correct answer (e.g. an answer key, a highlighted option, or a stated solution). If the correct answer is NOT given in the PDF, return an EMPTY array. NEVER guess or solve the question to fill this — leave it empty for the teacher to mark.
- "pairs": for Cma, one object per correct left<->right pair. Empty array otherwise. Right values must be distinct.
- "openAnswer": for Co, the correct answer text ONLY if the PDF states it; otherwise "".
- "hasFigure": true if the question depends on a diagram, graph, geometric figure, or image that cannot be represented as text/LaTeX (the teacher will add the image). Still extract the surrounding text.
- "explanation": a worked solution/explanation ONLY if the PDF provides one; otherwise "".

Transcribe faithfully. Do not invent questions, options, or answers. If the PDF is a question bank with no answer key, every "correct" array is empty and that is correct.`;

// Extract structured questions from an uploaded PDF using Claude. Teacher-only.
// Returns { questions: [...] } in the builder's shape for review (never saved
// automatically — the teacher reviews, fixes, marks answers, and saves).
const extractQuestions = asyncHandler(async (req, res) => {
  const client = getClient();
  if (!client) {
    res.status(503);
    throw new Error("AI funksiyası konfiqurasiya olunmayıb (ANTHROPIC_API_KEY)");
  }
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    res.status(400);
    throw new Error("PDF fayl lazımdır");
  }
  if (req.file.mimetype && req.file.mimetype !== "application/pdf") {
    res.status(400);
    throw new Error("Yalnız PDF fayl dəstəklənir");
  }

  const base64 = req.file.buffer.toString("base64");

  let message;
  try {
    message = await client.messages
      .stream({
        model: "claude-opus-4-8",
        max_tokens: 32000,
        thinking: { type: "adaptive" },
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        output_config: {
          effort: "high",
          format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: base64 },
              },
              { type: "text", text: "Bu PDF-dəki bütün sualları çıxar." },
            ],
          },
        ],
      })
      .finalMessage();
  } catch (e) {
    console.error("AI extract error:", e?.status, e?.message);
    res.status(502);
    throw new Error("AI emalı alınmadı. Bir az sonra yenidən cəhd edin.");
  }

  if (message.stop_reason === "refusal") {
    res.status(422);
    throw new Error("AI bu sənədi emal edə bilmədi.");
  }

  const textBlock = message.content.find((b) => b.type === "text");
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text || "{}");
  } catch {
    res.status(502);
    throw new Error("AI cavabı oxunmadı. Yenidən cəhd edin.");
  }

  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  res.status(200).json({ success: true, questions, usage: message.usage });
});

module.exports = { extractQuestions };
