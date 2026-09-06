export const DEEP_SECURITY_REVIEW_AGENTS = `const degradedRouting = [];

async function safeAgent(prompt, options) {
  if (options && options.tier) {
    try {
      return await agent(prompt, options);
    } catch (e) {
      const errMsg = String(e.message || e);
      // Degrade ONLY for explicit routing failures (quota / rate limit / cooldown /
      // provider exhaustion). Config and schema errors (InputValidationError,
      // StructuredOutput* mismatches) and any unexpected exception must surface —
      // silently retrying on default routing would mask real bugs.
      const isConfigOrSchema =
        errMsg.includes("InputValidationError") || errMsg.includes("StructuredOutput");
      const isRouting =
        !isConfigOrSchema &&
        (errMsg.includes("No usable provider") ||
          errMsg.includes("rate limit") ||
          errMsg.includes("quota") ||
          errMsg.includes("429") ||
          errMsg.includes("529") ||
          errMsg.includes("exhausted") ||
          errMsg.includes("cooldown") ||
          errMsg.includes("throttled"));
      if (!isRouting) throw e;
      log("Routing degraded for " + (options.label || "agent") + ", using default routing: " + errMsg);
      degradedRouting.push("Degraded routing for " + (options.label || "agent") + ": " + errMsg);

      const fallbackOptions = {};
      for (const k in options) {
        if (k !== "tier") {
          fallbackOptions[k] = options[k];
        }
      }
      return await agent(prompt, fallbackOptions);
    }
  }
  return await agent(prompt, options);
}

`;
