#!/usr/bin/env bash
# memharness PostToolUse hook: after a real `git commit`, nudge the agent to
# capture any durable facts the work established. Reads the Claude Code hook
# payload on stdin and stays silent on everything else.
#
# Fires ONLY when the Bash command actually invokes `git commit` as the
# subcommand. It must NOT fire on look-alikes that merely contain the words,
# e.g. `git config commit.gpgsign ...`, `git grep commit`, `git log`,
# `echo "...git commit..."`, `grep "git commit"`, or a `# git commit` comment.
#
# Requires jq (standard in the Claude Code environment). Without jq it exits
# silently rather than risk a false match against the raw JSON payload.

command -v jq >/dev/null 2>&1 || exit 0
cmd="$(jq -r '.tool_input.command // empty' 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# `git commit` as the invoked subcommand: at start of the command or after a
# shell separator (; && || |), then `git`, then optional global flags
# (including -C <path> / -c <key=val> which take a value), then `commit`
# bounded so `commit-tree`/`commitfoo` and `config commit.*` don't match.
GIT_COMMIT_RE='(^[[:space:]]*|[;&|][[:space:]]*)git[[:space:]]+((-C|-c)[[:space:]]+[^[:space:]]+[[:space:]]+|-[^[:space:]]+[[:space:]]+)*commit([^[:alnum:]_-]|$)'
printf '%s\n' "$cmd" | grep -Eq "$GIT_COMMIT_RE" || exit 0

read -r -d '' NUDGE <<'EOF'
A git commit just landed. Before continuing, check whether this work established any DURABLE facts not already in memory: a decision, preference, correction, or stable property of the user, a project, or this machine. For each one, recall to confirm it is new or changed, then call mcp__memharness__remember (one atomic assertion per call), or revise if it contradicts an existing belief; set source_ref and basis. Skip transient task state, secrets, and anything an agent could reconstruct from the repo. If nothing durable landed, do nothing.
EOF

jq -n --arg c "$NUDGE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
