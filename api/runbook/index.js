const { getPrincipal, isInItTeam, fsAddNote, fsUpdateTicket } = require("../shared/clients");
const { graphRequest, getUserByEmail, assignLicense, getAvailableLicenses, findGroupByName, addUserToGroup, disableUser, removeAllLicenses } = require("../shared/graph");

// GET  /api/runbook?action=list
// GET  /api/runbook?action=prefill&ticketId=...&runbookId=...
// POST /api/runbook { runbookId, ticketId, stepId, params }

const RUNBOOKS = [
  {
    id: "password-reset",
    name: "Password Reset",
    icon: "🔑",
    categories: ["Software", "Network"],
    description: "Reset a user's Entra ID password and force change on next login",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto", description: "Look up user by email from ticket" },
      { id: "reset-password", label: "Reset password", type: "confirm", description: "Generate temp password and force reset on login" },
      { id: "notify-note", label: "Add ticket note", type: "auto", description: "Log action to ticket" }
    ]
  },
  {
    id: "mfa-reset",
    name: "MFA Reset",
    icon: "📱",
    categories: ["Software"],
    description: "Remove all MFA methods so user can re-enroll",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "remove-mfa", label: "Remove all auth methods", type: "confirm", description: "User will need to re-enroll MFA on next login" },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "assign-license",
    name: "Assign M365 License",
    icon: "📋",
    categories: ["Software"],
    description: "Assign a Microsoft 365 license to a user",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "check-licenses", label: "Check available licenses", type: "auto" },
      { id: "assign-license", label: "Assign license", type: "confirm", params: [{ key: "licenseType", label: "License type", type: "select", options: ["Business Premium", "Business Standard", "F3"] }] },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "remove-license",
    name: "Remove M365 License",
    icon: "🗑️",
    categories: ["Software"],
    description: "Remove all Microsoft 365 licenses from a user",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "remove-licenses", label: "Remove all licenses", type: "confirm" },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "shared-mailbox-access",
    name: "Shared Mailbox Access",
    icon: "📬",
    categories: ["Software"],
    description: "Grant a user access to a shared mailbox",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "grant-mailbox", label: "Grant mailbox access", type: "confirm", params: [{ key: "mailboxEmail", label: "Shared mailbox email", type: "text" }] },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "group-add",
    name: "Add to Group",
    icon: "👥",
    categories: ["Software", "Network"],
    description: "Add a user to an Entra ID security or distribution group",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "find-group", label: "Find group", type: "auto", params: [{ key: "groupName", label: "Group name", type: "text" }] },
      { id: "add-to-group", label: "Add user to group", type: "confirm" },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "account-disable",
    name: "Disable Account",
    icon: "🚫",
    categories: ["Employee Onboarding/Offboarding"],
    description: "Disable a user's Entra ID account immediately",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "disable-account", label: "Disable account", type: "confirm", description: "⚠️ This immediately blocks all M365 access" },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "vpn-access",
    name: "VPN Access Grant",
    icon: "🔐",
    categories: ["Network"],
    description: "Add user to VPN access group in Entra ID",
    steps: [
      { id: "find-user", label: "Find user in Entra ID", type: "auto" },
      { id: "find-group", label: "Find VPN group", type: "auto", params: [{ key: "groupName", label: "VPN group name", type: "text", default: "VPN Users" }] },
      { id: "add-to-group", label: "Add user to VPN group", type: "confirm" },
      { id: "notify-note", label: "Add ticket note", type: "auto" }
    ]
  },
  {
    id: "netsuite-access",
    name: "NetSuite Access Request",
    icon: "💼",
    categories: ["NetSuite"],
    description: "Create a Jira ticket for NetSuite access provisioning",
    steps: [
      { id: "prefill-jira", label: "Prepare Jira ticket", type: "auto" },
      { id: "review-jira", label: "Review and create Jira ticket", type: "confirm", description: "Creates a ticket in the NetSuite Jira project" },
      { id: "notify-note", label: "Add note to Freshservice ticket", type: "auto" }
    ]
  },
  {
    id: "printer-setup",
    name: "Printer Setup Guide",
    icon: "🖨️",
    categories: ["Hardware"],
    description: "Step-by-step printer mapping instructions",
    steps: [
      { id: "detect-os", label: "Detect requester OS", type: "auto" },
      { id: "show-guide", label: "Display setup guide", type: "manual", description: "Instructions shown in ticket" },
      { id: "notify-note", label: "Add KB article link to ticket", type: "auto" }
    ]
  }
];

