export const DEEP_SECURITY_REVIEW_IDENTITY = `function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

function cleanString(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function normalizeIdentityPart(s) {
  return String(s || "").toLowerCase().replace(/\\s+/g, " ").replace(/["']/g, "").trim();
}

function semanticKey(c) {
  const location = normalizeIdentityPart(c.file || c.path || c.location || "");
  const snippetPart = c.snippet ? "snippet:" + cyrb53(normalizeIdentityPart(c.snippet)).slice(0, 12) : "";
  return [
    normalizeIdentityPart(c.category),
    normalizeIdentityPart(c.cwe || c.owasp || ""),
    normalizeIdentityPart(c.rootCause || c.summary || ""),
    normalizeIdentityPart(c.source || ""),
    normalizeIdentityPart(c.sink || ""),
    normalizeIdentityPart(c.impact || c.exploitPath || c.reachablePath || c.whyExploitable || ""),
    location || snippetPart,
    location ? snippetPart : "",
  ].join("|");
}

const idBySemanticKey = new Map();
const semanticKeyById = new Map();

function stableCandidateIdentity(c) {
  const key = c.semanticKey || semanticKey(c);
  if (idBySemanticKey.has(key)) return { id: idBySemanticKey.get(key), semanticKey: key };
  const cleanCat = cleanString(c.category) || "unknown";
  const cleanCwe = cleanString(c.cwe || c.owasp) || "na";
  const baseId = "F-" + cleanCat + "-" + cleanCwe + "-" + cyrb53(key);
  let finalId = baseId;
  let suffix = 1;
  while (semanticKeyById.has(finalId) && semanticKeyById.get(finalId) !== key) {
    finalId = baseId + "-" + suffix;
    suffix++;
  }
  semanticKeyById.set(finalId, key);
  idBySemanticKey.set(key, finalId);
  return { id: finalId, semanticKey: key };
}

function assignStableIdentity(c) {
  const identity = stableCandidateIdentity(c);
  return { ...c, id: identity.id, semanticKey: identity.semanticKey, state: c.state || "candidate" };
}

function normalizeFindingId(value, findings) {
  if (typeof value === "number") return findings[value] ? findings[value].id : String(value);
  const text = String(value || "").trim();
  if (/^[0-9]+$/.test(text)) {
    const zeroBased = Number(text);
    if (findings[zeroBased]) return findings[zeroBased].id;
    const oneBased = zeroBased - 1;
    if (findings[oneBased]) return findings[oneBased].id;
  }
  return text;
}

function normalizeFindingIds(values, findings) {
  const ids = [];
  for (const value of values || []) {
    const id = normalizeFindingId(value, findings);
    if (id && ids.indexOf(id) === -1) ids.push(id);
  }
  return ids;
}

function findingRecord(c, state, extra = {}) {
  return {
    id: c.id,
    state,
    severity: c.severity,
    category: c.category,
    file: c.file,
    line: c.line,
    cwe: c.cwe,
    owasp: c.owasp,
    verdict: c.verdict,
    summary: c.summary,
    source: c.source,
    sink: c.sink,
    poc: c.poc || c.exploitPath,
    semanticKey: c.semanticKey,
    ...extra,
  };
}

`;
