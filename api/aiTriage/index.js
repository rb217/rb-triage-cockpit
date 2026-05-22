// api/aiTriage/index.js
// POST /api/aiTriage
// Body: { mode: "summarize"|"similar"|"queue"|"patterns", payload: {...} }
// Proxies Claude API so the key stays server-side.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  callClaude, parseJsonResponse
} = require("../shared/clients");

const PRIO_MAP = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
const STATUS_MAP = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed", 6: "Hold" };

const PROMPTS = {
  summarize: (t) => `You are an IT triage assistant for Renovation Brands. Analyze this Freshservice ticket and return ONLY valid JSON.

Ticket #${t.id}
Subject: ${t.subject}
Description: ${t.description_text || "(none)"}
Current category: ${t.category || "—"} / ${t.sub_category || "—"}
Current priority: ${PRIO_MAP[t.priority] || "?"}
Current assignee: ${t.responder_name || "unassigned"}
Requester: ${t.requester_name || "unknown"}

Categories: Hardware (Computer, Printer, Phone, Peripherals), Software (Microsoft 365, Adobe Creative Cloud, Windows, AI Tools, RingCentral, Other), Network (Connectivity, VPN, Access, Wireless), NetSuite (Access and Permissions, Data Update, Reporting, Configuration, Integrations), Employee Onboarding/Offboarding (Onboarding, Offboarding, Asset Reclaim), Other.

IT team: Nathan Maharg, Steve Mitchell, Eric Hnatov.

Return JSON only:
{
  "summary": "<one or two sentence plain-English description>",
  "suggestions": {"category":"<>","sub_category":"<>","priority":"<Low|Medium|High|Urgent>","assignee":"<agent name or 'any IT'>"},
  "resolutions": ["<step 1>","<step 2>","<step 3>"],
  "nextAction": "<single most useful next thing in one sentence>",
  "confidence": "<low|medium|high>"
}`,

  similar: ({ ticket, candidates }) => `Find tickets from this list of closed tickets that are most similar to the current open ticket. Return ONLY a JSON array of the top 3 matches (or fewer if none are clearly similar).

CURRENT TICKET:
ID: ${ticket.id}
Subject: ${ticket.subject}
Description: ${ticket.description_text || ""}
Category: ${ticket.category || ""} / ${ticket.sub_category || ""}

CLOSED TICKETS:
${candidates.map(c => `---
ID: ${c.id}
Subject: ${c.subject}
Description: ${c.description_text || ""}
Category: ${c.category || ""} / ${c.sub_category || ""}
Resolution: ${c.resolution_note || ""}`).join("\n")}

Return JSON array only:
[{"id": <closed_ticket_id>, "match": <0-100 similarity score>, "reason": "<one sentence why>"}]

Only include matches with score >= 50. Order by match descending.`,

  queue: ({ candidates }) => `You are an IT triage advisor for Nathan at Renovation Brands. Rank these tickets in order of what should be tackled FIRST today, considering SLA risk, business impact, urgency, and how long each likely takes. Return ONLY a JSON array of up to 5 items.

TICKETS:
${candidates.map(t => `---
ID: ${t.id} | Priority: ${PRIO_MAP[t.priority]} | Status: ${STATUS_MAP[t.status]}
Subject: ${t.subject}
Description: ${(t.description_text || "").slice(0, 200)}
Requester: ${t.requester_name || "unknown"}
SLA: ${t.due_by ? (new Date(t.due_by) < new Date() ? "BREACHED" : t.due_by) : "none"}
Assignee: ${t.responder_name || "unassigned"}`).join("\n")}

Return JSON only: [{"id": <ticket_id>, "reason": "<one short sentence>"}]`,

  patterns: ({ tickets }) => `You are an IT operations analyst. Look across these open IT tickets and detect PATTERNS or CLUSTERS — issues that affect multiple users, point to a common root cause, or signal a systemic problem (not isolated complaints). Examples: "3 tickets about wifi in the same conference room" (likely AP issue), "5 NetSuite errors in 24h" (likely integration failure).

Return ONLY a JSON array. Empty array if no meaningful patterns. Aim for 0-5 patterns.

TICKETS:
${tickets.map(t => `---
ID: ${t.id} | ${PRIO_MAP[t.priority]} | ${t.category || ""} / ${t.sub_category || ""}
Subject: ${t.subject}
Desc: ${(t.description_text || "").slice(0, 250)}
Requester: ${t.requester_name || "?"}`).join("\n")}

Return JSON only:
[{"tag":"<2-3 word label>","title":"<headline>","description":"<2-3 sentences>","severity":"<low|med|high>","ticketIds":[<id1>,<id2>],"recommendation":"<concrete action>"}]

Only report patterns where 2+ tickets share a probable root cause.`
};

app.http("aiTriage", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON body" } };
    }

    const { mode, payload } = body;
    if (!PROMPTS[mode]) {
      return { status: 400, jsonBody: { error: `Unknown mode: ${mode}` } };
    }

    const tokenLimits = { summarize: 1000, similar: 800, queue: 800, patterns: 2000 };

    try {
      const prompt = PROMPTS[mode](payload);
      const raw = await callClaude(prompt, { maxTokens: tokenLimits[mode] });
      const parsed = parseJsonResponse(raw);
      return { jsonBody: { result: parsed } };
    } catch (err) {
      context.log.error(`aiTriage ${mode} failed`, err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});