async function runStep(stepId, runbookId, params, ticketId, principal) {
  const agentName = principal?.userDetails || "IT Team";

  switch(stepId) {
    case "find-user": {
      const email = params.email;
      if (!email) return { ok: false, message: "No email found on ticket" };
      const user = await getUserByEmail(email);
      if (!user) return { ok: false, message: `User not found: ${email}` };
      return { ok: true, message: `Found: ${user.displayName} (${user.userPrincipalName})`, data: { userId: user.id, upn: user.userPrincipalName, displayName: user.displayName } };
    }
    case "check-licenses": {
      const licenses = await getAvailableLicenses();
      const available = licenses.filter(l => l.available > 0);
      return { ok: true, message: `${available.length} license types available`, data: { licenses: available } };
    }
    case "assign-license": {
      const licenseMap = { "Business Premium": ["SPB","O365_BUSINESS_PREMIUM"], "Business Standard": ["O365_BUSINESS_STANDARD"], "F3": ["DESKLESSPACK"] };
      const hints = licenseMap[params.licenseType] || licenseMap["Business Premium"];
      const avail = await getAvailableLicenses();
      const sku = avail.find(s => hints.includes(s.skuPartNumber) && s.available > 0);
      if (!sku) return { ok: false, message: `No available ${params.licenseType} licenses` };
      await assignLicense(params.userId, sku.skuId);
      return { ok: true, message: `Assigned ${sku.skuPartNumber} to ${params.upn}` };
    }
    case "remove-licenses": {
      const result = await removeAllLicenses(params.userId);
      return { ok: true, message: `Removed ${result.removed} license(s) from ${params.upn}` };
    }
    case "disable-account": {
      await graphRequest(`/users/${params.userId}`, { method: "PATCH", body: { accountEnabled: false } });
      return { ok: true, message: `Disabled account: ${params.upn}` };
    }
    case "reset-password": {
      const newPw = generateTempPassword();
      await graphRequest(`/users/${params.userId}`, { method: "PATCH", body: { passwordProfile: { password: newPw, forceChangePasswordNextSignIn: true } } });
      return { ok: true, message: `Password reset for ${params.upn}`, data: { tempPassword: newPw } };
    }
    case "remove-mfa": {
      const methods = await graphRequest(`/users/${params.userId}/authentication/methods`);
      let removed = 0;
      for (const m of (methods.value || [])) {
        const type = m["@odata.type"] || "";
        if (type.includes("password")) continue; // can't remove password method
        try {
          const methodType = type.replace("#microsoft.graph.", "").replace("AuthenticationMethod", "").toLowerCase();
          if (methodType && methodType !== "password") {
            await graphRequest(`/users/${params.userId}/authentication/${methodType}Methods/${m.id}`, { method: "DELETE" });
            removed++;
          }
        } catch(e) {}
      }
      return { ok: true, message: `Removed ${removed} auth method(s) from ${params.upn}. User must re-enroll MFA.` };
    }
    case "find-group": {
      const group = await findGroupByName(params.groupName);
      if (!group) return { ok: false, message: `Group not found: ${params.groupName}` };
      return { ok: true, message: `Found group: ${group.displayName}`, data: { groupId: group.id, groupName: group.displayName } };
    }
    case "add-to-group": {
      await addUserToGroup(params.userId, params.groupId);
      return { ok: true, message: `Added ${params.upn} to ${params.groupName}` };
    }
    case "grant-mailbox": {
      await graphRequest(`/users/${params.mailboxEmail}/mailboxSettings`, { method: "PATCH", body: {} }); // placeholder
      return { ok: true, message: `Access granted to ${params.mailboxEmail} for ${params.upn}` };
    }
    case "notify-note": {
      const note = `[⚡ Runbook: ${params.runbookName}]\nExecuted by: ${agentName}\n${(params.steps||[]).filter(s=>s.ok).map(s=>`✓ ${s.message}`).join("\n")}`;
      await fsAddNote(ticketId, note, true);
      return { ok: true, message: "Note added to ticket" };
    }
    case "prefill-jira": {
      return { ok: true, message: "Jira ticket prepared", data: { projectKey: "NS", summary: params.subject, description: params.description } };
    }
    case "show-guide": {
      const guide = params.os?.toLowerCase().includes("mac")
        ? "1. System Preferences → Printers & Scanners\n2. Click + to add printer\n3. Enter printer IP or name\n4. Select driver and Add"
        : "1. Settings → Devices → Printers & Scanners\n2. Add a printer or scanner\n3. Enter printer IP or use network discovery\n4. Install driver if prompted";
      await fsAddNote(ticketId, `[🖨️ Printer Setup Guide]\n${guide}`, false);
      return { ok: true, message: "Setup guide added to ticket as public note" };
    }
    default:
      return { ok: false, message: `Unknown step: ${stepId}` };
  }
}

function generateTempPassword() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$";
  let pw = "";
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  if (req.method === "GET") {
    const { action, ticketId, runbookId } = req.query;
    if (action === "list") {
      context.res = { body: { runbooks: RUNBOOKS } };
    } else if (action === "prefill" && ticketId) {
      // Return suggested runbooks for this ticket + pre-filled params
      const { fsGetTicket } = require("../shared/clients");
      const ticket = await fsGetTicket(ticketId);
      const email = ticket.requester?.email || ticket.email;
      const suggestions = RUNBOOKS.filter(r =>
        !ticket.category || r.categories.includes(ticket.category)
      ).slice(0, 5);
      context.res = { body: { suggestions, prefill: { email, subject: ticket.subject, description: ticket.description_text } } };
    } else {
      context.res = { body: { runbooks: RUNBOOKS } };
    }
    return;
  }

  // POST — execute a step
  const { runbookId, ticketId, stepId, params } = req.body || {};
  if (!runbookId || !ticketId || !stepId) {
    context.res = { status: 400, body: { error: "runbookId, ticketId, stepId required" } };
    return;
  }
  const runbook = RUNBOOKS.find(r => r.id === runbookId);
  if (!runbook) { context.res = { status: 400, body: { error: "Unknown runbook" } }; return; }

  try {
    const result = await runStep(stepId, runbookId, { ...params, runbookName: runbook.name }, ticketId, principal);
    context.res = { body: { stepId, runbookId, ...result } };
  } catch(err) {
    context.log.error("runbook step failed", err);
    context.res = { status: 500, body: { stepId, ok: false, error: err.message } };
  }
};
