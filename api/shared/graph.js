// api/shared/graph.js
// Microsoft Graph API client — uses raw OAuth2 client credentials (no @azure/identity SDK)

const { getSecret } = require("./clients");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Token cache per Function instance
let _appTokenCache = null;
let _appTokenExpiry = 0;

async function getAppToken() {
  const now = Date.now();
  if (_appTokenCache && (_appTokenExpiry - now) > 5 * 60 * 1000) {
    return _appTokenCache;
  }
  const tenantId = process.env.AAD_TENANT_ID;
  const clientId = process.env.AAD_GRAPH_CLIENT_ID;
  const clientSecret = await getSecret("AAD-GRAPH-CLIENT-SECRET");

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default"
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token error: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  _appTokenCache = data.access_token;
  _appTokenExpiry = now + (data.expires_in * 1000);
  return _appTokenCache;
}

async function graphRequest(path, { method = "GET", body } = {}) {
  const token = await getAppToken();
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "ConsistencyLevel": "eventual"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error?.message || text; } catch {}
    const err = new Error(`Graph ${res.status}: ${detail.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function getUserByEmail(email) {
  const q = encodeURIComponent(email);
  try {
    return await graphRequest(`/users/${q}?$select=id,displayName,givenName,surname,mail,userPrincipalName,jobTitle,department,officeLocation,accountEnabled,onPremisesSyncEnabled,createdDateTime`);
  } catch (e) {
    if (e.status === 404) {
      const result = await graphRequest(`/users?$filter=mail eq '${email}' or otherMails/any(m:m eq '${email}')&$select=id,displayName,mail,userPrincipalName`);
      return result.value?.[0] || null;
    }
    throw e;
  }
}

async function getUserManager(userId) {
  try {
    return await graphRequest(`/users/${userId}/manager?$select=displayName,mail,jobTitle`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function getUserLicenses(userId) {
  const result = await graphRequest(`/users/${userId}/licenseDetails`);
  return (result.value || []).map(l => ({
    skuPartNumber: l.skuPartNumber,
    skuId: l.skuId,
    servicePlans: (l.servicePlans || []).filter(p => p.provisioningStatus === "Success").map(p => p.servicePlanName)
  }));
}

async function getUserGroups(userId) {
  const result = await graphRequest(`/users/${userId}/transitiveMemberOf?$select=displayName,mailEnabled,securityEnabled&$top=50`);
  return (result.value || [])
    .filter(g => g["@odata.type"] === "#microsoft.graph.group")
    .map(g => ({
      name: g.displayName,
      type: g.securityEnabled ? "security" : (g.mailEnabled ? "distribution" : "other")
    }));
}

async function getUserSignInActivity(userId) {
  try {
    const user = await graphRequest(`/users/${userId}?$select=signInActivity`);
    return user.signInActivity || null;
  } catch (e) { return null; }
}

async function getUserRiskySignIns(userId, days = 7) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  try {
    const result = await graphRequest(
      `/auditLogs/signIns?$filter=userId eq '${userId}' and createdDateTime ge ${since} and riskLevelDuringSignIn ne 'none'&$top=10&$select=createdDateTime,ipAddress,location,riskLevelDuringSignIn,riskState,status`
    );
    return result.value || [];
  } catch (e) { return []; }
}

async function getUserSignInLogs(userId, count = 10) {
  try {
    const result = await graphRequest(
      `/auditLogs/signIns?$filter=userId eq '${userId}'&$top=${count}&$orderby=createdDateTime desc&$select=createdDateTime,appDisplayName,ipAddress,location,status,riskLevelDuringSignIn,clientAppUsed,deviceDetail`
    );
    return result.value || [];
  } catch (e) { return []; }
}

async function getUserDevices(userId) {
  try {
    const result = await graphRequest(`/users/${userId}/registeredDevices?$select=displayName,operatingSystem,operatingSystemVersion,isCompliant,trustType,approximateLastSignInDateTime`);
    return (result.value || []).slice(0, 8);
  } catch (e) { return []; }
}

async function getUserMfaStatus(userId) {
  try {
    const result = await graphRequest(`/users/${userId}/authentication/methods`);
    const methods = result.value || [];
    const passwordless = methods.filter(m =>
      m["@odata.type"]?.includes("microsoftAuthenticator") ||
      m["@odata.type"]?.includes("fido2") ||
      m["@odata.type"]?.includes("windowsHello")
    );
    return {
      enrolled: methods.length > 1,
      methodCount: methods.length,
      strongAuthCount: passwordless.length,
      methods: methods.map(m => (m["@odata.type"] || "").replace("#microsoft.graph.", "").replace("AuthenticationMethod", ""))
    };
  } catch (e) { return { enrolled: null, error: e.message }; }
}

async function getConditionalAccessPolicies() {
  try {
    const result = await graphRequest(`/identity/conditionalAccess/policies?$select=displayName,state,conditions,grantControls`);
    return (result.value || []).filter(p => p.state === "enabled");
  } catch (e) { return []; }
}

async function getFullUserContext(email) {
  const user = await getUserByEmail(email);
  if (!user) return { found: false };

  const [manager, licenses, groups, signIn, risky, devices, mfa, signInLogs] = await Promise.allSettled([
    getUserManager(user.id),
    getUserLicenses(user.id),
    getUserGroups(user.id),
    getUserSignInActivity(user.id),
    getUserRiskySignIns(user.id, 7),
    getUserDevices(user.id),
    getUserMfaStatus(user.id),
    getUserSignInLogs(user.id, 5)
  ]);

  const unwrap = (r, fallback = null) => r.status === "fulfilled" ? r.value : fallback;

  return {
    found: true,
    id: user.id,
    displayName: user.displayName,
    upn: user.userPrincipalName,
    mail: user.mail,
    jobTitle: user.jobTitle,
    department: user.department,
    officeLocation: user.officeLocation,
    accountEnabled: user.accountEnabled,
    syncedFromAD: user.onPremisesSyncEnabled,
    createdAt: user.createdDateTime,
    manager: unwrap(manager),
    licenses: unwrap(licenses, []),
    groups: unwrap(groups, []),
    signInActivity: unwrap(signIn),
    riskySignIns: unwrap(risky, []),
    devices: unwrap(devices, []),
    mfa: unwrap(mfa, { enrolled: null }),
    recentSignIns: unwrap(signInLogs, [])
  };
}

// ============================================================
// ONBOARDING / OFFBOARDING ACTIONS
// ============================================================
async function checkUserAvailability(upn) {
  try {
    await graphRequest(`/users/${encodeURIComponent(upn)}?$select=id`);
    return { available: false, reason: "UPN already in use" };
  } catch (e) {
    if (e.status === 404) return { available: true };
    throw e;
  }
}

async function createUser({ firstName, lastName, upn, displayName, jobTitle, department, managerEmail, initialPassword }) {
  const body = {
    accountEnabled: true,
    displayName: displayName || `${firstName} ${lastName}`,
    givenName: firstName,
    surname: lastName,
    mailNickname: upn.split("@")[0],
    userPrincipalName: upn,
    jobTitle,
    department,
    usageLocation: "US",
    passwordProfile: { forceChangePasswordNextSignIn: true, password: initialPassword }
  };
  const created = await graphRequest("/users", { method: "POST", body });
  if (managerEmail) {
    try {
      const manager = await getUserByEmail(managerEmail);
      if (manager) {
        await graphRequest(`/users/${created.id}/manager/$ref`, {
          method: "PUT",
          body: { "@odata.id": `https://graph.microsoft.com/v1.0/users/${manager.id}` }
        });
      }
    } catch (e) { console.warn("Manager assign failed:", e.message); }
  }
  return created;
}

