// api/webhookTicketCreated/index.js
// POST /api/webhookTicketCreated
// Receives Freshservice webhook when a new ticket is created, auto-triages with AI.
// Confidence threshold: 70% per field. Always adds a private note with the decision.

const { app } = require("@azure/functions");
const {
  getSecret, fsGetTicket, fsUpdateTicket, fsAddNote, fsGetRequester, fsFindAgentByName,
  callClaude, parseJsonResponse
} = require("../shared/clients");
const { getFullUserContext } = require("../shared/graph");

const CONFIDENCE_THRESHOLD = 70;

const PRIO_MAP = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
const PRIO_NAME_TO_NUM = { Low: 1, Medium: 2, High: 3, Urgent: 4 };

function buildTriagePrompt(ticket, m365Context) {
  const ctxBlock = m365Context && m365Context.found
    ? `M365 CONTEXT FOR REQUESTER:
- Account: ${m365Context.accountEnabled ? "enabled" : "DISABLED"}
- Title: ${m365Context.jobTitle || "?"} (${m365Context.department || "?"})
- Last sign-in: ${m365Context.signInActivity?.lastSignInDateTime || "unknown"}
- MFA: ${m365Context.mfa?.enrolled ? "enrolled" : "NOT enrolled"}
- Risky sign-ins (7d): ${m365Context.riskySignIns?.length || 0}
- Manager: ${m365Context.manager?.displayName || "?"}`
    : `M365 CONTEXT: requester not found in directory`;

  return `You are an IT triage assistant for Renovation Brands. A new ticket just arrived. Classify it and return ONLY valid JSON. Give a confidence score 0-100 for EACH field.

NEW TICKET:
Subject: ${ticket.subject}
Description: ${ticket.description_text || "(none)"}
Requester: ${ticket.requester_name || "unknown"}

${ctxBlock}

Categories: Hardware (Computer, Printer, Phone, Peripherals), Software (Microsoft 365, Adobe Creative Cloud, Windows, AI Tools, RingCentral, Other), Network (Connectivity, VPN, Access, Wireless), NetSuite (Access and Permissions, Data Update, Reporting, Configuration, Integrations), Employee Onboarding/Offboarding (Onboarding, Offboarding, Asset Reclaim), Other.

IT team agents: Nathan Maharg (general IT + M365 + NetSuite), Steve Mitchell (network + VPN + NetSuite reporting), Eric Hnatov (hardware + asset reclaim).

Consider M365 context: if the requester's account is disabled or has risky sign-ins, the priority should likely be higher. If they have no MFA and the ticket is about access, suggest MFA enrollment as the resolution.

Return JSON only:
{
  "category": "<category>",
  "category_confidence": <0-100>,
  "sub_category": "<sub-category>",
  "sub_category_confidence": <0-100>,
  "priority": "<Low|Medium|High|Urgent>",
  "priority_confidence": <0-100>,
  "assignee": "<agent name or 'any IT'>",
  "assignee_confidence": <0-100>,
  "reasoning": "<one sentence explaining the classification>",
  "context_relevance": "<one sentence on how M365 context influenced this, or 'no impact'>"
}`;
}

