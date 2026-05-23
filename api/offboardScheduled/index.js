const { fsGetAllOpenTickets, fsAddNote, callClaude, parseJsonResponse } = require("../shared/clients");
const { getUserByEmail, disableUser, removeAllLicenses, setMailForwarding } = require("../shared/graph");

function isToday(iso){if(!iso)return false;const d=new Date(iso),n=new Date();return d.getUTCFullYear()===n.getUTCFullYear()&&d.getUTCMonth()===n.getUTCMonth()&&d.getUTCDate()===n.getUTCDate();}
function looksLikeOffboarding(t){const h=((t.subject||"")+" "+(t.description_text||"")).toLowerCase();return /\b(offboard|off-board|termination|last day|leaving|departure)\b/.test(h);}

module.exports = async function(context, myTimer) {
  context.log("Offboard scheduler starting");
  let tickets; try{tickets=await fsGetAllOpenTickets();}catch(e){context.log.error("fetch failed",e);return;}
  const candidates = tickets.filter(looksLikeOffboarding);
  context.log(`${candidates.length} offboarding candidates`);
  for(const ticket of candidates){
    try{
      const prompt=`Parse this offboarding ticket. Return ONLY JSON.\n\n${ticket.subject}\n${ticket.description_text||""}\n\nReturn: {"employeeEmail":"<or null>","lastDay":"<ISO date or null>","managerEmail":"<or null>","forwardingDays":<number>}`;
      let parsed; try{parsed=parseJsonResponse(await callClaude(prompt,{maxTokens:300}));}catch(e){continue;}
      if(!parsed?.lastDay||!isToday(parsed.lastDay))continue;
      if(!parsed.employeeEmail){await fsAddNote(ticket.id,"[🤖 Offboard Scheduler] Last day is today but no employee email found. Please disable manually.",true).catch(()=>{});continue;}
      const notes=["[🤖 Offboard Scheduler] Last day is today — executing:"];
      const user=await getUserByEmail(parsed.employeeEmail).catch(()=>null);
      if(!user){notes.push(`✗ User not found: ${parsed.employeeEmail}`);}
      else{
        await disableUser(user.id).then(()=>notes.push(`✓ Disabled ${user.userPrincipalName}`)).catch(e=>notes.push(`✗ Disable failed: ${e.message}`));
        await removeAllLicenses(user.id).then(r=>notes.push(`✓ Removed ${r.removed} license(s)`)).catch(e=>notes.push(`✗ License removal failed: ${e.message}`));
        if(parsed.managerEmail)await setMailForwarding(user.id,parsed.managerEmail).then(()=>notes.push(`✓ Mailbox auto-reply set`)).catch(e=>notes.push(`✗ Forwarding failed: ${e.message}`));
      }
      await fsAddNote(ticket.id,notes.join("\n"),true).catch(()=>{});
    }catch(e){context.log.error(`Ticket #${ticket.id} failed:`,e);}
  }
};
