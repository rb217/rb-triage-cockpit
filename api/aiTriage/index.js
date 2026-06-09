const { getPrincipal, isInItTeam, callClaude, parseJsonResponse } = require("../shared/clients");

const PRIO_MAP   = { 1:"Low", 2:"Medium", 3:"High", 4:"Urgent" };
const STATUS_MAP = { 2:"Open", 3:"Pending", 4:"Resolved", 5:"Closed", 6:"Hold" };

const PROMPTS = {
  summarize: (p) => `You are an IT triage assistant for Renovation Brands. Analyze this Freshservice ticket and return ONLY valid JSON.

Ticket #${p.id}
Subject: ${p.subject}
Description: ${p.description_text||"(none)"}
Category: ${p.category||"—"} / ${p.sub_category||"—"}
Priority: ${PRIO_MAP[p.priority]||"?"}
Assignee: ${p.responder_name||"unassigned"}
Requester: ${p.requester_name||"unknown"}

Categories: Hardware (Computer, Printer, Phone, Peripherals), Software (Microsoft 365, Adobe Creative Cloud, Windows, AI Tools, RingCentral, Other), Network (Connectivity, VPN, Access, Wireless), NetSuite (Access and Permissions, Data Update, Reporting, Configuration, Integrations), Employee Onboarding/Offboarding (Onboarding, Offboarding, Asset Reclaim), Other.

IT team: Nathan Maharg, Steve Mitchell, Eric Hnatov.

Return JSON only:
{"summary":"<1-2 sentence description>","suggestions":{"category":"<>","sub_category":"<>","priority":"<Low|Medium|High|Urgent>","assignee":"<agent name>"},"resolutions":["<step 1>","<step 2>","<step 3>"],"nextAction":"<single next thing>","confidence":"<low|medium|high>"}`,

  similar: (p) => `Find the top 3 most similar closed tickets to this open ticket. Return ONLY a JSON array.

CURRENT:
ID: ${p.ticket.id}
Subject: ${p.ticket.subject}
Description: ${p.ticket.description_text||""}
Category: ${p.ticket.category||""} / ${p.ticket.sub_category||""}

CLOSED TICKETS:
${p.candidates.map(c=>`---\nID: ${c.id}\nSubject: ${c.subject}\nDescription: ${c.description_text||""}\nCategory: ${c.category||""} / ${c.sub_category||""}\nResolution: ${c.resolution_note||""}`).join("\n")}

Return: [{"id":<id>,"match":<0-100>,"reason":"<why>"}]
Only include matches >= 50. Order by match descending.`,

  queue: (p) => `Rank these tickets in order of what IT should tackle FIRST today. Consider SLA risk, business impact, and urgency. Return ONLY a JSON array of up to 5 items.

TICKETS:
${p.candidates.map(t=>`---\nID: ${t.id} | Priority: ${PRIO_MAP[t.priority]} | Status: ${STATUS_MAP[t.status]}\nSubject: ${t.subject}\nDescription: ${(t.description_text||"").slice(0,200)}\nRequester: ${t.requester_name||"unknown"}\nSLA: ${t.due_by?(new Date(t.due_by)<new Date()?"BREACHED":t.due_by):"none"}\nAssignee: ${t.responder_name||"unassigned"}`).join("\n")}

Return: [{"id":<id>,"reason":"<one sentence>"}]`,

  patterns: (p) => `Detect PATTERNS or CLUSTERS across these open IT tickets — issues pointing to a common root cause. Return ONLY a JSON array. Empty array if no patterns.

TICKETS:
${p.tickets.map(t=>`---\nID: ${t.id} | ${PRIO_MAP[t.priority]} | ${t.category||""} / ${t.sub_category||""}\nSubject: ${t.subject}\nDesc: ${(t.description_text||"").slice(0,250)}\nRequester: ${t.requester_name||"?"}`).join("\n")}

Return: [{"tag":"<2-3 words>","title":"<headline>","description":"<2-3 sentences>","severity":"<low|med|high>","ticketIds":[<ids>],"recommendation":"<action>"}]
Only report patterns where 2+ tickets share a probable root cause.`
};

