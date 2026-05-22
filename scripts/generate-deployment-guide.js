// Generates docs/DEPLOYMENT_GUIDE.docx (v3)
// Run: node scripts/generate-deployment-guide.js

const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageBreak
} = require("docx");

const BORDER = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const BORDERS = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
const ACCENT_HEX = "5A6A2E";

function p(text, opts = {}) {
  return new Paragraph({
    children: typeof text === "string" ? [new TextRun({ text, ...opts })] : text,
    spacing: { after: 100 }
  });
}
function bullet(text, level = 0) {
  return new Paragraph({
    children: typeof text === "string" ? [new TextRun(text)] : text,
    numbering: { reference: "bullets", level },
    spacing: { after: 60 }
  });
}
function numbered(text) {
  return new Paragraph({
    children: typeof text === "string" ? [new TextRun(text)] : text,
    numbering: { reference: "numbers", level: 0 },
    spacing: { after: 60 }
  });
}
function code(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: "Consolas", size: 20 })],
    spacing: { after: 80, before: 40 },
    shading: { fill: "F4F4F0", type: ShadingType.CLEAR },
    indent: { left: 200, right: 200 }
  });
}
function callout(label, text, color = ACCENT_HEX, bg = "F4F8E8") {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [9360],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            borders: {
              top: { style: BorderStyle.SINGLE, size: 6, color },
              bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
              left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
              right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
            },
            width: { size: 9360, type: WidthType.DXA },
            shading: { fill: bg, type: ShadingType.CLEAR },
            margins: { top: 160, bottom: 160, left: 200, right: 200 },
            children: [
              new Paragraph({
                children: [new TextRun({ text: label + " ", bold: true, color }), new TextRun(text)]
              })
            ]
          })
        ]
      })
    ]
  });
}
function calloutWarn(label, text) { return callout(label, text, "C04A2E", "FBEEE8"); }
function h1(t){return new Paragraph({heading:HeadingLevel.HEADING_1, children:[new TextRun({text:t,bold:true})], spacing:{before:360,after:200}});}
function h2(t){return new Paragraph({heading:HeadingLevel.HEADING_2, children:[new TextRun({text:t,bold:true})], spacing:{before:280,after:140}});}
function h3(t){return new Paragraph({heading:HeadingLevel.HEADING_3, children:[new TextRun({text:t,bold:true})], spacing:{before:200,after:100}});}
function spacer(){return new Paragraph({children:[new TextRun("")], spacing:{after:120}});}
function pageBreak(){return new Paragraph({children:[new PageBreak()]});}

