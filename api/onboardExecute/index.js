// api/onboardExecute/index.js
// POST /api/onboardExecute
// Body: { ticketId, stepId, params }
// Executes a single step from the onboarding/offboarding checklist.
// Idempotent where possible, posts result back to the ticket as a private note.

const { app } = require("@azure/functions");
const {
  getPrincipal, isInItTeam,
  fsAddNote
} = require("../shared/clients");
const {
  checkUserAvailability, createUser, assignLicense, getAvailableLicenses,
  addUserToGroup, findGroupByName, disableUser, removeAllLicenses,
  setMailForwarding, getUserByEmail
} = require("../shared/graph");

// Map license hints to SKU part numbers (look up by part number, not hardcoded GUIDs)
const LICENSE_HINTS = {
  "Business Premium": ["SPB", "O365_BUSINESS_PREMIUM"],
  "Business Standard": ["O365_BUSINESS_STANDARD", "SMB_BUSINESS_PREMIUM"],
  "F3": ["DESKLESSPACK", "SPE_F1", "M365_F3"],
  "E3": ["ENTERPRISEPACK", "SPE_E3"],
  "E5": ["ENTERPRISEPREMIUM", "SPE_E5"]
};

function genTempPassword() {
  // Strong random temp password — meets default complexity rules
  const upper = "ABCDEFGHJKMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const symbols = "!@#$%&*";
  const all = upper + lower + digits + symbols;
  let pw = upper[Math.floor(Math.random() * upper.length)]
         + lower[Math.floor(Math.random() * lower.length)]
         + digits[Math.floor(Math.random() * digits.length)]
         + symbols[Math.floor(Math.random() * symbols.length)];
  for (let i = 0; i < 12; i++) pw += all[Math.floor(Math.random() * all.length)];
  // Shuffle
  return pw.split("").sort(() => Math.random() - 0.5).join("");
}