const TOKEN_LIMITS = { summarize:1000, similar:800, queue:800, patterns:2000 };

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  const body = req.body || {};

  // ── Ping — always available, used to check if AI is configured ───────────
  if (body.action === 'ping') {
    if (!process.env.ANTHROPIC_API_KEY) {
      context.res = { status: 503, body: { error: "ANTHROPIC_API_KEY not configured" } };
    } else {
      context.res = { body: { ok: true, model: "claude-sonnet-4-20250514" } };
    }
    return;
  }

  // ── Check Anthropic key is configured ────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    context.res = { status: 503, body: { error: "ANTHROPIC_API_KEY not configured in Azure SWA environment variables. Go to Azure Portal → Static Web Apps → Configuration → Add application setting: ANTHROPIC_API_KEY" } };
    return;
  }

  // ── New action-based handlers ─────────────────────────────────────────────
  if (body.action === "teams_send") {
    const { message, recipient, ticketId, ticketSubject } = body;
    try {
      const { postTeamsCard } = require("../shared/clients");
      const card = {
        type: "message",
        attachments: [{
          contentType: "application/vnd.microsoft.card.adaptive",
          content: {
            type: "AdaptiveCard",
            version: "1.4",
            body: [
              { type: "TextBlock", text: recipient ? `📨 Hand-off to ${recipient}` : "📨 IT Team Hand-off", weight: "Bolder", size: "Medium" },
              ...(ticketSubject ? [{ type: "TextBlock", text: "Ticket: " + ticketSubject, isSubtle: true, wrap: true }] : []),
              { type: "TextBlock", text: message, wrap: true }
            ],
            actions: ticketId ? [{
              type: "Action.OpenUrl",
              title: "View Ticket #" + ticketId,
              url: "https://renovationbrands.freshservice.com/a/tickets/" + ticketId
            }] : []
          }
        }]
      };
      await postTeamsCard(card);
      context.res = { body: { ok: true } };
    } catch(err) {
      context.res = { status: 500, body: { error: err.message } };
    }
    return;
  }

  if (body.action === "morning_brief") {
    const { tickets, stats, agentName } = body;
    try {
      const ticketLines = (tickets||[]).slice(0,10).map(t =>
        `• #${t.id} [${PRIO_MAP[t.priority]||"?"}] ${t.subject} — ${t.requester_name||"unknown"} — ${Math.floor((Date.now()-new Date(t.created_at))/86400000)}d old`
      ).join("\n");
      const prompt = `You are writing a concise morning briefing for ${agentName||"an IT engineer"} at Renovation Brands.

Stats: ${stats.myOpen} active tickets, ${stats.breached} SLA breached, ${stats.atRisk} at risk, ${stats.urgent} urgent, ${stats.newSince} new since last visit.

Their tickets:
${ticketLines||"(none)"}

Write 2-3 sentences MAX. Be warm but direct. Mention the most critical issue specifically if there is one (ticket subject + requester name). Do not use markdown or bullet points. Just plain conversational sentences.`;
      const brief = await callClaude(prompt, { maxTokens: 150 });
      context.res = { body: { brief } };
    } catch(err) {
      context.res = { status: 500, body: { error: err.message } };
    }
    return;
  }

  if (body.action === "kb_search") {
    const { query, articles } = body;
    try {
      const articleLines = (articles||[]).slice(0,30).map((a,i) =>
        `[${i}] ID:${a.id} — "${a.title}" — Tags: ${(a.tags||[]).join(", ")} — ${(a.description||"").slice(0,150)}`
      ).join("\n");
      const prompt = `You are an IT knowledge base assistant at Renovation Brands. Answer the user's question using the available articles. Return JSON only:
{"answer":"<2-3 sentence plain English answer>","sources":[<array of article IDs that were used>]}

User question: "${query}"

Available articles:
${articleLines}

If no articles are relevant, return {"answer":"I couldn't find a specific article for that. Try searching for related terms or contact the IT team.","sources":[]}`;
      const raw = await callClaude(prompt, { maxTokens: 400 });
      const result = parseJsonResponse(raw);
      context.res = { body: result };
    } catch(err) {
      context.res = { status: 500, body: { error: err.message } };
    }
    return;
  }

  if (body.action === "patterns") {
    const { tickets } = body;
    try {
      const prompt = PROMPTS.patterns({ tickets });
      const raw = await callClaude(prompt, { maxTokens: 2000 });
      context.res = { body: { result: parseJsonResponse(raw) } };
    } catch(err) {
      context.res = { status: 500, body: { error: err.message } };
    }
    return;
  }

  if (body.action === 'thread_sentiment') {
    const { messages, ticketId } = body;
    if (!messages?.length) { context.res = { body: { sentiment: 'neutral' } }; return; }
    try {
      const prompt = `Analyse the tone/sentiment of these requester messages in a support ticket. Return ONLY JSON.

Messages (oldest to newest):
${messages.map((m,i)=>`[${i+1}] ${m}`).join('\n')}

Classify the overall sentiment trend: frustrated, impatient, neutral, satisfied, relieved.
Also note if it's ESCALATING (getting worse) or IMPROVING.

Return: {"sentiment":"<frustrated|impatient|neutral|satisfied|relieved>","trend":"<escalating|stable|improving>","note":"<one short phrase, max 6 words>"}`;
      const raw = await callClaude(prompt, { maxTokens: 100 });
      context.res = { body: parseJsonResponse(raw) };
    } catch(err) {
      context.res = { body: { sentiment: 'neutral', note: '' } };
    }
    return;
  }

  // ── Legacy mode-based handlers ────────────────────────────────────────────
  const { mode, payload } = body;
  if (!PROMPTS[mode]) {
    context.res = { status: 400, body: { error: "Unknown mode/action: " + (mode || body.action) } };
    return;
  }
  try {
    const raw = await callClaude(PROMPTS[mode](payload), { maxTokens: TOKEN_LIMITS[mode] });
    context.res = { body: { result: parseJsonResponse(raw) } };
  } catch(err) {
    context.log.error("aiTriage failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
