# Renovation Brands · Triage Cockpit (v3)

Internal IT triage dashboard for Renovation Brands. Pulls live tickets from Freshservice, integrates with Microsoft Graph for M365 context and provisioning automation, uses Claude AI for triage and reply drafting, and writes changes back. Deployed on Azure Static Web Apps with Entra ID authentication restricted to the IT team.

## What's new in v3

- **M365 Context Pane** — automatic Graph API lookup of every requester. See account status, MFA, last sign-in, risky activity, licenses, and groups inline with the ticket.
- **Auto-Triage on Ticket Creation** — Freshservice webhook fires a Function that classifies new tickets with AI. Confidence ≥ 70% gets applied automatically; lower goes to a suggestion note.
- **Onboarding / Offboarding Automation** — AI parses the HR ticket into structured fields, generates a checklist with auto-executable steps (create user, assign license, add to groups), and queues offboard disables to fire on the actual last day.
- **AI Reply Drafting** — every ticket has a "Draft reply" button. AI uses ticket content + M365 context + similar past resolutions to write a tailored reply. You review, edit, send. Per-category opt-in to skip the review step on high-confidence drafts.
- **Scheduled offboard execution** — daily 23:00 UTC job that scans open offboard tickets, disables accounts whose last day is today.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Edge / Chrome)                                 │
│  ↳ Static frontend served from Azure Static Web Apps    │
└──────────────┬──────────────────────────────────────────┘
               │ Entra ID (Azure AD) sign-in
               │ Role: it-team required
               ▼
┌─────────────────────────────────────────────────────────┐
│  Azure Static Web Apps (Standard tier, ~$9/mo)          │
│  ↳ Hosts /public                                         │
│  ↳ Routes /api/* to Azure Functions                     │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  Azure Functions (12 endpoints)                          │
│  HTTP:                                                   │
│  • GET  /api/tickets        — live Freshservice fetch   │
│  • POST /api/aiTriage       — Claude API proxy          │
│  • POST /api/applyChanges   — write back to FS          │
│  • GET  /api/m365Context    — Graph context for user    │
│  • POST /api/onboardParse   — parse provisioning ticket │
│  • POST /api/onboardExecute — run a checklist step      │
│  • POST /api/replyDraft     — draft AI reply            │
│  • POST /api/replySend      — send reply to requester   │
│  • GET/POST /api/settingsAutoReply — opt-in config      │
│  • POST /api/webhookTicketCreated  — FS new-ticket hook │
│                                                          │
│  TIMER:                                                  │
│  • patternsScheduled  — nightly Teams pattern report    │
│  • offboardScheduled  — daily account disable for       │
│                         offboards whose last day is now │
└──────────────┬──────────────────────────────────────────┘
               │ Managed Identity
               ▼
┌─────────────────────────────────────────────────────────┐
│  Azure Key Vault (rb-triage-kv)                          │
│  • FRESHSERVICE-API-KEY                                  │
│  • ANTHROPIC-API-KEY                                     │
│  • TEAMS-WEBHOOK-URL                                     │
│  • AAD-GRAPH-CLIENT-SECRET                               │
│  • FRESHSERVICE-WEBHOOK-SECRET                           │
│  • AUTO-REPLY-SETTINGS    (JSON blob)                    │
└──────────────┬──────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────┐
│  External services                                       │
│  • Microsoft Graph (app + delegated permissions)        │
│  • Anthropic Claude API                                  │
│  • Freshservice REST API + webhook                      │
│  • Teams Incoming Webhook                                │
└─────────────────────────────────────────────────────────┘
```

## Repo structure

```
triage-cockpit/
├── public/                       # Static frontend
│   ├── index.html                # The dashboard
│   └── unauthorized.html
├── api/                          # Azure Functions
│   ├── shared/
│   │   ├── clients.js            # KV, Freshservice, Claude, Teams helpers
│   │   └── graph.js              # Microsoft Graph helpers (app + delegated)
│   ├── tickets/
│   ├── aiTriage/
│   ├── applyChanges/
│   ├── m365Context/              ◄ v3
│   ├── onboardParse/             ◄ v3
│   ├── onboardExecute/           ◄ v3
│   ├── replyDraft/               ◄ v3
│   ├── replySend/                ◄ v3
│   ├── settingsAutoReply/        ◄ v3
│   ├── webhookTicketCreated/     ◄ v3
│   ├── patternsScheduled/
│   ├── offboardScheduled/        ◄ v3
│   ├── host.json
│   └── package.json
├── .github/workflows/
│   └── azure-static-web-apps.yml
├── docs/
│   └── DEPLOYMENT_GUIDE.docx     # Updated for v3
├── staticwebapp.config.json
└── README.md
```

## Required Graph API permissions (admin consent needed)

The app needs a **second** Entra ID app registration for Graph access (separate from the SWA's auth registration). It needs:

**Application permissions** (for background tasks like auto-triage, scheduled offboards):
- `User.Read.All`
- `User.ReadWrite.All` (for onboarding/offboarding writes)
- `Group.Read.All`
- `Group.ReadWrite.All` (for adding users to groups)
- `Directory.Read.All`
- `AuditLog.Read.All` (for sign-in activity)
- `LicenseAssignment.ReadWrite.All`
- `Organization.Read.All`
- `Mail.ReadWrite` (for setting forwarding rules)

**Delegated permissions** (when an agent acts on a user's behalf via the dashboard):
- `User.Read`
- `Mail.Send` (in case we ever expose "send as me")

All require Global Admin consent (one-time grant).

## Setup

See `docs/DEPLOYMENT_GUIDE.docx` for full step-by-step deployment instructions, now updated with v3's Graph API and Freshservice webhook setup.

## Cost

Still approximately **$9–15/month** total. v3 adds no infrastructure — just more Function executions.

— Built for Nathan Maharg
