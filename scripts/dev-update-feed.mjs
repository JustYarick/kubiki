import { compareDevTags, updateChannel, validateUpdateManifest } from './desktop-release.mjs';

export const DEV_FEED_TAG = 'updates-dev';

function feedBody(tag) {
  return `Development update feed for Kubiki. Packages remain attached to their versioned releases.\n\n` +
    `Current release: [${tag}](https://github.com/JustYarick/kubiki/releases/tag/${tag}).\n\n` +
    `<!-- kubiki-dev-version: ${tag} -->\n`;
}

/** Advance only after the versioned release is published. The workflow serializes
 * publication. Record the version floor before replacing the asset, so even an
 * interrupted upload cannot let a later retry of an older build roll it back. */
export async function publishDevUpdateFeed({ github, context, core }, { tag, sha, manifest, assets }) {
  if (updateChannel(tag) !== 'dev') throw new Error('The dev update feed accepts dev versions only.');
  validateUpdateManifest(manifest, tag, assets);
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  let feed;
  try { feed = (await github.rest.repos.getReleaseByTag({ ...repo, tag: DEV_FEED_TAG })).data; }
  catch (error) { if (error.status !== 404) throw error; }

  if (feed) {
    if (!feed.prerelease) throw new Error('The dev update feed must remain a prerelease.');
    const floor = /^<!-- kubiki-dev-version: (v[^\s]+) -->$/m.exec(feed.body ?? '')?.[1];
    if (!floor || updateChannel(floor) !== 'dev') throw new Error('The dev feed has no valid version marker; inspect it before publishing.');
    if (compareDevTags(tag, floor) < 0) {
      core.info(`Keeping newer dev update ${floor}; ${tag} remains available in its own release.`);
      return;
    }
    await github.rest.repos.updateRelease({ ...repo, release_id: feed.id,
      body: feedBody(tag), prerelease: true, make_latest: 'false',
    });
  } else {
    feed = (await github.rest.repos.createRelease({ ...repo,
      tag_name: DEV_FEED_TAG, target_commitish: sha, name: 'Kubiki dev update feed',
      body: feedBody(tag), draft: true, prerelease: true, make_latest: 'false',
    })).data;
  }

  const release_id = feed.id;
  const existing = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id, per_page: 100 });
  for (const asset of existing.filter(asset => asset.name === 'latest.json')) {
    await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: asset.id });
  }
  const data = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const uploaded = (await github.rest.repos.uploadReleaseAsset({ ...repo,
    release_id, name: 'latest.json', data,
  })).data;
  if (uploaded.size !== data.length) throw new Error('Incomplete dev update manifest upload. Retry the failed publish job.');
  await github.rest.repos.updateRelease({ ...repo, release_id,
    draft: false, prerelease: true, make_latest: 'false', body: feedBody(tag),
  });
  core.info(`Dev update feed now points to ${tag}.`);
}
