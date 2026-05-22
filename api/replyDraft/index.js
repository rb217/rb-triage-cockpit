// api/replyDraft/index.js
// POST /api/replyDraft
// Body: { ticketId }
// Returns AI-drafted reply text + a confidence score. Does NOT send.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  fsGetTicket, fsGetClosedTickets,
  callClaude, parseJsonResponse
} = require("../shared/clients");
const { getFullUserContext } = require("../shared/graph");

const PRIO_MAP = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };

function buildReplyPrompt(ticket, m365Context, similarResolved) {
  const m365Block = m365Context?.found ? `
M365 STATE for the requester:
- Account enabled: ${m365Context.accountEnabled}
- MFA enrolled: ${m365Context.mfa?.enrolled}
- Last sign-in: ${m365Context.signInActivity?.lastSignInDateTime || "unknown"}
- Risky sign-ins (7d): ${m365Context.riskySignIns?.length || 0}
- Department: ${m365Context.department || "?"}` : "";

  const historyBlock = similarResolved?.length ? `
SIMILAR PREVIOUSLY-RESOLVED TICKETS (for pattern recognition):
${similarResolved.map(t => `- #${t.id}: ${t.subject} → resolved by: ${t.resolution_note || "(no note)"}`).join("\n")}` : "";

  return `You are drafting a customer reply for an IT support ticket at Renovation Brands. Write a helpful, professional reply that addresses the user's issue.

TICKET #${ticket.id}
Subject: ${ticket.subject}
Description: ${ticket.description_text || ticket.description || ""}
Requester: ${ticket.requester_name || "the user"}
Priority: ${PRIO_MAP[ticket.priority] || "?"}
${m365Block}
${historyBlock}

REPLY GUIDELINES:
- Acknowledge the issue in 1 sentence
- Give clear next steps OR ask for missing info (pick one — don't mix)
- For known issues that match similar tickets, use the resolution that worked before
- For M365 issues where context shows the actual problem (locked account, expired password, no MFA), tell them what we already see
- Tone: warm but professional, no corporate fluff, no "we appreciate your patience"
- Sign as "IT Team" — don't impersonate a specific person
- Keep under 150 words
- Plain text only, no markdown

Return ONLY this JSON:
{
  "reply": "<the drafted reply text>",
  "confidence": <0-100 — how confident you are this fully resolves the issue>,
  "rationale": "<one sentence on what type of reply you wrote: troubleshooting | resolution | info-request | escalation>",
  "needsHumanReview": <true if confidence < 75 OR if the issue involves access changes, billing, sensitive data, or anyone above director level>
}`;
}

app.http("replyDraft", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    let body;
    try { body = await request.json(); } catch { return { status: 400, jsonBody: { error: "Invalid JSON" } }; }

    const { ticketId } = body;
    if (!ticketId) return { status: 400, jsonBody: { error: "ticketId required" } };

    let ticket;
    try {
      ticket = await fsGetTicket(ticketId);
    } catch (err) {
      return { status: 404, jsonBody: { error: "Ticket not found" } };
    }

    // Best-effort enrichments (don't fail if these don't load)
    let m365Context = null;
    let similarResolved = [];
    try {
      if (ticket.requester?.email || ticket.email) {
        m365Context = await getFullUserContext(ticket.requester?.email || ticket.email);
      }
    } catch (e) { context.log.warn("M365 lookup failed: " + e.message); }

    try {
      // Lightweight: get a small pool of closed tickets to feed in as patterns
      const closed = await fsGetClosedTickets(30);
      similarResolved = closed
        .filter(c => c.category === ticket.category)
        .slice(0, 3);
    } catch (e) { context.log.warn("Closed ticket lookup failed: " + e.message); }

    try {
      const raw = await callClaude(buildReplyPrompt(ticket, m365Context, similarResolved), { maxTokens: 1200 });
      const draft = parseJsonResponse(raw);
      return {
        jsonBody: {
          ticketId,
          ...draft,
          m365ContextUsed: !!m365Context?.found,
          similarCount: similarResolved.length
        }
      };
    } catch (err) {
      context.log.error("Draft failed: " + err.message);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});
