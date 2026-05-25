const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");
const { checkUserAvailability, createUser, assignLicense, getAvailableLicenses, addUserToGroup, findGroupByName, disableUser, removeAllLicenses, setMailForwarding, getUserByEmail } = require("../shared/graph");

const LICENSE_HINTS = { "Business Premium":["SPB","O365_BUSINESS_PREMIUM"], "Business Standard":["O365_BUSINESS_STANDARD"], "F3":["DESKLESSPACK","SPE_F1"], "E3":["ENTERPRISEPACK","SPE_E3"] };

function genPassword() {
  const u="ABCDEFGHJKMNPQRSTUVWXYZ",l="abcdefghjkmnpqrstuvwxyz",d="23456789",s="!@#$%";
  const all=u+l+d+s;
  let pw=u[Math.floor(Math.random()*u.length)]+l[Math.floor(Math.random()*l.length)]+d[Math.floor(Math.random()*d.length)]+s[Math.floor(Math.random()*s.length)];
  for(let i=0;i<10;i++) pw+=all[Math.floor(Math.random()*all.length)];
  return pw.split("").sort(()=>Math.random()-0.5).join("");
}

async function runStep(stepId, params) {
  switch(stepId) {
    case "check-availability": { const r=await checkUserAvailability(params.upn); return { ok:r.available, message:r.available?`${params.upn} is available`:`${params.upn} already exists` }; }
    case "create-user": { const pw=genPassword(); const u=await createUser({...params,initialPassword:pw}); return { ok:true, message:`Created ${u.userPrincipalName}`, data:{userId:u.id,upn:u.userPrincipalName,tempPassword:pw} }; }
    case "assign-license": { if(!params.userId){const u=await getUserByEmail(params.upn);if(!u)throw new Error("User not found");params.userId=u.id;} const avail=await getAvailableLicenses(); const hints=LICENSE_HINTS[params.licenseHint]||LICENSE_HINTS["Business Premium"]; const sku=avail.find(s=>hints.includes(s.skuPartNumber)&&s.available>0); if(!sku)return{ok:false,message:`No available ${params.licenseHint} licenses`}; await assignLicense(params.userId,sku.skuId); return{ok:true,message:`Assigned ${sku.skuPartNumber}`}; }
    case "add-groups": { if(!params.userId){const u=await getUserByEmail(params.upn);if(!u)throw new Error("User not found");params.userId=u.id;} const added=[],failed=[]; for(const n of["All Staff",params.department,params.office].filter(Boolean)){try{const g=await findGroupByName(n);if(!g){failed.push(n+" (not found)");continue;}await addUserToGroup(params.userId,g.id);added.push(n);}catch(e){failed.push(n);}} return{ok:added.length>0,message:`Added to: ${added.join(", ")||"none"}${failed.length?" · Failed: "+failed.join(", "):""}`,data:{added,failed}}; }
    case "send-welcome": { return{ok:true,message:"Welcome email drafted",data:{to:params.cc,subject:`Welcome to Renovation Brands`,body:`Your account is ready.\nUsername: ${params.upn}\nTemp password: ${params.tempPassword||"(from create-user step)"}\n\nSign in at https://portal.office.com\n\n— IT Team`}}; }
    case "disable-account": { const u=await getUserByEmail(params.email);if(!u)return{ok:false,message:"User not found"}; await disableUser(u.id); return{ok:true,message:`Disabled ${u.userPrincipalName}`}; }
    case "remove-licenses": { const u=await getUserByEmail(params.email);if(!u)return{ok:false,message:"User not found"}; const r=await removeAllLicenses(u.id); return{ok:true,message:`Removed ${r.removed} license(s)`}; }
    case "forward-email": { const u=await getUserByEmail(params.email);if(!u)return{ok:false,message:"User not found"}; await setMailForwarding(u.id,params.forwardTo); return{ok:true,message:`Mailbox auto-reply set`}; }
    default: return{ok:false,message:"Unknown step: "+stepId};
  }
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }
  const { ticketId, stepId, params } = req.body || {};
  if (!ticketId || !stepId) { context.res = { status: 400, body: { error: "ticketId and stepId required" } }; return; }
  try {
    const result = await runStep(stepId, params || {});
    try { await fsAddNote(ticketId, `[🤖 Provisioning] ${stepId}\nBy: ${principal?.userDetails||"?"}\n${result.ok?"✓":"✗"} ${result.message}`, true); } catch(e) {}
    context.res = { body: { stepId, ...result } };
  } catch(err) {
    context.log.error("onboardExecute failed", err);
    try { await fsAddNote(ticketId, `[🤖 Provisioning] ${stepId} FAILED\n${err.message}`, true); } catch(e) {}
    context.res = { status: 500, body: { stepId, ok: false, error: err.message } };
  }
};
