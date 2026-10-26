import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { desktopRelease, reconcileUpdateManifest, updateChannel, validateUpdateManifest } from './desktop-release.mjs';
import { compareStableTags, verifyDesktopArtifacts } from './desktop-pipeline.mjs';
import { publishDevUpdateFeed } from './dev-update-feed.mjs';

function verifyUploadedArtifacts(assets, uploaded) {
  for (const asset of assets) {
    if (!uploaded.some(a => a.name === asset.name && a.size === asset.size)) throw new Error(`Incomplete uploaded asset: ${asset.name}`);
  }
}

/** Only the final job writes release assets and latest.json. */
export async function publishDesktopRelease({ github, context, core }, { tag, sha, dir }) {
  const release = desktopRelease(tag);
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const assets = await verifyDesktopArtifacts(dir, tag, sha);
  const releaseAssets = [...assets];
  const signatures = {};
  for (const asset of assets.filter(a => a.name.endsWith('.sig'))) {
    signatures[asset.name] = await readFile(path.join(dir, asset.name), 'utf8');
  }
  const manifest = reconcileUpdateManifest(null, tag, assets, signatures);
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
      draft: true, prerelease: release.prerelease, make_latest: 'false', generate_release_notes: true,
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
  })).data;
  core.info(`Published ${tag}: ${published.html_url}`);
  if (updateChannel(tag) === 'dev') {
    await publishDevUpdateFeed({ github, context, core }, { tag, sha, manifest, assets: uploaded });
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Published Kubiki ${tag}\n\n${published.html_url}\n\nCommit: \`${sha}\`\n\n${assets.length} verified packages/signatures, SHA256SUMS and latest.json uploaded; the VirusTotal report is optional and published separately.\n`);
  }
}
