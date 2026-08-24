# Standing rules for coding-agent tasks

This file is the standing template appended to every task prompt given
to the coding agent in this repo. When a prompt says "follow
AGENT_PROMPT_TEMPLATE.md", every block below applies in addition to whatever
the prompt itself describes.

## Branch & Git Policy

- Create a new branch for this work. Never commit directly to `main`, never
  merge into `main` yourself — merging is always done manually, by a human,
  via the GitHub web UI.
- Always create that new branch from a freshly-fetched `origin/main` —
  never from another local branch, a leftover feature branch, or any other
  starting point, even if it looks like it has the same code. PRs in this
  repo are squash-merged, which means a source branch's original commits
  are never ancestors of `main` even after that PR merges — only the single
  squash commit is. If you branch off an old feature branch instead of
  fresh `origin/main`, git will show that old branch's already-merged
  commits as "new" changes in your PR, because they genuinely aren't in
  `main`'s ancestry. Run `git fetch origin` and branch from `origin/main`
  every time, regardless of what else you have checked out locally.
- Push the branch and open a PR against `main` when done.
- Never touch repository/branch-protection/ruleset/Actions settings — those
  are manual, human-only changes.

## Verify Against Current Code, Not This Prompt

Before making any change, read the actual current state of the relevant
file(s) yourself. Do not rely on line numbers, function signatures, code
snippets, or file contents described in the task prompt, on CLAUDE.md/README,
on your own memory of this codebase from earlier sessions, or on assumptions
about what "should" be there. Anything in a task prompt describing existing
code is a best-effort pointer telling you where to go look — not ground
truth. It may be stale, approximate, or simply wrong by the time you read it
(things get merged between when a prompt is written and when you run it). If
what you find in the actual code differs from what the prompt describes,
trust what you see in the repository, adjust your approach accordingly, and
mention the discrepancy in your final report rather than silently working
around it or forcing the prompt's description to match.

## Scope Discipline

- Only touch what the task prompt explicitly asks for. If you notice
  something else worth changing nearby, don't do it — report it instead.
- If you find an actual bug unrelated to the current task, report it in your
  final report; don't fix it as a drive-by.

## CI / Ruleset Name Consistency (when a task touches CI job names)

`main`'s branch ruleset requires specific status-check names to pass before a
PR can merge. GitHub only appends a matrix-value suffix (e.g.
"(ubuntu-22.04)") to a job's reported name when that job actually runs as
part of a `strategy.matrix` — a plain, non-matrix job reports under its bare
`name:` with no suffix. If you rename, split, or otherwise change what name a
CI job reports under, that name must stay in sync with what's configured as a
required check in the ruleset, or every future PR will be permanently
blocked with no way to satisfy the check. You cannot fix a ruleset mismatch
yourself (ruleset settings are off-limits, see Branch & Git Policy) — if you
introduce or discover one, call it out explicitly and clearly in your report
so it can be fixed manually by a human.

## Limit Awareness

If you're running low on context/usage limits before a task is fully done,
do not leave the branch in a half-working or unclear state. Stop, make sure
whatever you've changed is in a safe/committed state (or explicitly note
what's uncommitted and why), and write a clear summary covering: (1) what's
fully done and verified, (2) what's in progress and what's left to finish
it, (3) what hasn't been started at all, (4) any gotchas you hit or
decisions you made that whoever continues should know about. Post this as
the PR description (a draft/WIP PR is fine) or as your final message if you
haven't opened a PR yet — never just stop silently or leave a broken build
with no explanation.

## Wait for CI Before Reporting

After pushing your branch and opening (or updating) the PR, do not write
your final report yet. Wait for every GitHub Actions check on that PR to
actually finish running — a local `npm test` / local build passing is
necessary but not sufficient, since CI runs on clean checkouts, on
different platforms, and can surface things a local run doesn't (a
forgotten file, something that only breaks on a clean checkout, a
platform-specific failure). Poll or otherwise check the PR's status until
every check has completed, not just started.

If any check fails: investigate and fix it, push the fix, and wait for CI
to finish again. Repeat until every check is green — or until you hit a
Limit Awareness situation, in which case follow that section instead and
say plainly in your report that CI was still pending/failing when you
stopped.

Only write your final report once you can report CI's real, current
result — never assume, guess, or extrapolate from local results what CI
"should" say.

## Final Report Requirements

Regardless of whether the task fully succeeded, always end with a complete
report — written only after CI has actually finished, per "Wait for CI
Before Reporting" above. Don't just say "done, all green" — explicitly
include:

- What you actually implemented (and, per "Verify Against Current Code,"
  whether what you found in the codebase matched what the prompt described).
- Full verification results: test output, build results for both release
  and debug.
- Any unexpected findings or surprises you hit along the way — bugs,
  discrepancies from the prompt's description, design decisions you had to
  make that the prompt didn't fully specify, anything that took more
  investigation than expected — even things you handled fine on your own.
  These are easy to lose track of across a long sequence of tasks and are
  often more valuable than the "it worked" summary.
- Anything worth flagging for whoever picks up the next task in a sequence.

## Verification (standard, unless the task prompt overrides it)

- Run `npm test` and confirm ALL tests pass — new and every existing suite,
  not just the ones this task added.
- Build BOTH release and debug (per CLAUDE.md's build commands) and confirm
  both succeed before reporting done.
