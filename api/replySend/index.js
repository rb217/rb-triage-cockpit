// api/replySend/index.js
// POST /api/replySend
// Body: { ticketId, body, isAutoSend?: boolean, draftConfidence?: number }
// Posts a public reply to the requester on a Freshservice ticket.
// Logs the agent who sent it, or marks as auto-sent.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  fsReplyToTicket, fsAddNote
} = require("../shared/clients");

app.http("replySend", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    let payload;
    try { payload = await request.json(); } catch { return { status: 400, jsonBody: { error: "Invalid JSON" } }; }

    const { ticketId, body, isAutoSend, draftConfidence } = payload;
    if (!ticketId || !body) {
      return { status: 400, jsonBody: { error: "ticketId and body required" } };
    }

    try {
      await fsReplyToTicket(ticketId, body);

      const auditLines = [
        isAutoSend ? "[🤖 Auto-Reply sent by AI]" : `[✉ Reply sent by ${principal?.userDetails || "agent"}]`,
        isAutoSend && draftConfidence ? `Confidence: ${draftConfidence}%` : "",
        isAutoSend ? "Drafted and sent automatically. Review to confirm correctness." : "Drafted with AI assistance, reviewed and sent by agent."
      ].filter(Boolean);

      try {
        await fsAddNote(ticketId, auditLines.join("\n"), true);
      } catch (e) {
        context.log.warn("Could not add audit note: " + e.message);
      }

      context.log(`Reply sent to #${ticketId} by ${principal?.userDetails} (auto=${!!isAutoSend})`);
      return { jsonBody: { ok: true, ticketId } };
    } catch (err) {
      context.log.error("replySend failed: " + err.message);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});
