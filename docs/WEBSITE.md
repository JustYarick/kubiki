# Project website

The React landing page lives in the root `website/` directory, independently of
Kubiki's desktop frontend. Vite builds its HTML, JavaScript, CSS, bundled fonts
and referenced product logos, WebP screenshots and WebM/MP4 recordings into
`dist/website/`. It reuses the React, TypeScript and Vite dependencies pinned by
the root package and lockfile. Documentation links point to the canonical README
and topic guides. English matches the repository's usage guides. There is no
application backend or analytics.

## Experience and downloads

The deep JetBrains graphite landing page (`#121316`–`#1e1f22` matching Kubiki's
desktop shell) aligns every section to one unified `1280px` grid and includes:

- A Hero (`HeroSection`) with an animated sweeping beam backdrop (`beam-background`),
  blur-up typography, platform-aware primary CTA, and a full-width `1280px`
  demo cluster recording (`overview.webm`/`.mp4`) with a full-screen walkthrough
  modal across all six scenes.
- An asymmetric 2:1 / 1:2 diagnostics bento grid (`DiagnosticsBento`) mirroring
  Kubiki's real Cluster Overview (`Summary`, `Compute & memory`, `Pod distribution`),
  `OverviewProblems` severity filter, `LogsSessionPane` severity-stripped and
  structured JSON logs, and Pod `ResourceDetails` inspector (`ProblemsBanner`,
  `Pod summary`, `Related`, `Events`).
- A uniform 3×3 resource capability grid, crosshair architecture quote, and a
  full-width interactive workspace explorer (`ConnectedSection`) switching across
  all six recorded scenes (`Overview`, `Diagnostics`, `Topology`, `YAML Splits`,
  `Helm`, `AI Agent`).
- An interactive resource, Environment/Secret drift and YAML diff workbench
  (`IssuesSection`), a borderless animated Kubiki Topology/MCP flow with
  interactive `Plan · Read-Only`, `Action · Ask`, and `Action · Auto Accept`
  policy modes (`InfrastructureSection`), an FAQ accordion (`FaqSection`), and
  a cluster topology constellation download finale (`DownloadFinale`).

All screenshots and video clips use Kubiki's built-in demo cluster (`?demo=1`);
inline terminal/timeline/env cards are explanatory UI demonstrations.
Reduced-motion preferences disable scroll/entrance transforms, pause topology
and MCP pulse animations, and default the hero stage to static WebP posters until
played.

On page load, the browser requests GitHub's public latest-release API, validates
a published stable tag and selects only desktop installer assets. It excludes CLI
binaries, signatures and updater archives. Links use the actual asset URLs from
that release; no version or filename is guessed. The primary button downloads the
matched installer on user action, never automatically on page load. Release updates
do not require a website rebuild; refresh the page to recheck the latest release.

OS and architecture detection is best effort, with local browser Client Hints where
available. When architecture is unknown or after switching operating systems
(including macOS browsers that report Intel on Apple Silicon), the recommended
quick button waits for an explicit architecture choice while the Get Kubiki
panel immediately lists every available architecture for the chosen OS.
Mobile/unknown platforms get a desktop OS chooser, and users can filter or
override OS and architecture at any time. macOS prefers DMG, Windows EXE and
Linux AppImage; the panel also lists available MSI, DEB and RPM alternatives.
Unavailable architectures are never substituted.

If GitHub is unavailable, rate-limited or does not respond within eight seconds,
the page retains a link to GitHub Releases. No access token or server is required;
the browser contacts GitHub directly to retrieve public release metadata.

Media assets use versioned WebM/MP4 loops paired with 960px and full-resolution
WebP posters in `website/media/`. Regenerate all recordings and posters directly
from the demo cluster:

```sh
# Requires Playwright Chromium, FFmpeg and ImageMagick locally; not required in CI.
pnpm website:media
```

Commit the updated `website/media/` assets with website media changes.

## Build and preview

From the repository root, using Node.js 24 and the pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm website:dev
```

Open the local URL printed by Vite. To check and preview the production output:

```sh
pnpm website:build
python3 -m http.server 18741 --directory dist/website
```

Open `http://localhost:18741`. `website:build` runs the website's isolated TypeScript
check, then `scripts/build-website.mjs` invokes its Vite configuration and adds
`.nojekyll`. The build replaces only `dist/website/`. Relative asset URLs work under
a repository subpath such as `/kubiki/`. No desktop or extension build is required.

## Publish and recover

The [Pages workflow](../.github/workflows/pages.yml) runs on relevant pushes to
`main`, or on manual workflow dispatch. It installs locked dependencies, checks
and builds the React website, then on `main`:

1. Commits the contents of `dist/website/` to the dedicated `gh-pages` branch using
   [actions-gh-pages](https://github.com/peaceiris/actions-gh-pages). Only compiled
   website files belong in that branch; old generated files are replaced.
2. Uploads the same output as a Pages artifact and deploys it through Pages Actions.

Source files stay in `website/` on the development/main branches. Generated files
are ignored there; `gh-pages` preserves the published build history. Do not edit
that branch manually: the next publication replaces its contents.

In **Settings → Pages**, select **GitHub Actions** as the publishing source. The
explicit deployment step is necessary because pushes made with `GITHUB_TOKEN`
do not themselves trigger a branch-based Pages build. See
[GitHub's publishing-source documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).
No personal access token is required. The build/publish job has `contents: write`
for the generated branch; the deployment job has only `pages: write` and
`id-token: write`. Repository rules must
allow Actions to update `gh-pages`. Manual runs on other branches build an artifact
but do not update `gh-pages` or deploy.

Use the deployment URL reported by GitHub Actions as the published address;
local files do not establish a live deployment. No custom domain is configured.
Publication requires these files on `main`, Pages enabled, and any environment
approvals required by the repository's `github-pages` settings.

To recover, revert the affected website, dependencies, builder or workflow change
on `main` and rerun the workflow. It creates another generated-branch commit and
redeploys the rebuilt output. A successful branch push followed by failed deployment
can temporarily leave `gh-pages` ahead of the live site; rerun the workflow to
publish the matching output. Desktop releases are independent.
Check the deployed assets, navigation, mobile layout and download links after
publication. Product screenshots use demo data, never private cluster data.
