# hello — placeholder skill

This is a placeholder skill shipped with 010 to exercise the `Skill`
tool dispatch path. Real first-party skills arrive in a later change.

## What this skill does

Nothing. Returning this content is the demonstration.

## When the model invokes this skill

The `Skill` tool reads `skills/<name>/SKILL.md` and returns it verbatim
as the `tool_result` content. The model can then act on the
instructions inside.
