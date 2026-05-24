const { getPrincipal, isInItTeam, fsAddNote } = require("../shared/clients");

module.exports = async function(context, req) {
  const principal = getPrincipal(req);
  if (!isInItTeam(principal)) { context.res = { status: 403, body: { error: "Not authorized" } }; return; }

  const { ticketId, employeeInfo, device, serialNumber, requestCharger, notes } = req.body || {};
  if (!employeeInfo?.name || !employeeInfo?.email || !employeeInfo?.address_line_1) {
    context.res = { status: 400, body: { error: "Missing required employee info (name, email, address)" } };
    return;
  }

  const apiKey = process.env.RETRIEVER_API_KEY;
  if (!apiKey) { context.res = { status: 500, body: { error: "RETRIEVER_API_KEY not configured" } }; return; }

  const payload = {
    device: device || "laptop",
    request_charger: requestCharger || false,
    request_cell_phone: false,
    request_disposal: false,
    request_for_warehouse: true,
    serial_number: serialNumber || null,
    ticket_id: ticketId ? String(ticketId) : null,
    note_1: notes || null,
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
    company_info: {
      display_name: "Renovation Brands"
    }
  };

  try {
    const res = await fetch("https://app.helloretriever.com/api/v2/device_returns/", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      context.res = { status: res.status, body: { error: `Retriever error: ${JSON.stringify(data)}` } };
      return;
    }

    // Post tracking note back to Freshservice ticket
    if (ticketId) {
      const trackingUrl = `https://app.helloretriever.com/orders/${data.id}`;
      const note = `[📦 Device Return — Retriever]\nOrder ID: ${data.id}\nEmployee: ${employeeInfo.name}\nDevice: ${device || "Laptop"}\nStatus: Order created — shipping box en route to employee\nTrack: ${trackingUrl}\n\nInitiated by: ${principal?.userDetails || "IT Team"}`;
      try { await fsAddNote(ticketId, note, true); } catch(e) { context.log.warn("Note failed:", e.message); }
    }

    context.res = { status: 201, body: { ok: true, orderId: data.id, order: data } };
  } catch(err) {
    context.log.error("retrieverReturn failed", err);
    context.res = { status: 500, body: { error: err.message } };
  }
};
