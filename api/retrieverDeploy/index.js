const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  const { ticketId, deviceId, employeeInfo, shippingSpeed, notes, includeReturnLabel } = req.body || {};
  if (!deviceId) { context.res = { status: 400, body: { error: "deviceId required" } }; return; }
  if (!employeeInfo?.name || !employeeInfo?.email || !employeeInfo?.address_line_1) {
    context.res = { status: 400, body: { error: "Missing required employee info (name, email, address)" } };
    return;
  }

  const apiKey = process.env.RETRIEVER_API_KEY;
  if (!apiKey) { context.res = { status: 500, body: { error: "RETRIEVER_API_KEY not configured" } }; return; }

  const payload = {
    device_id: deviceId,
    notes: notes || null,
    shipping_speed: shippingSpeed || "standard_shipping",
    include_return_label: includeReturnLabel || false,
    ticket_id: ticketId ? String(ticketId) : null,
    employee_info: {
      email: employeeInfo.email,
      name: employeeInfo.name,
      address_line_1: employeeInfo.address_line_1,
      address_line_2: employeeInfo.address_line_2 || null,
      address_city: employeeInfo.address_city,
      address_state: employeeInfo.address_state,
      address_zip: employeeInfo.address_zip,
      address_country: employeeInfo.address_country || "United States"
    },
    display_name: "Renovation Brands"
  };

  try {
    const res = await fetch("https://app.helloretriever.com/api/v2/deployments/", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      context.res = { status: res.status, body: { error: `Retriever error: ${JSON.stringify(data)}` } };
      return;
    }

    // Post note to Freshservice ticket
    if (ticketId) {
      const trackingUrl = `https://app.helloretriever.com/orders/${data.id}`;
      const note = `[🚀 Device Deployment — Retriever]\nOrder ID: ${data.id}\nDevice ID: ${deviceId}\nEmployee: ${employeeInfo.name} (${employeeInfo.email})\nShipping: ${shippingSpeed || "Standard"}\nStatus: ${data.shipment?.status || "created"}\nTrack: ${trackingUrl}\n\nInitiated by: ${principal?.userDetails || "IT Team"}`;
      try { await fsAddNote(ticketId, note, true); } catch(e) { context.log.warn("Note failed:", e.message); }
    }

    context.res = { status: 201, body: { ok: true, orderId: data.id, order: data } };
  } catch(err) {
    context.log.error("retrieverDeploy failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
