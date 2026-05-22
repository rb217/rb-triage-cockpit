// api/offboardScheduled/index.js
// Runs daily at 23:00 UTC (6pm ET during DST, 7pm ET standard time).
// Scans open offboarding tickets for any with a "last day" of today,
// and executes the disable-account + remove-licenses + forward-email steps.
//
// This solves the problem that Graph has no native scheduled actions —
// we poll daily instead.

const { app } = require("@azure/functions");
const {
  fsGetAllOpenTickets, fsAddNote,
  callClaude, parseJsonResponse
} = require("../shared/clients");
const {
  getUserByEmail, disableUser, removeAllLicenses, setMailForwarding
} = require("../shared/graph");

function isToday(isoDate){
  if(!isoDate) return false;
  const d = new Date(isoDate);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() &&
         d.getUTCMonth() === now.getUTCMonth() &&
         d.getUTCDate() === now.getUTCDate();
}

function looksLikeOffboarding(ticket){
  if(ticket.category === "Employee Onboarding/Offboarding" && ticket.sub_category === "Offboarding") return true;
  const hay = ((ticket.subject||"") + " " + (ticket.description_text||"")).toLowerCase();
  return /\b(offboard|off-board|termination|last day|leaving|departure)\b/.test(hay);
}

async function parseOffboardingTicket(ticket){
  const prompt = `Parse this offboarding ticket and return ONLY JSON. Extract just the fields needed to execute today's disable.

TICKET:
${ticket.subject}
${ticket.description_text || ""}

Return:
{"employeeEmail": "<email or null>", "lastDay": "<ISO date or null>", "managerEmail": "<manager email for forwarding or null>", "forwardingDays": <number, default 30>}`;
  try {
    const raw = await callClaude(prompt, { maxTokens: 400 });
    return parseJsonResponse(raw);
  } catch(e){
    return null;
  }
}

app.timer("offboardScheduled", {
  schedule: "0 0 23 * * *", // daily at 23:00 UTC
  handler: async (timer, context) => {
    context.log("Offboard scheduler starting");
    let tickets;
    try {
      tickets = await fsGetAllOpenTickets();
    } catch(err) {
      context.log.error("Could not fetch tickets", err);
      return;
    }

    const offboardCandidates = tickets.filter(looksLikeOffboarding);
    context.log(`Found ${offboardCandidates.length} possible offboarding tickets`);

    let processed = 0;
    for(const ticket of offboardCandidates){
      try {
        const parsed = await parseOffboardingTicket(ticket);
        if(!parsed || !parsed.lastDay || !isToday(parsed.lastDay)){
          continue; // not today
        }
        if(!parsed.employeeEmail){
          context.log(`Ticket #${ticket.id}: last day is today but no employee email — skipping`);
          await fsAddNote(ticket.id, "[🤖 Offboard Scheduler] Last day is today but I couldn't find the employee email. Please disable manually.", true).catch(()=>{});
          continue;
        }

        context.log(`Ticket #${ticket.id}: executing scheduled disable for ${parsed.employeeEmail}`);

        const auditLines = ["[🤖 Offboard Scheduler] Last day is today — executing automated offboard:"];

        // 1. Disable account
        let user;
        try {
          user = await getUserByEmail(parsed.employeeEmail);
          if(!user){
            auditLines.push(`✗ User not found in Entra: ${parsed.employeeEmail}`);
          } else {
            await disableUser(user.id);
            auditLines.push(`✓ Disabled account ${user.userPrincipalName}`);
          }
        } catch(e){
          auditLines.push(`✗ Disable failed: ${e.message}`);
        }

        // 2. Remove licenses
        if(user){
          try {
            const result = await removeAllLicenses(user.id);
            auditLines.push(`✓ Removed ${result.removed} license(s)`);
          } catch(e){
            auditLines.push(`✗ License removal failed: ${e.message}`);
          }
        }

        // 3. Set mailbox forwarding
        if(user && parsed.managerEmail){
          try {
            await setMailForwarding(user.id, parsed.managerEmail);
            auditLines.push(`✓ Set mailbox auto-reply with forwarding info to ${parsed.managerEmail}`);
          } catch(e){
            auditLines.push(`✗ Forwarding setup failed: ${e.message}`);
          }
        } else if(user){
          auditLines.push(`⚠ No manager email — skipping forwarding setup`);
        }

        await fsAddNote(ticket.id, auditLines.join("\n"), true).catch(()=>{});
        processed++;
      } catch(err){
        context.log.error(`Ticket #${ticket.id} failed:`, err);
      }
    }
    context.log(`Offboard scheduler done. Processed ${processed} tickets.`);
  }
});