const content = [
  // TITLE
  new Paragraph({ children: [new TextRun({ text: "TRIAGE COCKPIT", font: "Consolas", size: 24, color: ACCENT_HEX, characterSpacing: 80 })], spacing: { before: 1200, after: 80 } }),
  new Paragraph({ children: [new TextRun({ text: "Azure Deployment Guide", size: 64, bold: true })], spacing: { after: 100 } }),
  new Paragraph({ children: [new TextRun({ text: "v3 — Intelligent Operations Layer", size: 32, italics: true, color: ACCENT_HEX })], spacing: { after: 300 } }),
  new Paragraph({ children: [new TextRun({ text: "From zero to a live IT dashboard with Freshservice, Microsoft Graph, and Claude integration", italics: true, size: 24, color: "555555" })], spacing: { after: 400 } }),
  new Paragraph({ children: [new TextRun({ text: "RENOVATION BRANDS · IT OPERATIONS", font: "Consolas", size: 18, characterSpacing: 60, color: "888888" })], spacing: { after: 80 } }),
  new Paragraph({ children: [new TextRun({ text: "Written for non-coders · Estimated 3–4 evenings", size: 20, color: "888888" })], spacing: { after: 1200 } }),
  pageBreak(),

  h1("Before you start"),
  p("This guide deploys the Triage Cockpit v3 to Azure. Compared to v2, v3 adds live Microsoft Graph integration (M365 context, onboarding automation), automatic AI classification of every new ticket via webhook, AI-drafted replies, and a daily scheduled job for offboard account disables."),
  h2("What you'll end up with"),
  bullet("A web app at a URL like https://triage.renovationbrands.com (or an azurestaticapps.net subdomain)."),
  bullet("Single sign-on through Entra ID — only you, Steve, and Eric can access it."),
  bullet("Live tickets refreshing every 60 seconds."),
  bullet("Live writes: changes go straight to Freshservice."),
  bullet("M365 context on every ticket: account status, MFA, sign-in activity, licenses, groups."),
  bullet("Auto-triage on creation: new tickets get classified within ~5 seconds."),
  bullet("Onboarding & offboarding automation."),
  bullet("AI reply drafting with optional opt-in auto-send."),
  bullet("Two scheduled jobs: morning pattern report and daily offboard disable check."),
  bullet("Total cost: about $15–30/month all-in."),
  h2("What you'll need"),
  bullet("Azure subscription."),
  bullet("Global Admin in Entra ID — required for Graph consent."),
  bullet("A GitHub account."),
  bullet("Freshservice API key."),
  bullet("Freshservice admin access (to create webhook workflows)."),
  bullet("Anthropic API key from console.anthropic.com."),
  bullet("3–4 hours total, split across 2–3 sittings."),
  callout("Heads up:", "Some Azure steps need 30–60 seconds for resources to provision. Don't panic if the portal hangs — be patient."),
  spacer(),
  h2("Phases"),
  numbered("Phase 1 — Create the GitHub repo (15 min)"),
  numbered("Phase 2 — Create Azure resources (30 min)"),
  numbered("Phase 3 — Entra ID app for dashboard sign-in (20 min)"),
  numbered("Phase 4 — Entra ID app for Graph API (25 min)"),
  numbered("Phase 5 — Store secrets in Key Vault (15 min)"),
  numbered("Phase 6 — Deploy & first sign-in (15 min)"),
  numbered("Phase 7 — Add Steve and Eric (5 min)"),
  numbered("Phase 8 — Teams webhook for pattern reports (10 min)"),
  numbered("Phase 9 — Freshservice webhook for auto-triage (15 min)"),
  numbered("Phase 10 — Verify everything works (20 min)"),
  pageBreak(),

  h1("Phase 1 — Create the GitHub repo"),
  p("Goal: get the code into GitHub so Azure can deploy automatically."),
  h2("Step 1.1 — Create a new private repo"),
  numbered("Go to https://github.com/new"),
  numbered("Repository name: rb-triage-cockpit"),
  numbered("Set it to Private"),
  numbered("Skip the README/.gitignore/license options — we have our own"),
  numbered("Click Create repository"),
  h2("Step 1.2 — Upload the project files"),
  h3("Web upload (easiest if new to git)"),
  numbered("On your new empty repo page, click \"uploading an existing file\""),
  numbered("Drag the CONTENTS of the triage-cockpit folder (not the folder itself) into the upload area"),
  numbered("Scroll to Commit changes, click Commit changes"),
  h3("Or via git command line"),
  code("cd path/to/triage-cockpit"),
  code("git init && git add . && git commit -m \"initial commit\""),
  code("git branch -M main"),
  code("git remote add origin https://github.com/YOUR-USERNAME/rb-triage-cockpit.git"),
  code("git push -u origin main"),
  callout("Stop point:", "All files visible in your GitHub repo. Fix before continuing."),
  pageBreak(),

  h1("Phase 2 — Create Azure resources"),
  p("Goal: provision the Static Web App and Key Vault in Azure."),
  h2("Step 2.1 — Sign in to Azure"),
  numbered("Go to https://portal.azure.com and sign in with your work account"),
  h2("Step 2.2 — Create a Resource Group"),
  numbered("Search → Resource groups → + Create"),
  numbered("Resource group name: rg-triage-cockpit · Region: East US 2"),
  numbered("Review + create → Create"),
  h2("Step 2.3 — Create the Static Web App"),
  numbered("Search → Static Web Apps → + Create"),
  numbered("Resource Group: rg-triage-cockpit · Name: rb-triage-cockpit · Plan: Standard · Region: East US 2"),
  numbered("Source: GitHub → Sign in → authorize"),
  numbered("Repository: rb-triage-cockpit · Branch: main"),
  numbered("Build Presets: Custom · App location: /public · Api location: /api · Output location: blank"),
  numbered("Review + create → Create. Wait ~60 seconds."),
  callout("What just happened:", "Azure wrote a GitHub Actions workflow to your repo. First build will fail because secrets aren't ready — that's fine."),
  h2("Step 2.4 — Create the Key Vault"),
  numbered("Search → Key vaults → + Create"),
  numbered("Resource Group: rg-triage-cockpit · Name: rb-triage-kv (globally unique — try rb-triage-kv-1 if taken)"),
  numbered("Region: East US 2 · Pricing: Standard"),
  numbered("Next → Access configuration: Azure RBAC (IMPORTANT)"),
  numbered("Review + create → Create"),
  callout("Stop point:", "3 resources in rg-triage-cockpit: SWA, Key Vault, hidden Functions backend."),
  pageBreak(),

  h1("Phase 3 — Entra ID app for dashboard sign-in"),
  p("Goal: register the first of two Entra apps. This one handles sign-in to the dashboard."),
  h2("Step 3.1 — Register the SWA auth app"),
  numbered("Search → App registrations → + New registration"),
  numbered("Name: rb-triage-cockpit-auth"),
  numbered("Account types: Single tenant"),
  numbered("Redirect URI: blank for now"),
  numbered("Register"),
  numbered("Copy the Application (client) ID and Directory (tenant) ID — save in a notepad"),
  h2("Step 3.2 — Add the redirect URI"),
  numbered("Authentication → + Add a platform → Web"),
  numbered("Get your SWA URL from its Overview page (e.g., https://wonderful-pond-abc123.5.azurestaticapps.net)"),
  numbered("Redirect URI: [your URL]/.auth/login/aad/callback"),
  numbered("Configure"),
  h2("Step 3.3 — Create a client secret"),
  numbered("Certificates & secrets → + New client secret"),
  numbered("Description: triage-auth · Expires: 24 months → Add"),
  numbered("COPY THE VALUE NOW — you can't see it again"),
  h2("Step 3.4 — Set Static Web App env vars"),
  numbered("Static Web App → Environment variables → + Add three values:"),
  bullet("AAD_CLIENT_ID = Application (client) ID from step 3.1"),
  bullet("AAD_CLIENT_SECRET = the secret value from step 3.3"),
  bullet("AAD_TENANT_ID = Directory (tenant) ID from step 3.1"),
  numbered("Save"),
  h2("Step 3.5 — Edit staticwebapp.config.json"),
  numbered("In GitHub, navigate to staticwebapp.config.json → pencil to edit"),
  numbered("Find <YOUR-TENANT-ID> and replace with your tenant ID"),
  numbered("Commit changes (triggers redeploy)"),
  callout("Stop point:", "Dashboard sign-in wired. App still won't fully work yet."),
  pageBreak(),

  h1("Phase 4 — Entra ID app for Graph API"),
  p("Goal: register a SECOND Entra app for Graph permissions. Keeping it separate from the auth app means each can be rotated independently."),
  callout("Why two apps?", "The auth app handles sign-in. The Graph app holds powerful permissions (create users, assign licenses). Separating them is a security best practice."),
  h2("Step 4.1 — Register the Graph app"),
  numbered("App registrations → + New registration"),
  numbered("Name: rb-triage-cockpit-graph · Account types: Single tenant · Redirect URI: blank"),
  numbered("Register"),
  numbered("Copy the Application (client) ID — label it \"Graph client ID\""),
  h2("Step 4.2 — Add Application permissions"),
  numbered("API permissions → + Add a permission → Microsoft Graph → Application permissions"),
  numbered("Search and check each:"),
  bullet("User.Read.All"),
  bullet("User.ReadWrite.All"),
  bullet("Group.Read.All"),
  bullet("Group.ReadWrite.All"),
  bullet("Directory.Read.All"),
  bullet("AuditLog.Read.All"),
  bullet("LicenseAssignment.ReadWrite.All"),
  bullet("Organization.Read.All"),
  bullet("Mail.ReadWrite"),
  numbered("Add permissions"),
  h2("Step 4.3 — Add Delegated permissions"),
  numbered("+ Add a permission → Microsoft Graph → Delegated permissions"),
  bullet("User.Read"),
  bullet("Mail.Send (optional)"),
  numbered("Add permissions"),
  h2("Step 4.4 — Grant admin consent"),
  calloutWarn("Important:", "Requires Global Admin (you have this). Without consent, every Graph call fails."),
  numbered("API permissions → Grant admin consent for [Your Org]"),
  numbered("Yes"),
  numbered("Verify every row has a green checkmark under Status"),
  h2("Step 4.5 — Create a client secret"),
  numbered("Certificates & secrets → + New client secret"),
  numbered("Description: triage-graph · Expires: 24 months → Add"),
  numbered("Copy the value — label it \"Graph client secret\""),
  h2("Step 4.6 — Set SWA env var"),
  numbered("SWA → Environment variables → + Add"),
  numbered("AAD_GRAPH_CLIENT_ID = Graph client ID from 4.1 → Save"),
  callout("Stop point:", "Graph app registered with consent. Secret goes into Key Vault next phase."),
  pageBreak(),

  h1("Phase 5 — Store secrets in Key Vault"),
  p("Goal: secrets in Key Vault, SWA's identity granted read access."),
  h2("Step 5.1 — Grant yourself access"),
  numbered("Key Vault → Access control (IAM) → + Add → Add role assignment"),
  numbered("Role: Key Vault Secrets Officer → Next"),
  numbered("Members: + Select members → pick yourself → Review + assign"),
  h2("Step 5.2 — Add all six secrets"),
  numbered("Wait ~30 seconds for role propagation, refresh, then Secrets → + Generate/Import for each:"),
  new Table({
    width: { size: 9360, type: WidthType.DXA },
    rows: [
      new TableRow({ children: [
        new TableCell({ borders: BORDERS, shading: { fill: "F4F4F0", type: ShadingType.CLEAR }, children: [p("Secret name", { bold: true })] }),
        new TableCell({ borders: BORDERS, shading: { fill: "F4F4F0", type: ShadingType.CLEAR }, children: [p("Value", { bold: true })] })
      ]}),
      ...[
        ["FRESHSERVICE-API-KEY", "Your Freshservice API key"],
        ["ANTHROPIC-API-KEY", "Your sk-ant-... key"],
        ["TEAMS-WEBHOOK-URL", "Leave blank — set in Phase 8"],
        ["AAD-GRAPH-CLIENT-SECRET", "Graph client secret from step 4.5"],
        ["FRESHSERVICE-WEBHOOK-SECRET", "Make up a 32+ char random string (use a password generator). Save this — you need it again in Phase 9."],
        ["AUTO-REPLY-SETTINGS", "Set value to: {\"globalEnabled\":false}"]
      ].map(([n,v]) => new TableRow({ children: [
        new TableCell({ borders: BORDERS, children: [p(n, { font: "Consolas" })] }),
        new TableCell({ borders: BORDERS, children: [p(v)] })
      ]}))
    ]
  }),
  spacer(),
  h2("Step 5.3 — Enable SWA managed identity"),
  numbered("SWA → Identity → System assigned → Status: On → Save → Yes"),
  numbered("Copy the Object ID"),
  h2("Step 5.4 — Grant managed identity to Key Vault"),
  numbered("Key Vault → Access control (IAM) → + Add → Add role assignment"),
  numbered("Role: Key Vault Secrets User → Next"),
  numbered("Assign access to: Managed identity → + Select members → Static Web App → rb-triage-cockpit"),
  numbered("Review + assign"),
  h2("Step 5.5 — Final env vars"),
  numbered("SWA → Environment variables → + Add:"),
  bullet("KEY_VAULT_NAME = rb-triage-kv"),
  bullet("FRESHSERVICE_DOMAIN = renovationbrands.freshservice.com"),
  numbered("Save"),
  callout("Stop point:", "All secrets in Key Vault. Ready to deploy."),
  pageBreak(),

  h1("Phase 6 — Deploy and first sign-in"),
  h2("Step 6.1 — Check deployment"),
  numbered("GitHub → Actions tab → latest workflow"),
  numbered("Green = good. Red = click in, read the error."),
  h2("Step 6.2 — Open the app"),
  numbered("SWA → Overview → click the URL"),
  numbered("You'll be redirected to Microsoft sign-in → sign in"),
  numbered("Expect \"Access denied\" — Phase 7 fixes this"),
  callout("Stop point:", "Sign-in works, you get 403 (denied) on dashboard. Don't continue if you can't even sign in."),
  pageBreak(),

  h1("Phase 7 — Grant access to the IT team"),
  h2("Step 7.1 — Invite yourself"),
  numbered("SWA → Role management → + Invite"),
  numbered("Provider: Microsoft (Azure Active Directory)"),
  numbered("Email: your work email · Role: it-team"),
  numbered("Generate invitation → paste link in browser → sign in"),
  h2("Step 7.2 — Invite Steve and Eric"),
  p("Same process for steve.mitchell@renovationbrands.com and eric.hnatov@renovationbrands.com. Send the links via Teams."),
  h2("Step 7.3 — Test access"),
  numbered("Incognito → app URL → sign in → dashboard loads"),
  numbered("First ticket fetch may take ~5 seconds (cold start)"),
  numbered("Click a ticket — M365 Context loads in ~3 seconds"),
  calloutWarn("Troubleshooting:", "M365 context errors usually mean Phase 4 admin consent isn't granted. Verify all green checkmarks in App registrations → rb-triage-cockpit-graph → API permissions."),
  pageBreak(),

  h1("Phase 8 — Teams webhook for pattern reports"),
  h2("Step 8.1 — Create the webhook"),
  callout("Note:", "Microsoft is replacing Connectors with Workflows. Use whichever your tenant supports."),
  h3("Workflows (newer)"),
  numbered("Teams → channel → three dots → Workflows"),
  numbered("Search: \"Post to a channel when a webhook request is received\""),
  numbered("Next → Sign in → choose Team/Channel → Add workflow"),
  numbered("Copy the webhook URL"),
  h3("Connectors (older)"),
  numbered("Channel → Connectors → Incoming Webhook → Configure"),
  numbered("Name: Triage Cockpit → Create → copy URL"),
  h2("Step 8.2 — Save URL to Key Vault"),
  numbered("Azure portal → Key Vault → Secrets → TEAMS-WEBHOOK-URL → + New Version"),
  numbered("Paste the URL → Create"),
  h2("Step 8.3 — Test"),
  numbered("SWA → Functions → patternsScheduled → Code + Test → Test/Run → Run"),
  numbered("Within seconds, your Teams channel gets a Pattern Report card"),
  callout("Schedules:", "Pattern report: Mon–Fri 12:00 UTC. Offboard scheduler: daily 23:00 UTC. Edit schedules in api/*/index.js to change."),
  pageBreak(),

  h1("Phase 9 — Freshservice webhook for auto-triage"),
  p("Goal: new tickets in Freshservice fire our auto-triage Function within seconds."),
  h2("Step 9.1 — Construct your webhook URL"),
  numbered("Start with: [your dashboard URL]/api/webhookTicketCreated"),
  numbered("Append: ?token=YOUR-FRESHSERVICE-WEBHOOK-SECRET-VALUE (the random string from Key Vault Phase 5.2)"),
  numbered("Example: https://wonderful-pond-abc123.5.azurestaticapps.net/api/webhookTicketCreated?token=Xa9zP3kQ..."),
  h2("Step 9.2 — Create the Freshservice workflow"),
  numbered("Log in to Freshservice as admin"),
  numbered("Admin → Workflow Automator"),
  numbered("+ New Automator → Type: Ticket → Event: Ticket Created"),
  numbered("Conditions: leave default (matches any new ticket) or filter as you like"),
  numbered("Actions → Add → Trigger Webhook"),
  numbered("Webhook configuration:"),
  bullet("Request URL: paste your full URL including token"),
  bullet("Request Type: POST"),
  bullet("Encoding: JSON"),
  bullet("Content type: Advanced"),
  bullet("Content body:"),
  code("{ \"ticket_id\": \"{{ticket.id}}\" }"),
  numbered("Save and activate the automator"),
  h2("Step 9.3 — Test it"),
  numbered("In Freshservice, create a test ticket (any subject/description)"),
  numbered("Watch logs: SWA → Functions → webhookTicketCreated → Monitor"),
  numbered("Within ~5 seconds you'll see an invocation"),
  numbered("Open your test ticket: there's a private note titled [🤖 AI Triage]"),
  numbered("If confidence ≥70%, the ticket's category/priority were also updated"),
  calloutWarn("Troubleshooting:", "401 from your Function = token mismatch. The token in the Freshservice URL must exactly equal FRESHSERVICE-WEBHOOK-SECRET in Key Vault — no whitespace, exact match."),
  pageBreak(),

  h1("Phase 10 — Final verification"),
  h2("Walk through this checklist"),
  bullet("Sign in to dashboard with work account — loads tickets"),
  bullet("Click a ticket → M365 Context section populates with requester's account"),
  bullet("Disabled-account or risky-sign-in shows a red blocker banner"),
  bullet("Run AI triage — Claude generates summary, suggestions, resolutions, next action"),
  bullet("Click \"Draft reply with AI\" — draft appears with confidence score"),
  bullet("Edit draft, click Send reply — it lands in Freshservice as a public reply"),
  bullet("Find an onboarding-shaped ticket → Provisioning Checklist appears with parsed fields"),
  bullet("Click ▶ Run on \"Check UPN availability\" — works (no side effects)"),
  bullet("⚠ Don't run \"Create M365 user\" unless you actually want to create one. Use a disposable name if testing."),
  bullet("Settings modal (⚙ icon) → toggles load, save works"),
  bullet("Standup tab → metrics, what's new, AI queue"),
  bullet("Patterns tab → clusters across tickets"),
  bullet("Create a fresh ticket in Freshservice → within 10 seconds it's auto-triaged"),
  pageBreak(),

  h1("Day-2 operations"),
  h2("Adding/removing IT teammates"),
  numbered("SWA → Role management → + Invite (or three dots → Delete)"),
  h2("Rotating secrets"),
  numbered("Get new key/secret from source"),
  numbered("Key Vault → Secrets → click secret → + New Version → paste"),
  numbered("App picks up within ~5 minutes"),
  h2("Auto-reply config"),
  numbered("Dashboard → gear icon (⚙) in top bar"),
  numbered("Toggle master switch, adjust per-category, edit blocked keywords"),
  numbered("Save — applies globally"),
  h2("Pausing auto-triage temporarily"),
  numbered("Freshservice → Admin → Workflow Automator"),
  numbered("Find your webhook automator → toggle inactive"),
  h2("Changing schedules"),
  numbered("Edit api/patternsScheduled/index.js or api/offboardScheduled/index.js"),
  numbered("Format: \"second minute hour day month dayOfWeek\" in UTC"),
  numbered("Commit & push — auto-deploys"),
  h2("Custom domain"),
  numbered("SWA → Custom domains → + Add"),
  numbered("Create CNAME at DNS provider"),
  numbered("Update BOTH Entra ID apps' redirect URIs after switchover"),
  h2("Costs"),
  bullet("Static Web App Standard: $9/month"),
  bullet("Functions: free under 1M executions"),
  bullet("Key Vault: pennies (~$0.03 per 10K reads)"),
  bullet("Graph API: free (included with M365)"),
  bullet("Anthropic API: pay-as-you-go (~$5–20/month at typical IT volume)"),
  bullet("Total: $15–30/month all-in"),
  spacer(),
  p("Welcome to v3. — Built for Nathan, with Claude.", { italics: true })
];

const doc = new Document({
  styles: {
    default: { document: { run: { font: "Calibri", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 40, bold: true, font: "Calibri", color: "2A3A1A" },
        paragraph: { spacing: { before: 400, after: 200 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, font: "Calibri", color: ACCENT_HEX },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: "Calibri", color: "333333" },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 2 } }
    ]
  },
  numbering: {
    config: [
      { reference: "bullets", levels: [
        { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } }
      ]},
      { reference: "numbers", levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }
      ]}
    ]
  },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    children: content
  }]
});

Packer.toBuffer(doc).then(buf => {
  const outPath = path.join(__dirname, "..", "docs", "DEPLOYMENT_GUIDE.docx");
  fs.writeFileSync(outPath, buf);
  console.log("Wrote", outPath, "(" + buf.length + " bytes)");
});