app.http("webhookTicketCreated", {
  methods: ["POST"],
  authLevel: "anonymous", // SWA route doesn't enforce auth for webhooks; we check secret token instead
  handler: async (request, context) => {
    // ============================================================
    // 1. Validate shared secret
    // ============================================================
    const providedSecret = request.headers.get("x-fs-webhook-secret") ||
                           new URL(request.url).searchParams.get("token");
    let expectedSecret;
    try {
      expectedSecret = await getSecret("FRESHSERVICE-WEBHOOK-SECRET");
    } catch (e) {
      context.log.error("Webhook secret not configured in Key Vault");
      return { status: 500, jsonBody: { error: "Server not configured" } };
    }
    if (!providedSecret || providedSecret !== expectedSecret) {
      context.log.warn("Webhook called with invalid secret");
      return { status: 401, jsonBody: { error: "Unauthorized" } };
    }

    // ============================================================
    // 2. Parse webhook payload — Freshservice sends ticket_id
    // ============================================================
    let payload;
    try {
      payload = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "Invalid JSON" } };
    }

    const ticketId = payload.ticket_id || payload.id || payload.freshservice_webhook?.ticket_id;
    if (!ticketId) {
      return { status: 400, jsonBody: { error: "No ticket_id in payload" } };
    }

    context.log(`Auto-triage starting for ticket #${ticketId}`);

    // ============================================================
    // 3. Fetch full ticket details
    // ============================================================
    let ticket;
    try {
      ticket = await fsGetTicket(ticketId);
    } catch (err) {
      context.log.error(`Could not fetch ticket #${ticketId}: ${err.message}`);
      return { status: 200, jsonBody: { skipped: true, reason: "ticket not found" } };
    }

    // Skip if it already has explicit category set (likely set by user or another agent)
    // This prevents us from overwriting human work
    if (ticket.category && ticket.category !== "Other" && ticket.category !== "") {
      context.log(`Ticket #${ticketId} already has category '${ticket.category}', skipping`);
      return { jsonBody: { skipped: true, reason: "already categorized" } };
    }

    // ============================================================
    // 4. Enrich with M365 context (best effort)
    // ============================================================
    let m365Context = null;
    if (ticket.requester?.email || ticket.email) {
      try {
        const email = ticket.requester?.email || ticket.email;
        m365Context = await getFullUserContext(email);
      } catch (err) {
        context.log.warn(`M365 lookup failed: ${err.message}`);
      }
    }

    // ============================================================
    // 5. Call Claude for classification
    // ============================================================
    const ticketForAi = {
      id: ticket.id,
      subject: ticket.subject,
      description_text: ticket.description_text || (ticket.description || "").replace(/<[^>]+>/g, " "),
      requester_name: ticket.requester?.name || `${ticket.requester?.first_name || ""} ${ticket.requester?.last_name || ""}`.trim()
    };

    let triage;
    try {
      const raw = await callClaude(buildTriagePrompt(ticketForAi, m365Context), { maxTokens: 1000 });
      triage = parseJsonResponse(raw);
    } catch (err) {
      context.log.error(`AI triage failed for #${ticketId}: ${err.message}`);
      return { status: 200, jsonBody: { skipped: true, reason: "AI failed", error: err.message } };
    }

    // ============================================================
    // 6. Build updates based on confidence threshold
    // ============================================================
    const updates = {};
    const applied = [];
    const skipped = [];

    if (triage.category_confidence >= CONFIDENCE_THRESHOLD) {
      updates.category = triage.category;
      applied.push(`Category: ${triage.category} (${triage.category_confidence}%)`);
    } else {
      skipped.push(`Category: would be ${triage.category} but only ${triage.category_confidence}% confident`);
    }

    if (triage.sub_category_confidence >= CONFIDENCE_THRESHOLD && triage.sub_category) {
      updates.sub_category = triage.sub_category;
      applied.push(`Sub-cat: ${triage.sub_category} (${triage.sub_category_confidence}%)`);
    } else if (triage.sub_category) {
      skipped.push(`Sub-cat: would be ${triage.sub_category} but only ${triage.sub_category_confidence}% confident`);
    }

    if (triage.priority_confidence >= CONFIDENCE_THRESHOLD && triage.priority) {
      const prio = PRIO_NAME_TO_NUM[triage.priority];
      if (prio && prio !== ticket.priority) {
        updates.priority = prio;
        applied.push(`Priority: ${triage.priority} (${triage.priority_confidence}%)`);
      }
    } else if (triage.priority) {
      skipped.push(`Priority: would be ${triage.priority} but only ${triage.priority_confidence}% confident`);
    }

    if (triage.assignee_confidence >= CONFIDENCE_THRESHOLD && triage.assignee && triage.assignee !== "any IT") {
      const agentId = await fsFindAgentByName(triage.assignee);
      if (agentId) {
        updates.responder_id = agentId;
        applied.push(`Assigned: ${triage.assignee} (${triage.assignee_confidence}%)`);
      }
    } else if (triage.assignee) {
      skipped.push(`Assignee: would be ${triage.assignee} but only ${triage.assignee_confidence}% confident`);
    }

    // ============================================================
    // 7. Apply updates + post private note
    // ============================================================
    let updateError = null;
    if (Object.keys(updates).length > 0) {
      try {
        await fsUpdateTicket(ticketId, updates);
      } catch (err) {
        updateError = err.message;
        context.log.error(`Update failed for #${ticketId}: ${err.message}`);
      }
    }

    // Build the audit note
    const noteLines = [
      "[🤖 AI Triage]",
      `Reasoning: ${triage.reasoning || "(none)"}`,
      ""
    ];
    if (m365Context?.found) {
      noteLines.push(`M365 context applied: ${triage.context_relevance || "no specific impact"}`);
      noteLines.push("");
    }
    if (applied.length) {
      noteLines.push("Applied:");
      applied.forEach(a => noteLines.push(`  ✓ ${a}`));
    }
    if (skipped.length) {
      noteLines.push("");
      noteLines.push(`Below ${CONFIDENCE_THRESHOLD}% threshold (left as-is):`);
      skipped.forEach(s => noteLines.push(`  • ${s}`));
    }
    if (updateError) {
      noteLines.push("");
      noteLines.push(`⚠ Some updates failed: ${updateError}`);
    }

    try {
      await fsAddNote(ticketId, noteLines.join("\n"), true);
    } catch (err) {
      context.log.warn(`Could not add audit note: ${err.message}`);
    }

    context.log(`Auto-triage complete for #${ticketId}: ${applied.length} applied, ${skipped.length} skipped`);

    return {
      jsonBody: {
        ticketId,
        applied,
        skipped,
        updateError,
        m365ContextUsed: !!m365Context?.found
      }
    };
  }
});
