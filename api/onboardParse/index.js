// api/onboardParse/index.js
// POST /api/onboardParse
// Body: { ticketId }
// Uses AI to extract structured fields from an HR onboarding/offboarding ticket,
// returns a provisioning checklist with proposed actions.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  fsGetTicket,
  callClaude, parseJsonResponse
} = require("../shared/clients");

const ONBOARD_PROMPT = (ticket) => `You are an IT onboarding assistant for Renovation Brands. Parse this HR onboarding ticket and extract structured fields. Return ONLY valid JSON.

TICKET:
Subject: ${ticket.subject}
Description: ${ticket.description_text || ticket.description || ""}

Extract:
{
  "type": "onboarding",
  "firstName": "<first name>",
  "lastName": "<last name>",
  "displayName": "<full name as shown in directory>",
  "jobTitle": "<role>",
  "department": "<department, infer if not stated>",
  "managerName": "<manager's full name or null>",
  "managerEmail": "<manager's email if mentioned, else null>",
  "startDate": "<ISO date YYYY-MM-DD or null>",
  "office": "<location/office or null>",
  "suggestedUpn": "<first.last@renovationbrands.com>",
  "licenseHint": "<Business Premium|Business Standard|F3|E3|null - based on role>",
  "specialAccess": ["<list any special access requests like NetSuite, shared mailboxes, distribution groups>"],
  "hardwareNeeds": ["<list any hardware mentioned: laptop, monitor, headset, etc>"],
  "completeness": "<complete|partial|insufficient - based on whether you have enough to proceed>",
  "missingFields": ["<list of fields not in the ticket that should be confirmed with HR>"],
  "confidence": "<low|medium|high>"
}

If any field is genuinely not present in the ticket, use null (don't guess names/emails). Job title can be inferred from context (e.g., "AP Clerk", "Accounts Payable specialist" → "AP Clerk"). Default office to "Main" if not specified.`;

const OFFBOARD_PROMPT = (ticket) => `You are an IT offboarding assistant for Renovation Brands. Parse this HR offboarding ticket and extract structured fields. Return ONLY valid JSON.

TICKET:
Subject: ${ticket.subject}
Description: ${ticket.description_text || ticket.description || ""}

Extract:
{
  "type": "offboarding",
  "employeeName": "<full name>",
  "employeeEmail": "<email or null>",
  "lastDay": "<ISO date YYYY-MM-DD>",
  "lastDayTiming": "<EOD|specific time>",
  "managerName": "<manager handling forwarded mail or null>",
  "managerEmail": "<manager email or null>",
  "forwardingDays": "<number of days to forward email, default 30>",
  "reason": "<termination|resignation|retirement|transfer|null - if mentioned>",
  "specialInstructions": ["<any special asks: preserve data, transfer files to X, etc>"],
  "assetsToReclaim": ["<laptop, phone, badge, etc>"],
  "completeness": "<complete|partial|insufficient>",
  "missingFields": ["<list of fields not in the ticket>"],
  "confidence": "<low|medium|high>"
}`;

function looksLikeOnboarding(ticket) {
  const subj = (ticket.subject || "").toLowerCase();
  const desc = (ticket.description_text || "").toLowerCase();
  const hay = subj + " " + desc;
  return /\b(onboard|new hire|new employee|starts|starting|first day|set ?up.*account|provision)\b/.test(hay);
}

function looksLikeOffboarding(ticket) {
  const subj = (ticket.subject || "").toLowerCase();
  const desc = (ticket.description_text || "").toLowerCase();
  const hay = subj + " " + desc;
  return /\b(offboard|off-board|termination|terminat|last day|leaving|departure|exit|disable.*account|deprovision)\b/.test(hay);
}

