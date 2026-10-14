# Releasing NovelCraft

The builds are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml),
which only ever produces a **draft** release. This file covers what the workflow doesn't decide
for you, and the parts of it that are easy to get wrong.

## When to release

Not after every merged PR. Release when `main` is noticeably better than the last release, or when
a fix for a bug people are actually hitting should become the official download. Several PRs per
release is the normal case.

## Choosing the version number

[SemVer](https://semver.org/), bumped **once per release, by the largest change in the batch**: one
new feature plus four fixes is a single MINOR bump.

| Bump      | When                                                  | Example         |
| --------- | ----------------------------------------------------- | --------------- |
| **PATCH** | Bug fixes only.                                       | `1.2.0 → 1.2.1` |
| **MINOR** | At least one new feature; everything old still works. | `1.2.1 → 1.3.0` |
| **MAJOR** | Breaking changes.                                     | `1.3.0 → 2.0.0` |

MAJOR should be rare: `migrateNovel()` in `src/app.js` keeps older `.novel` files opening in newer
builds, and as long as that holds a release isn't breaking, however large it is.

## Checklist

### 1. Bump the version (in a PR)

- `src-tauri/tauri.conf.json` → `"version"`. **This is the one that counts**: the installers are
  named after it and the workflow refuses to run if it doesn't match the requested version.
- `package.json` → `"version"`. Nothing reads or checks it; keep it in step anyway.
- `src-tauri/Cargo.toml` also has a version. The installers don't use it and nothing checks it.

Merge through the usual PR flow (`main` is protected by a ruleset). The workflow never edits the
version itself, so the bump stays a reviewed commit.

### 2. Trigger the build — exactly one of these

**A. Push a tag** on the merged bump commit:

```bash
git checkout main && git pull
git tag v1.3.0
git push origin v1.3.0
```

The version check runs against `tauri.conf.json` *at the tagged commit*, so tagging a commit from
before the bump fails within a minute.

**B. Actions → Release → Run workflow**, with **Use workflow from: `main`**. The version field is
optional (empty means "whatever `tauri.conf.json` says"). The jobs check out and build the branch
picked there, so starting the run from another branch ships that branch's code.

> **Never use both for the same version.** The two runs are not serialized (a tag run and a branch
> run fall into different concurrency groups), so both build, and you get **two drafts under the
> same tag** — this has happened before. If it does, delete one draft before publishing.

Two things the workflow does *not* check: that the version is new (on path B with no bump, it
simply builds the version that is already released, under that version's tag), and that the tests
pass — none run here; the release relies on CI having passed on the PRs that reached `main`.

### 3. What the workflow does

1. **Verify version** (seconds): resolves the version from the tag, the input or `tauri.conf.json`
   and fails on a mismatch before any build starts.
2. **Build installers** — three jobs in parallel, with `fail-fast` off:
   - Linux (`ubuntu-22.04`): `.AppImage`, `.deb`, `.rpm`
   - Windows: `.msi`, `-setup.exe` (NSIS)
   - macOS: one universal `.dmg` (Apple Silicon + Intel; the slowest job, since the Rust code is
     compiled for both architectures)

   Each job uploads its files to the draft release `NovelCraft vX.Y.Z`; whichever finishes first
   creates the draft, the others add to it. A job that fails just leaves its installers missing —
   the other platforms still upload. Use **Re-run failed jobs** to fill the gap.

A second run for the same ref queues behind the first instead of cancelling it (a half-uploaded
draft is worse than a slow one).

### 4. Review and publish

On the Releases page, open the draft → **Edit**:

- [ ] Every installer listed in step 3 is attached.
- [ ] Release notes: the draft comes with a short preset text (which installer to pick, and how to
      get past the unsigned-build warnings — keep that part). **Generate release notes** adds the
      list of PRs merged since the previous release; trim it to something readable.
- [ ] **Set as a pre-release** if the build may still be rough. This is independent of the version
      number.
- [ ] **Publish release.** Until then only collaborators can see the draft.

## Known limitations (not bugs)

- **Unsigned builds.** No code-signing certificate or notarization is set up, so Windows SmartScreen
  warns on first launch (*More info → Run anyway*) and macOS Gatekeeper refuses a double-click
  (right-click the app → *Open*). Fixing this means adding signing secrets and the matching
  `tauri-action` settings — a separate project.
- **No auto-updater.** The app never checks for new versions and the workflow publishes no updater
  manifest (`uploadUpdaterJson: false`); users download each release by hand.
