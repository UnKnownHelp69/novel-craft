# Releasing NovelCraft

How to turn the current state of `main` into a downloadable release. The build side is
automated by [`.github/workflows/release.yml`](.github/workflows/release.yml); this
document covers the decisions around it — when to release, what to call it, and what to
check before pressing publish.

## When to release

There is no schedule, and a release is *not* the natural end of every merged PR. Most
PRs should just sit on `main` and accumulate.

Cut a release when either of these is true:

- The app is **meaningfully better** than the last released version — enough fixes or
  new features have piled up that someone downloading it would notice the difference.
- You want the **current state of `main` to be the official download**, regardless of
  how much changed. For example, after a fix for a bug that people are actually hitting.

Batching is the normal case. Five merged PRs and one release is healthy; five releases
in an afternoon is noise for anyone watching the repo.

## Choosing the version number

Versions are `MAJOR.MINOR.PATCH` ([SemVer](https://semver.org/)):

| Bump      | When                                                    | Example         |
| --------- | ------------------------------------------------------- | --------------- |
| **PATCH** | Bug fixes only — nothing new to discover.               | `1.2.0 → 1.2.1` |
| **MINOR** | At least one new feature, everything old still works.   | `1.2.1 → 1.3.0` |
| **MAJOR** | Breaking changes.                                       | `1.3.0 → 2.0.0` |

MAJOR should be rare here. `migrateNovel()` in `src/app.js` exists specifically so that
older `.novel` files keep opening in newer builds — as long as that holds, a release
isn't breaking, however large it is.

**When a release batches several PRs, bump once, by the highest category present.** One
new feature plus four bug fixes is a single MINOR bump — not a MINOR *and* a PATCH, and
certainly not five releases. The version describes the whole batch.

## Cutting the release

### 1. Bump the version

The version lives in two files and both must agree:

- `src-tauri/tauri.conf.json` → `"version"` (this is the one the installers use)
- `package.json` → `"version"`

Change them on a branch and merge through the usual PR flow. Never commit straight to
`main` — a repository ruleset blocks it anyway.

The release workflow **reads** the version and refuses to run if the tag doesn't match
`tauri.conf.json`; it deliberately never rewrites it for you, so the bump stays a
reviewable commit rather than something CI does behind your back.

### 2. Trigger the build — pick exactly one path

**Either** push a tag matching the version you just merged:

```bash
git checkout main && git pull
git tag v1.3.0
git push origin v1.3.0
```

**Or** open the repo's **Actions** tab → **Release** → **Run workflow**, optionally
typing the version (leave it blank to use whatever is in `tauri.conf.json`).

> ⚠️ **Do not do both for the same version.** The two triggers are independent, so using
> both starts two complete pipeline runs and you end up with **two duplicate draft
> releases under the same tag** — which has already happened once. Nothing in the
> workflow currently detects or prevents this; it is on whoever is releasing to use one
> path per version. If you do slip up, delete the extra draft from the Releases page
> before publishing.

### 3. Wait for the builds

Three platform jobs run in parallel — Linux, Windows and macOS — a few minutes each,
so roughly ten minutes end to end. A fast version-check job runs first and fails within
a minute if the version doesn't line up, before burning any build time.

When they finish, a **draft** release appears on the repo's Releases page carrying:

- **Windows** — `.msi` and `-setup.exe` (NSIS)
- **macOS** — a single universal `.dmg` (Apple Silicon and Intel)
- **Linux** — `.AppImage`, `.deb` and `.rpm`

The release is **always a draft**. Nothing is ever published automatically; the draft is
invisible to everyone but repo collaborators until you say so.

### 4. Review and publish

Open the draft and click **Edit**:

- Optionally hit **Generate release notes** — GitHub writes a summary of the PRs merged
  since the previous release, which you can then trim into something readable.
- Decide whether to tick **Set as a pre-release**. This is independent of the version
  number: it is a separate signal to downloaders that the build may still be rough, and
  a plain `1.3.0` can perfectly well go out as a pre-release.
- Sanity-check that all the expected installers are attached — if a platform job failed,
  its artifacts are simply missing rather than the release failing loudly.
- Click **Publish release**.

## Two things to expect (not bugs)

**The builds are unsigned.** No code-signing certificate is set up yet, so on first
launch Windows SmartScreen shows a warning (choose *More info* → *Run anyway*) and macOS
Gatekeeper refuses a double-click (right-click the app → *Open*). This is worth
mentioning in the release notes so downloaders aren't spooked. It goes away once code
signing and notarization are set up, which is a separate project.

**There is no auto-updater.** The app doesn't check for or install new versions. Every
release requires users to download and reinstall from the Releases page manually. That's
the current design, not something broken.
