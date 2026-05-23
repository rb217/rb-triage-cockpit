const { getPrincipal, isInItTeam, callClaude, parseJsonResponse } = require("../shared/clients");

const PRIO_MAP = { 1:"Low", 2:"Medium", 3:"High", 4:"Urgent" };
const STATUS_MAP = { 2:"Open", 3:"Pending", 4:"Resolved", 5:"Closed", 6:"Hold" };

const PROMPTS = {
  summarize: (p) => `You are an IT triage assistant for Renovation Brands. Analyze this Freshservice ticket and return ONLY valid JSON.\n\nTicket #${p.id}\nSubject: ${p.subject}\nDescription: ${p.description_text||"(none)"}\nCategory: ${p.category||"—"} / ${p.sub_category||"—"}\nPriority: ${PRIO_MAP[p.priority]||"?"}\nAssignee: ${p.responder_name||"unassigned"}\nRequester: ${p.requester_name||"unknown"}\n\nCategories: Hardware (Computer, Printer, Phone, Peripherals), Software (Microsoft 365, Adobe Creative Cloud, Windows, AI Tools, RingCentral, Other), Network (Connectivity, VPN, Access, Wireless), NetSuite (Access and Permissions, Data Update, Reporting, Configuration, Integrations), Employee Onboarding/Offboarding (Onboarding, Offboarding, Asset Reclaim), Other.\n\nIT team: Nathan Maharg, Steve Mitchell, Eric Hnatov.\n\nReturn JSON only:\n{"summary":"<1-2 sentence description>","suggestions":{"category":"<>","sub_category":"<>","priority":"<Low|Medium|High|Urgent>","assignee":"<agent name>"},"resolutions":["<step 1>","<step 2>","<step 3>"],"nextAction":"<single next thing>","confidence":"<low|medium|high>"}`,
  
  similar: (p) => `Find the top 3 most similar closed tickets to this open ticket. Return ONLY a JSON array.\n\nCURRENT:\nID: ${p.ticket.id}\nSubject: ${p.ticket.subject}\nDescription: ${p.ticket.description_text||""}\nCategory: ${p.ticket.category||""} / ${p.ticket.sub_category||""}\n\nCLOSED TICKETS:\n${p.candidates.map(c=>`---\nID: ${c.id}\nSubject: ${c.subject}\nDescription: ${c.description_text||""}\nCategory: ${c.category||""} / ${c.sub_category||""}\nResolution: ${c.resolution_note||""}`).join("\n")}\n\nReturn: [{"id":<id>,"match":<0-100>,"reason":"<why>"}]\nOnly include matches >= 50. Order by match descending.`,
  
  queue: (p) => `Rank these tickets in order of what IT should tackle FIRST today. Consider SLA risk, business impact, and urgency. Return ONLY a JSON array of up to 5 items.\n\nTICKETS:\n${p.candidates.map(t=>`---\nID: ${t.id} | Priority: ${PRIO_MAP[t.priority]} | Status: ${STATUS_MAP[t.status]}\nSubject: ${t.subject}\nDescription: ${(t.description_text||"").slice(0,200)}\nRequester: ${t.requester_name||"unknown"}\nSLA: ${t.due_by?(new Date(t.due_by)<new Date()?"BREACHED":t.due_by):"none"}\nAssignee: ${t.responder_name||"unassigned"}`).join("\n")}\n\nReturn: [{"id":<id>,"reason":"<one sentence>"}]`,
  
  patterns: (p) => `Detect PATTERNS or CLUSTERS across these open IT tickets — issues pointing to a common root cause. Return ONLY a JSON array. Empty array if no patterns.\n\nTICKETS:\n${p.tickets.map(t=>`---\nID: ${t.id} | ${PRIO_MAP[t.priority]} | ${t.category||""} / ${t.sub_category||""}\nSubject: ${t.subject}\nDesc: ${(t.description_text||"").slice(0,250)}\nRequester: ${t.requester_name||"?"}`).join("\n")}\n\nReturn: [{"tag":"<2-3 words>","title":"<headline>","description":"<2-3 sentences>","severity":"<low|med|high>","ticketIds":[<ids>],"recommendation":"<action>"}]\nOnly report patterns where 2+ tickets share a probable root cause.`
};

const TOKEN_LIMITS = { summarize: 1000, similar: 800, queue: 800, patterns: 2000 };

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const { mode, payload } = req.body || {};
  if (!PROMPTS[mode]) { context.res = { status: 400, body: { error: "Unknown mode: " + mode } }; return; }
  try {
    const raw = await callClaude(PROMPTS[mode](payload), { maxTokens: TOKEN_LIMITS[mode] });
    context.res = { body: { result: parseJsonResponse(raw) } };
  } catch(err) {
    context.log.error("aiTriage failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
