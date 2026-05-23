const { fsGetAllOpenTickets, fsGetAgentMap, callClaude, parseJsonResponse, postTeamsCard } = require("../shared/clients");
const PRIO_MAP = {1:"Low",2:"Medium",3:"High",4:"Urgent"};

module.exports = async function(context, myTimer) {
  context.log("Pattern detection starting");
  let tickets; try { tickets = await fsGetAllOpenTickets(); } catch(e) { context.log.error("fetch failed",e); return; }
  const agents = await fsGetAgentMap().catch(()=>({}));
  const enriched = tickets.map(t=>({...t,responder_name:t.responder_id?agents[t.responder_id]?.name||null:null}));
  if(enriched.length<3){context.log("Not enough tickets");return;}
  const prompt = `Detect PATTERNS across these open IT tickets. Return ONLY a JSON array (empty if no patterns).\n\nTICKETS:\n${enriched.map(t=>`---\nID: ${t.id} | ${PRIO_MAP[t.priority]} | ${t.category||""} / ${t.sub_category||""}\nSubject: ${t.subject}\nDesc: ${(t.description_text||"").slice(0,200)}\nRequester: ${t.requester_name||"?"}`).join("\n")}\n\nReturn: [{"tag":"<2-3 words>","title":"<headline>","description":"<2-3 sentences>","severity":"<low|med|high>","ticketIds":[<ids>],"recommendation":"<action>"}]\nOnly report where 2+ tickets share a probable root cause.`;
  let patterns=[]; try{patterns=parseJsonResponse(await callClaude(prompt,{maxTokens:2000}));}catch(e){context.log.error("AI failed",e);return;}
  const SEV = {high:"Attention",med:"Warning",low:"Accent"};
  const blocks=[{type:"TextBlock",text:"🔍 Morning Pattern Report",weight:"Bolder",size:"Large",color:"Accent"},{type:"TextBlock",text:`${enriched.length} open tickets · ${patterns.length} cluster${patterns.length===1?"":"s"} found`,isSubtle:true,wrap:true}];
  if(!patterns.length){blocks.push({type:"TextBlock",text:"No meaningful patterns this morning. Tickets look isolated. ☕",wrap:true});}
  else{patterns.sort((a,b)=>({high:0,med:1,low:2}[a.severity]||3)-({high:0,med:1,low:2}[b.severity]||3)).forEach(p=>{blocks.push({type:"Container",separator:true,items:[{type:"TextBlock",text:`**${p.title}**`,wrap:true,size:"Medium"},{type:"TextBlock",text:p.description,wrap:true,isSubtle:true},{type:"TextBlock",text:`🛠️ **Recommendation:** ${p.recommendation}`,wrap:true},{type:"TextBlock",text:`🎫 Tickets: ${p.ticketIds.map(id=>`#${id}`).join(", ")}`,wrap:true,size:"Small",isSubtle:true}]});});}
  const card={type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{$schema:"http://adaptivecards.io/schemas/adaptive-card.json",type:"AdaptiveCard",version:"1.4",body:blocks}}]};
  try{await postTeamsCard(card);context.log("Posted to Teams");}catch(e){context.log.error("Teams failed",e);}
};
