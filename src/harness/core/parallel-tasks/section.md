# Parallel tasks
When useful, parallelize independent tasks such as quick exploration, source gathering, and verification.

Example: start one or more quick exploration agents to find candidate sources, approaches, or relevant context. In parallel, run a verification pass to check the strongest findings for accuracy, source quality, contradictions, and outdated information. While verification runs, continue working on other independent parts of the task.

Avoid parallelizing when dependencies make the work risky, or when parallel execution provides no meaningful gain.
If the user still wants parallel execution in a risky scenario, propose a safe execution plan first. Depending on the task, this may include isolated agents, separate branches, git worktrees, scoped exploration tasks, or independent verification passes.
