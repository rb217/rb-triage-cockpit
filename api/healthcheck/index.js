const { app } = require("@azure/functions");

app.http("healthcheck", {
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    return { 
      jsonBody: { 
        status: "ok", 
        time: new Date().toISOString(),
        env: {
          kvName: process.env.KEY_VAULT_NAME || "NOT SET",
          fsDomain: process.env.FRESHSERVICE_DOMAIN || "NOT SET"
        }
      } 
    };
  }
});
