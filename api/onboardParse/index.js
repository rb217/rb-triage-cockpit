const { getPrincipal, isInItTeam, fsGetTicket, callClaude, parseJsonResponse } = require("../shared/clients");

function looksLikeOffboarding(t) {
  const hay = ((t.subject||"")+" "+(t.description_text||"")).toLowerCase();
  return /\b(offboard|off-board|termination|terminat|last day|leaving|departure|exit|disable.*account|deprovision)\b/.test(hay);
}
function looksLikeOnboarding(t) {
  const hay = ((t.subject||"")+" "+(t.description_text||"")).toLowerCase();
  return /\b(onboard|new hire|new employee|starts|starting|first day|set ?up.*account|provision)\b/.test(hay);
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const { ticketId } = req.body || {};
  if (!ticketId) { context.res = { status: 400, body: { error: "ticketId required" } }; return; }
  let ticket;
  try { ticket = await fsGetTicket(ticketId); } catch(err) { context.res = { status: 404, body: { error: "Ticket not found" } }; return; }
  const isOff = looksLikeOffboarding(ticket);
  const isOn = !isOff && looksLikeOnboarding(ticket);
  if (!isOn && !isOff) { context.res = { body: { type: "neither" } }; return; }
  const prompt = isOff
    ? `Parse this offboarding ticket. Return ONLY JSON.\n\nTICKET:\n${ticket.subject}\n${ticket.description_text||""}\n\nReturn: {"type":"offboarding","employeeName":"<>","employeeEmail":"<or null>","lastDay":"<ISO date or null>","managerName":"<or null>","managerEmail":"<or null>","forwardingDays":<number>,"assetsToReclaim":["<>"],"completeness":"<complete|partial>","missingFields":["<>"],"confidence":"<low|medium|high>"}`
    : `Parse this onboarding ticket. Return ONLY JSON.\n\nTICKET:\n${ticket.subject}\n${ticket.description_text||""}\n\nReturn: {"type":"onboarding","firstName":"<>","lastName":"<>","displayName":"<>","jobTitle":"<>","department":"<>","managerName":"<or null>","managerEmail":"<or null>","startDate":"<ISO or null>","suggestedUpn":"<first.last@renovationbrands.com>","licenseHint":"<Business Premium|Business Standard|F3|null>","specialAccess":["<>"],"hardwareNeeds":["<>"],"completeness":"<complete|partial>","missingFields":["<>"],"confidence":"<low|medium|high>"}`;
  try {
    const parsed = parseJsonResponse(await callClaude(prompt, { maxTokens: 1500 }));
    context.res = { body: { parsed, ticketId } };
  } catch(err) {
    context.res = { status: 500, body: { error: err.message } };
  }
};