async function assignLicense(userId, skuId) {
  return graphRequest(`/users/${userId}/assignLicense`, {
    method: "POST",
    body: { addLicenses: [{ skuId, disabledPlans: [] }], removeLicenses: [] }
  });
}

async function getAvailableLicenses() {
  const result = await graphRequest("/subscribedSkus?$select=skuId,skuPartNumber,prepaidUnits,consumedUnits");
  return (result.value || []).map(s => ({
    skuId: s.skuId,
    skuPartNumber: s.skuPartNumber,
    available: (s.prepaidUnits?.enabled || 0) - (s.consumedUnits || 0)
  }));
}

async function addUserToGroup(userId, groupId) {
  return graphRequest(`/groups/${groupId}/members/$ref`, {
    method: "POST",
    body: { "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` }
  });
}

async function findGroupByName(name) {
  const result = await graphRequest(`/groups?$filter=displayName eq '${name.replace(/'/g, "''")}'&$select=id,displayName`);
  return result.value?.[0] || null;
}

async function disableUser(userId) {
  return graphRequest(`/users/${userId}`, { method: "PATCH", body: { accountEnabled: false } });
}

async function removeAllLicenses(userId) {
  const licenses = await getUserLicenses(userId);
  if (!licenses.length) return { removed: 0 };
  await graphRequest(`/users/${userId}/assignLicense`, {
    method: "POST",
    body: { addLicenses: [], removeLicenses: licenses.map(l => l.skuId) }
  });
  return { removed: licenses.length };
}

async function setMailForwarding(userId, forwardToEmail) {
  return graphRequest(`/users/${userId}/mailboxSettings`, {
    method: "PATCH",
    body: {
      automaticRepliesSetting: {
        status: "alwaysEnabled",
        internalReplyMessage: `This person has left the company. Email forwarded to ${forwardToEmail}.`,
        externalReplyMessage: `This person has left the company. Please contact ${forwardToEmail} for assistance.`
      }
    }
  });
}

module.exports = {
  graphRequest,
  getUserByEmail,
  getFullUserContext,
  getConditionalAccessPolicies,
  getUserSignInLogs,
  checkUserAvailability,
  createUser,
  assignLicense,
  getAvailableLicenses,
  addUserToGroup,
  findGroupByName,
  disableUser,
  removeAllLicenses,
  setMailForwarding
};
