const { getSecret, fsGetTicket, fsUpdateTicket, fsAddNote, fsFindAgentByName, callClaude, parseJsonResponse } = require("../shared/clients");
const { getFullUserContext } = require("../shared/graph");
const THRESHOLD = 70;
const PRIO_MAP = {1:"Low",2:"Medium",3:"High",4:"Urgent"};
const PRIO_NUM = {Low:1,Medium:2,High:3,Urgent:4};

module.exports = async function(context, req) {
  const provided = req.headers["x-fs-webhook-secret"] || req.query.token;
  let expected; try { expected = await getSecret("FRESHSERVICE-WEBHOOK-SECRET"); } catch(e) { context.res={status:500,body:{error:"Not configured"}};return; }
  if (!provided || provided !== expected) { context.res={status:401,body:{error:"Unauthorized"}};return; }
  const ticketId = req.body?.ticket_id || req.body?.id;
  if (!ticketId) { context.res={status:400,body:{error:"No ticket_id"}};return; }
  let ticket; try { ticket=await fsGetTicket(ticketId); } catch(e) { context.res={status:200,body:{skipped:true}};return; }
  if (ticket.category && ticket.category!=="Other" && ticket.category!=="") { context.res={status:200,body:{skipped:true,reason:"already categorized"}};return; }
  let m365=null;
  try { if(ticket.requester?.email) m365=await getFullUserContext(ticket.requester.email); } catch(e) {}
  const desc = (ticket.description_text||ticket.description||"").replace(/<[^>]+>/g," ").slice(0,500);
  const prompt = `Classify this new Freshservice IT ticket. Return ONLY JSON.\n\nSubject: ${ticket.subject}\nDescription: ${desc}\nRequester: ${ticket.requester?.name||"?"}\n${m365?.found?`M365: account ${m365.accountEnabled?"enabled":"DISABLED"}, MFA ${m365.mfa?.enrolled?"yes":"no"}`:"M365: not found"}\n\nCategories: Hardware (Computer,Printer,Phone,Peripherals), Software (Microsoft 365,Adobe Creative Cloud,Windows,AI Tools,RingCentral,Other), Network (Connectivity,VPN,Access,Wireless), NetSuite (Access and Permissions,Data Update,Reporting,Configuration,Integrations), Employee Onboarding/Offboarding (Onboarding,Offboarding,Asset Reclaim), Other.\n\nIT team: Nathan Maharg (general IT+M365+NetSuite), Steve Mitchell (network+VPN), Eric Hnatov (hardware+assets).\n\nReturn: {"category":"<>","category_confidence":<0-100>,"sub_category":"<>","sub_category_confidence":<0-100>,"priority":"<Low|Medium|High|Urgent>","priority_confidence":<0-100>,"assignee":"<name or any IT>","assignee_confidence":<0-100>,"reasoning":"<1 sentence>"}`;
  let triage; try { triage=parseJsonResponse(await callClaude(prompt,{maxTokens:800})); } catch(e) { context.res={status:200,body:{skipped:true,error:e.message}};return; }
  const updates={}, applied=[], skipped=[];
  if(triage.category_confidence>=THRESHOLD){updates.category=triage.category;applied.push(`Category: ${triage.category} (${triage.category_confidence}%)`);}else{skipped.push(`Category: ${triage.category} (${triage.category_confidence}%)`);}
  if(triage.sub_category_confidence>=THRESHOLD&&triage.sub_category){updates.sub_category=triage.sub_category;applied.push(`Sub-cat: ${triage.sub_category} (${triage.sub_category_confidence}%)`);}
  if(triage.priority_confidence>=THRESHOLD&&triage.priority){const p=PRIO_NUM[triage.priority];if(p&&p!==ticket.priority){updates.priority=p;applied.push(`Priority: ${triage.priority} (${triage.priority_confidence}%)`);}}
  if(triage.assignee_confidence>=THRESHOLD&&triage.assignee&&triage.assignee!=="any IT"){const id=await fsFindAgentByName(triage.assignee);if(id){updates.responder_id=id;applied.push(`Assigned: ${triage.assignee} (${triage.assignee_confidence}%)`);}}
  if(Object.keys(updates).length) try{await fsUpdateTicket(ticketId,updates);}catch(e){}
  const note=`[🤖 AI Triage]\n${triage.reasoning}\n\n${applied.length?"Applied:\n"+applied.map(a=>"✓ "+a).join("\n"):""}\n${skipped.length?"\nBelow threshold:\n"+skipped.map(s=>"• "+s).join("\n"):""}`;
  try{await fsAddNote(ticketId,note,true);}catch(e){}
  context.res={status:200,body:{ticketId,applied,skipped}};
};
