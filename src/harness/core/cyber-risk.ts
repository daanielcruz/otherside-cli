export const CYBER_RISK_INSTRUCTION =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

const CYBER_RISK_TOKEN = "_CYBER_RISK_";

export function injectCyberRiskInstruction(text: string): string {
  return text.replace(CYBER_RISK_TOKEN, () => CYBER_RISK_INSTRUCTION);
}

export function stripCyberRiskMarker(text: string): string {
  return text.replace(/_CYBER_RISK_\n*/, "");
}
