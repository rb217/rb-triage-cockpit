// api/index.js
// Entry point — loads all Azure Functions v4 handlers

require("./tickets/index");
require("./aiTriage/index");
require("./applyChanges/index");
require("./m365Context/index");
require("./onboardParse/index");
require("./onboardExecute/index");
require("./replyDraft/index");
require("./replySend/index");
require("./settingsAutoReply/index");
require("./webhookTicketCreated/index");