app.http("onboardParse", {
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
      return { status: 404, jsonBody: { error: "Ticket not found: " + err.message } };
    }

    const isOff = looksLikeOffboarding(ticket);
    const isOn = !isOff && looksLikeOnboarding(ticket);

    if (!isOn && !isOff) {
      return { jsonBody: { type: "neither", message: "Ticket does not appear to be onboarding or offboarding" } };
    }

    const prompt = isOff ? OFFBOARD_PROMPT(ticket) : ONBOARD_PROMPT(ticket);

    try {
      const raw = await callClaude(prompt, { maxTokens: 1500 });
      const parsed = parseJsonResponse(raw);

      // Build a checklist from the parsed data
      const checklist = isOff
        ? buildOffboardChecklist(parsed)
        : buildOnboardChecklist(parsed);

      return { jsonBody: { parsed, checklist, ticketId } };
    } catch (err) {
      context.log.error("onboardParse failed", err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});

function buildOnboardChecklist(parsed) {
  return [
    {
      id: "check-availability",
      label: "Check UPN availability",
      mode: "auto",
      params: { upn: parsed.suggestedUpn },
      status: "pending"
    },
    {
      id: "create-user",
      label: "Create M365 user account",
      mode: "auto",
      params: {
        firstName: parsed.firstName,
        lastName: parsed.lastName,
        upn: parsed.suggestedUpn,
        displayName: parsed.displayName,
        jobTitle: parsed.jobTitle,
        department: parsed.department,
        managerEmail: parsed.managerEmail
      },
      status: "pending",
      requires: ["check-availability"]
    },
    {
      id: "assign-license",
      label: `Assign license (${parsed.licenseHint || "Business Premium"})`,
      mode: "auto",
      params: { licenseHint: parsed.licenseHint || "Business Premium" },
      status: "pending",
      requires: ["create-user"]
    },
    {
      id: "add-groups",
      label: "Add to default groups (All Staff, location, department)",
      mode: "auto",
      params: {
        department: parsed.department,
        office: parsed.office || "Main"
      },
      status: "pending",
      requires: ["create-user"]
    },
    {
      id: "send-welcome",
      label: "Send welcome email with credentials",
      mode: "manual-approve",
      params: {
        to: parsed.managerEmail,
        cc: parsed.suggestedUpn
      },
      status: "pending",
      requires: ["assign-license", "add-groups"]
    },
    ...(parsed.specialAccess && parsed.specialAccess.length ? [{
      id: "special-access",
      label: `Special access requests: ${parsed.specialAccess.join(", ")}`,
      mode: "manual",
      params: { items: parsed.specialAccess },
      status: "pending"
    }] : []),
    ...(parsed.hardwareNeeds && parsed.hardwareNeeds.length ? [{
      id: "hardware",
      label: `Hardware order: ${parsed.hardwareNeeds.join(", ")}`,
      mode: "manual",
      params: { items: parsed.hardwareNeeds },
      status: "pending"
    }] : []),
    {
      id: "building-access",
      label: "Building access card",
      mode: "manual",
      params: {},
      status: "pending"
    }
  ];
}

function buildOffboardChecklist(parsed) {
  return [
    {
      id: "disable-account",
      label: `Disable account ${parsed.lastDay ? `on ${parsed.lastDay}` : "on last day"}`,
      mode: parsed.lastDay ? "scheduled" : "manual-approve",
      params: {
        email: parsed.employeeEmail,
        when: parsed.lastDay
      },
      status: "pending"
    },
    {
      id: "remove-licenses",
      label: "Revoke all licenses",
      mode: "auto",
      params: { email: parsed.employeeEmail },
      status: "pending",
      requires: ["disable-account"]
    },
    {
      id: "remove-groups",
      label: "Remove from all groups",
      mode: "auto",
      params: { email: parsed.employeeEmail },
      status: "pending",
      requires: ["disable-account"]
    },
    {
      id: "forward-email",
      label: `Forward email to ${parsed.managerName || "manager"} for ${parsed.forwardingDays || 30} days`,
      mode: "auto",
      params: {
        email: parsed.employeeEmail,
        forwardTo: parsed.managerEmail,
        days: parsed.forwardingDays || 30
      },
      status: "pending",
      requires: ["disable-account"]
    },
    ...(parsed.assetsToReclaim && parsed.assetsToReclaim.length ? [{
      id: "reclaim-assets",
      label: `Reclaim assets: ${parsed.assetsToReclaim.join(", ")}`,
      mode: "manual",
      params: { items: parsed.assetsToReclaim },
      status: "pending"
    }] : []),
    {
      id: "revoke-netsuite",
      label: "Revoke NetSuite access",
      mode: "manual",
      params: {},
      status: "pending"
    }
  ];
}
