import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEV_FEED_TAG, publishDevUpdateFeed } from '../../scripts/dev-update-feed.mjs';
import { reconcileUpdateManifest } from '../../scripts/desktop-release.mjs';

function fixture(tag = 'v1.0.0-dev.10') {
  const packages = ['kubiki.AppImage', 'kubiki-setup.exe', 'kubiki_aarch64.app.tar.gz', 'kubiki_x64.app.tar.gz'];
  const assets = packages.flatMap(name => [{ name, size: 1000 }, { name: `${name}.sig`, size: 100 }]);
  const signatures = Object.fromEntries(packages.map(name => [`${name}.sig`, `signature-${name}`]));
  return { tag, sha: 'a'.repeat(40), assets, manifest: reconcileUpdateManifest(null, tag, assets, signatures) };
}

function mock({ floor, failUpload = false, prerelease = true, invalidBody = false } = {}) {
  let feed = floor ? { id: 1, draft: false, prerelease,
    body: invalidBody ? 'Unexpected content' : `<!-- kubiki-dev-version: ${floor} -->` } : undefined;
  let assets = floor ? [{ id: 10, name: 'latest.json', size: 100 }] : [];
  let failed = false;
  const writes = [];
  const github = {
    rest: { repos: {
      getReleaseByTag: async ({ tag }) => {
        assert.equal(tag, DEV_FEED_TAG);
        if (!feed) throw Object.assign(new Error('Missing'), { status: 404 });
        return { data: feed };
      },
      createRelease: async options => { writes.push(options); feed = { id: 1, ...options }; return { data: feed }; },
      updateRelease: async options => { writes.push(options); feed = { ...feed, ...options }; return { data: feed }; },
      listReleaseAssets: 'list-assets',
      deleteReleaseAsset: async ({ asset_id }) => { writes.push('delete'); assets = assets.filter(a => a.id !== asset_id); },
      uploadReleaseAsset: async ({ name, data }) => {
        writes.push('upload');
        if (failUpload && !failed) { failed = true; throw new Error('Interrupted'); }
        const asset = { id: 11, name, size: data.length, data: Buffer.from(data) };
        assets.push(asset);
        return { data: asset };
      },
    } },
    paginate: async () => assets,
  };
  return { github, context: { repo: { owner: 'JustYarick', repo: 'kubiki' } }, core: { info() {} }, writes,
    state: () => ({ feed, assets }) };
}

test('a separate prerelease hosts only a validated manifest with immutable versioned package URLs', async () => {
  const api = mock(), build = fixture();
  await publishDevUpdateFeed(api, build);
  assert.equal(api.writes[0].tag_name, DEV_FEED_TAG);
  assert.equal(api.writes[0].draft, true);
  const { feed, assets } = api.state();
  assert.equal(feed.draft, false);
  assert.equal(feed.prerelease, true);
  assert.equal(feed.make_latest, 'false');
  assert.deepEqual(JSON.parse(assets[0].data), build.manifest);
  assert.equal(assets.length, 1);
});

test('older dev releases cannot move the feed backwards, including numeric and base-version ordering', async () => {
  for (const [floor, candidate] of [
    ['v1.0.0-dev.10', 'v1.0.0-dev.9'], ['v1.10.0-dev.1', 'v1.9.0-dev.99'],
    ['v1.0.0-dev.0', 'v1.0.0-dev'],
  ]) {
    const api = mock({ floor });
    await publishDevUpdateFeed(api, fixture(candidate));
    assert.deepEqual(api.writes, []);
  }
});

test('an interrupted replacement retains its version floor, rejects an older retry, and repairs the same version', async () => {
  const api = mock({ floor: 'v1.0.0-dev.9', failUpload: true });
  const build = fixture();
  await assert.rejects(publishDevUpdateFeed(api, build), /Interrupted/);
  assert.match(api.state().feed.body, /v1.0.0-dev.10/);
  const writes = api.writes.length;
  await publishDevUpdateFeed(api, fixture('v1.0.0-dev.9'));
  assert.equal(api.writes.length, writes);
  await publishDevUpdateFeed(api, build);
  assert.equal(JSON.parse(api.state().assets[0].data).version, '1.0.0-dev.10');
});

test('stable, rc, mixed-channel and incomplete manifests cannot change the dev feed', async () => {
  for (const tag of ['v1.0.0', 'v1.0.0-rc.1', 'v1.0.0-dev.1+build.2']) {
    const api = mock();
    await assert.rejects(publishDevUpdateFeed(api, fixture(tag)), /dev versions only/);
    assert.deepEqual(api.writes, []);
  }
  const api = mock(), build = fixture();
  delete build.manifest.platforms['darwin-aarch64'];
  await assert.rejects(publishDevUpdateFeed(api, build), /darwin-aarch64/);
  assert.deepEqual(api.writes, []);
});

test('an existing non-dev or unrecognized feed is not silently overwritten', async () => {
  for (const options of [{ prerelease: false }, { invalidBody: true }]) {
    const api = mock({ floor: 'v1.0.0-dev.9', ...options });
    await assert.rejects(publishDevUpdateFeed(api, fixture()), /prerelease|version marker/);
    assert.deepEqual(api.writes, []);
  }
});
