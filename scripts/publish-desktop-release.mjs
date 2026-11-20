import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopRelease, reconcileUpdateManifest, updateChannel, validateUpdateManifest } from './desktop-release.mjs';
import { compareStableTags, verifyDesktopArtifacts } from './desktop-pipeline.mjs';
import { publishDevUpdateFeed } from './dev-update-feed.mjs';
import { formatReleaseNotes, formatUpdaterNotes, promoteUnreleasedChangelog, readChangelog } from './release-notes.mjs';

function verifyUploadedArtifacts(assets, uploaded) {
  for (const asset of assets) {
    if (!uploaded.some(a => a.name === asset.name && a.size === asset.size)) throw new Error(`Incomplete uploaded asset: ${asset.name}`);
  }
}

function isMainBranchCommit(sha, ref, tag) {
  if (ref === 'refs/heads/main') return true;
  if (ref !== `refs/tags/${tag}`) return false;
  for (const candidate of ['refs/remotes/origin/main^{commit}', 'refs/heads/main^{commit}']) {
    try {
      const mainSha = execFileSync('git', ['rev-parse', '--verify', candidate], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (mainSha === sha) return true;
    } catch { /* ref not fetched locally */ }
  }
  return false;
}

/** Only the final job writes release assets and latest.json. */
export async function publishDesktopRelease({ github, context, core }, { tag, sha, dir, root = process.cwd(), ref = context?.ref }) {
  const release = desktopRelease(tag);
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const allowMainUnreleasedFallback = updateChannel(tag) === 'stable' && isMainBranchCommit(sha, ref, tag);
  const changelog = await readChangelog(root);
  const promoted = changelog && allowMainUnreleasedFallback ? promoteUnreleasedChangelog(changelog, tag) : null;
  const effectiveChangelog = promoted ? promoted.changelog : changelog;
  const releaseBody = effectiveChangelog ? formatReleaseNotes(effectiveChangelog, tag) : null;
  const updaterNotes = effectiveChangelog ? formatUpdaterNotes(effectiveChangelog, tag) : null;
  const assets = await verifyDesktopArtifacts(dir, tag, sha);
  const releaseAssets = [...assets];
  const signatures = {};
  for (const asset of assets.filter(a => a.name.endsWith('.sig'))) {
    signatures[asset.name] = await readFile(path.join(dir, asset.name), 'utf8');
  }
  const manifest = reconcileUpdateManifest(updaterNotes ? { notes: updaterNotes } : null, tag, assets, signatures);
  validateUpdateManifest(manifest, tag, assets);

  // Peel annotated tags too; never attach packages to another commit.
  let taggedSha;
  try { taggedSha = execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { /* A new tag is created only after validation succeeds. */ }
  if (taggedSha && taggedSha !== sha) throw new Error(`${tag} points to ${taggedSha}, expected ${sha}`);
  if (!taggedSha) await github.rest.git.createRef({ ...repo, ref: `refs/tags/${tag}`, sha });

  let draft;
  try { draft = (await github.rest.repos.getReleaseByTag({ ...repo, tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  if (draft && !draft.draft) {
    if (updateChannel(tag) !== 'dev') throw new Error(`${tag} is already published. Choose a new version.`);
    // Re-running a publish job after feed promotion failed must repair the feed
    // without changing the already published installers or their signatures.
    const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: draft.id, per_page: 100 });
    verifyUploadedArtifacts(releaseAssets, uploaded);
    const asset = uploaded.find(asset => asset.name === 'latest.json' && asset.size > 0);
    if (!asset) throw new Error('The published dev release has no update manifest.');
    const { data } = await github.rest.repos.getReleaseAsset({ ...repo, asset_id: asset.id,
      headers: { accept: 'application/octet-stream' },
    });
    // Octokit may return JSON directly or the downloaded bytes, depending on
    // the response content type. Use the published signatures on repair.
    let contents = data;
    if (contents instanceof ArrayBuffer) contents = Buffer.from(contents);
    if (ArrayBuffer.isView(contents)) {
      contents = Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength).toString('utf8');
    }
    const publishedManifest = typeof contents === 'string' ? JSON.parse(contents) : contents;
    validateUpdateManifest(publishedManifest, tag, uploaded);
    await publishDevUpdateFeed({ github, context, core }, { tag, sha, manifest: publishedManifest, assets: uploaded });
    return;
  }
  if (!draft) {
    draft = (await github.rest.repos.createRelease({
      ...repo, tag_name: tag, target_commitish: sha, name: `Kubiki ${tag}`,
      draft: true, prerelease: release.prerelease, make_latest: 'false',
      ...(releaseBody ? { body: releaseBody, generate_release_notes: false } : { generate_release_notes: true }),
    })).data;
  }
  const release_id = draft.id;
  // Retries replace an unpublished draft; there is no artifact skip heuristic.
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id, per_page: 100 });
  for (const asset of existing) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
  for (const asset of releaseAssets) {
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id, name: asset.name, data: await readFile(path.join(dir, asset.name)) });
  }
  const sums = releaseAssets.map(a => `${a.sha256}  ${a.name}`).join('\n') + '\n';
  for (const [name, contents] of [['SHA256SUMS', sums], ['latest.json', JSON.stringify(manifest, null, 2) + '\n']]) {
    await github.rest.repos.uploadReleaseAsset({ ...repo, release_id, name, data: Buffer.from(contents) });
  }
  const uploaded = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id, per_page: 100 });
  verifyUploadedArtifacts(releaseAssets, uploaded);
  validateUpdateManifest(manifest, tag, uploaded);

  let makeLatest = !release.prerelease;
  if (makeLatest) {
    try {
      const latest = (await github.rest.repos.getLatestRelease(repo)).data;
      if (!desktopRelease(latest.tag_name).prerelease && compareStableTags(tag, latest.tag_name) <= 0) makeLatest = false;
    } catch (error) { if (error.status !== 404) throw error; }
  }
  const published = (await github.rest.repos.updateRelease({ ...repo, release_id,
    draft: false, prerelease: release.prerelease, make_latest: makeLatest ? 'true' : 'false',
    ...(releaseBody ? { body: releaseBody } : {}),
  })).data;
  core.info(`Published ${tag}: ${published.html_url}`);
  let promotedOnMain = false;
  if (promoted && github.rest.repos.getContent && github.rest.repos.createOrUpdateFileContents) {
    try {
      const { data: currentFile } = await github.rest.repos.getContent({ ...repo, path: 'docs/CHANGELOG.md', ref: 'main' });
      if (!Array.isArray(currentFile) && currentFile.type === 'file' && typeof currentFile.content === 'string') {
        const currentText = Buffer.from(currentFile.content, 'base64').toString('utf8');
        const nextChangelog = promoteUnreleasedChangelog(currentText, tag);
        if (nextChangelog) {
          await github.rest.repos.createOrUpdateFileContents({
            ...repo,
            path: 'docs/CHANGELOG.md',
            branch: 'main',
            message: `docs(changelog): promote Unreleased to ${tag}`,
            content: Buffer.from(nextChangelog.changelog, 'utf8').toString('base64'),
            sha: currentFile.sha,
          });
          promotedOnMain = true;
          core.info(`Promoted Unreleased entries in docs/CHANGELOG.md to ${tag} on main.`);
        }
      }
    } catch (error) {
      const warn = typeof core.warning === 'function' ? core.warning.bind(core) : core.info.bind(core);
      warn(`Published ${tag}, but could not update docs/CHANGELOG.md on main automatically: ${error?.message ?? error}`);
    }
  }
  if (updateChannel(tag) === 'dev') {
    await publishDevUpdateFeed({ github, context, core }, { tag, sha, manifest, assets: uploaded });
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const changelogNote = promotedOnMain ? `\n\nAutomatically promoted \`## [Unreleased]\` to \`## [${release.version}]\` in \`docs/CHANGELOG.md\` on \`main\`.` : '';
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Published Kubiki ${tag}\n\n${published.html_url}\n\nCommit: \`${sha}\`\n\n${assets.length} verified packages/signatures, SHA256SUMS and latest.json uploaded; the VirusTotal report is optional and published separately.${changelogNote}\n`);
  }
}
