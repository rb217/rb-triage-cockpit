const { getPrincipal, isInItTeam, fsGetTicket, fsGetClosedTickets, callClaude, parseJsonResponse } = require("../shared/clients");
const { getFullUserContext } = require("../shared/graph");
const PRIO_MAP = {1:"Low",2:"Medium",3:"High",4:"Urgent"};

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const { ticketId } = req.body || {};
  if (!ticketId) { context.res = { status: 400, body: { error: "ticketId required" } }; return; }
  let ticket; try { ticket = await fsGetTicket(ticketId); } catch(e) { context.res = { status: 404, body: { error: "Ticket not found" } }; return; }
  let m365 = null, similar = [];
  try { if(ticket.requester?.email||ticket.email) m365 = await getFullUserContext(ticket.requester?.email||ticket.email); } catch(e) {}
  try { const closed = await fsGetClosedTickets(30); similar = closed.filter(c=>c.category===ticket.category).slice(0,3); } catch(e) {}
  const m365Block = m365?.found ? `\nRequester M365: account ${m365.accountEnabled?"enabled":"DISABLED"}, MFA ${m365.mfa?.enrolled?"enrolled":"NOT enrolled"}, last sign-in ${m365.signInActivity?.lastSignInDateTime||"unknown"}` : "";
  const histBlock = similar.length ? `\nSimilar resolved tickets:\n${similar.map(t=>`- ${t.subject} → ${t.resolution_note||"(no note)"}`).join("\n")}` : "";
  const prompt = `Draft a helpful IT support reply for this ticket at Renovation Brands. Keep under 150 words. Plain text only. Acknowledge the issue, give clear next steps or ask for missing info, sign as "IT Team".\n\nTicket #${ticket.id}: ${ticket.subject}\nDescription: ${ticket.description_text||""}\nRequester: ${ticket.requester_name||"user"}\nPriority: ${PRIO_MAP[ticket.priority]||"?"}\n${m365Block}${histBlock}\n\nReturn ONLY JSON: {"reply":"<text>","confidence":<0-100>,"rationale":"<troubleshooting|resolution|info-request|escalation>","needsHumanReview":<true|false>}`;
  try {
    const draft = parseJsonResponse(await callClaude(prompt, { maxTokens: 1200 }));
    context.res = { body: { ticketId, ...draft, m365ContextUsed: !!m365?.found, similarCount: similar.length } };
  } catch(err) { context.res = { status: 500, body: { error: err.message } }; }
};
