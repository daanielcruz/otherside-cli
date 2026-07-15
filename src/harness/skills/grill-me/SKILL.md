---
name: grill-me
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, get grilled on their design, or mentions "grill me".
---

Interview the user relentlessly about every aspect of their plan until you reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one.

## How to ask questions

Use the **AskUserQuestion tool** for every question you ask. Never pose questions as plain text in your response — always use the multiple-choice popup so the user can quickly select an answer or type a custom one.

If a decision depends on facts you can verify, investigate first instead of asking immediately. 

If research still leaves ambiguity, put any longer explanation in a normal message and keep AskUserQuestion short and objective, focused only on the question the user needs to answer.

Prefer **one question at a time**. Wait for the user's answer before moving to the next question. This keeps the conversation focused and prevents overwhelm.

For each question, provide 2-4 concrete multiple-choice options representing the most likely answers or directions. Think about what the user would realistically choose - generic options like "Yes" / "No" aren't helpful unless the question is genuinely binary. The user always has the "Other" field available to write something custom.

When you genuinely have a recommendation, surface it: make your recommended option the **first** in the list, append **(Recommended)** to its label, and put your reasoning in that option's description. Only do this when you actually hold a substantive recommendation — never invent one to fill the slot. If the options are genuinely equivalent, or you lack the context to prefer one, present them neutrally and say so.

## Flow

1. After receiving an answer, briefly acknowledge the decision (1-2 sentences max), then immediately ask the next question via AskUserQuestion.
2. If a question can be answered by exploring the codebase or files, explore them yourself instead of asking the user.
3. Continue until all branches of the design tree are resolved.
4. When finished, provide a concise summary of all decisions made.