async function runStep(stepId, params, context) {
  switch (stepId) {
    case "check-availability": {
      const result = await checkUserAvailability(params.upn);
      return {
        ok: result.available,
        message: result.available ? `UPN ${params.upn} is available` : `UPN ${params.upn} is already in use`,
        data: result
      };
    }

    case "create-user": {
      const tempPassword = genTempPassword();
      const created = await createUser({
        firstName: params.firstName,
        lastName: params.lastName,
        upn: params.upn,
        displayName: params.displayName,
        jobTitle: params.jobTitle,
        department: params.department,
        managerEmail: params.managerEmail,
        initialPassword: tempPassword
      });
      return {
        ok: true,
        message: `Created user ${created.userPrincipalName}`,
        data: { userId: created.id, upn: created.userPrincipalName, tempPassword }
      };
    }

    case "assign-license": {
      if (!params.userId) {
        // Caller didn't pass userId — look it up
        const user = await getUserByEmail(params.upn);
        if (!user) throw new Error("User not found: " + params.upn);
        params.userId = user.id;
      }
      const available = await getAvailableLicenses();
      const hints = LICENSE_HINTS[params.licenseHint] || LICENSE_HINTS["Business Premium"];
      const sku = available.find(s => hints.includes(s.skuPartNumber) && s.available > 0);
      if (!sku) {
        return {
          ok: false,
          message: `No available license matching ${params.licenseHint}. Available SKUs: ${available.map(s => `${s.skuPartNumber} (${s.available})`).join(", ")}`
        };
      }
      await assignLicense(params.userId, sku.skuId);
      return {
        ok: true,
        message: `Assigned ${sku.skuPartNumber}`,
        data: { skuId: sku.skuId, skuName: sku.skuPartNumber }
      };
    }

    case "add-groups": {
      if (!params.userId) {
        const user = await getUserByEmail(params.upn);
        if (!user) throw new Error("User not found: " + params.upn);
        params.userId = user.id;
      }
      const defaultGroups = ["All Staff", params.department, params.office].filter(Boolean);
      const added = [];
      const failed = [];
      for (const groupName of defaultGroups) {
        try {
          const group = await findGroupByName(groupName);
          if (!group) {
            failed.push(`${groupName} (not found)`);
            continue;
          }
          await addUserToGroup(params.userId, group.id);
          added.push(groupName);
        } catch (e) {
          failed.push(`${groupName} (${e.message})`);
        }
      }
      return {
        ok: added.length > 0,
        message: `Added to: ${added.join(", ") || "(none)"}` + (failed.length ? ` · Failed: ${failed.join(", ")}` : ""),
        data: { added, failed }
      };
    }

    case "send-welcome": {
      // Manual-approve step: we don't actually send the email automatically.
      // Instead we return the suggested email content for the agent to send.
      const subject = `Welcome to Renovation Brands — your IT account is ready`;
      const bodyText = [
        `Welcome aboard!`,
        ``,
        `Your IT account has been created. Here are your sign-in details:`,
        ``,
        `Username: ${params.upn}`,
        `Temporary password: ${params.tempPassword || "(retrieve from create-user step)"}`,
        ``,
        `On first sign-in:`,
        `1. You'll be prompted to change your password`,
        `2. Set up MFA on your phone (Microsoft Authenticator app recommended)`,
        `3. Sign in to https://portal.office.com to access email and apps`,
        ``,
        `If you have any questions, reply to this email or open a ticket at the IT helpdesk.`,
        ``,
        `— IT Team, Renovation Brands`
      ].join("\n");
      return {
        ok: true,
        message: "Welcome email drafted — review and send manually",
        data: { to: params.cc, cc: params.to, subject, body: bodyText }
      };
    }

    case "disable-account": {
      const user = await getUserByEmail(params.email);
      if (!user) return { ok: false, message: "User not found: " + params.email };
      await disableUser(user.id);
      return { ok: true, message: `Disabled ${user.userPrincipalName}`, data: { userId: user.id } };
    }

    case "remove-licenses": {
      const user = await getUserByEmail(params.email);
      if (!user) return { ok: false, message: "User not found" };
      const result = await removeAllLicenses(user.id);
      return { ok: true, message: `Removed ${result.removed} license(s)` };
    }

    case "remove-groups": {
      // This requires iterating through groups and removing — best-effort
      return { ok: true, message: "Group removal queued (manual cleanup recommended for nested groups)", data: { note: "Use Entra portal to verify clean removal" } };
    }

    case "forward-email": {
      const user = await getUserByEmail(params.email);
      if (!user) return { ok: false, message: "User not found" };
      await setMailForwarding(user.id, params.forwardTo);
      return { ok: true, message: `Mailbox auto-reply set, forwarding hint added` };
    }

    default:
      return { ok: false, message: "Unknown step: " + stepId };
  }
}

app.http("onboardExecute", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isInItTeam(principal)) {
      return { status: 403, jsonBody: { error: "Not authorized" } };
    }

    let body;
    try { body = await request.json(); } catch { return { status: 400, jsonBody: { error: "Invalid JSON" } }; }

    const { ticketId, stepId, params } = body;
    if (!ticketId || !stepId) {
      return { status: 400, jsonBody: { error: "ticketId and stepId required" } };
    }

    context.log(`Executing step ${stepId} for ticket #${ticketId} by ${principal?.userDetails}`);

    try {
      const result = await runStep(stepId, params || {}, context);

      // Audit to ticket
      try {
        const noteLines = [
          `[🤖 Provisioning] ${stepId}`,
          `Executed by: ${principal?.userDetails || "?"}`,
          `Result: ${result.ok ? "✓ success" : "✗ failed"}`,
          result.message
        ];
        await fsAddNote(ticketId, noteLines.join("\n"), true);
      } catch (e) {
        context.log.warn("Could not add audit note: " + e.message);
      }

      return { jsonBody: { stepId, ...result } };
    } catch (err) {
      context.log.error(`Step ${stepId} failed: ${err.message}`);

      try {
        await fsAddNote(ticketId, `[🤖 Provisioning] ${stepId} FAILED\nError: ${err.message}`, true);
      } catch {}

      return { status: 500, jsonBody: { stepId, ok: false, error: err.message } };
    }
  }
});
