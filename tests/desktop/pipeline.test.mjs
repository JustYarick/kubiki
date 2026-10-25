import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DESKTOP_TARGETS, installerBundleConfig, nextReleaseTag, rpmBundleConfig, stageDesktopArtifacts, verifyDesktopArtifacts } from '../../scripts/desktop-pipeline.mjs';
import { prepareDesktopRelease } from '../../scripts/desktop-release.mjs';
import { publishDesktopRelease } from '../../scripts/publish-desktop-release.mjs';
import { parse } from 'yaml';

test('manual CI publishes by default and invokes the same pipeline as tag releases', async () => {
  const ci = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
  const release = parse(await readFile('.github/workflows/release.yml', 'utf8'));
  assert.equal(ci.on.workflow_dispatch.inputs.trigger_release.default, true);
  assert.equal(release.on.workflow_dispatch.inputs.publish.default, true);
  assert.equal(ci.jobs.pipeline.uses, './.github/workflows/release.yml');
  assert.equal(ci.jobs.pipeline.with.publish, "${{ github.event_name == 'workflow_dispatch' && inputs.trigger_release }}");
  assert.deepEqual(new Set(release.jobs.publish.needs), new Set(['prepare', 'frontend', 'interface', 'desktop']));
  assert.equal(release.jobs.publish.if, "needs.prepare.outputs.publish == 'true'");
  assert.deepEqual(new Set(release.jobs.desktop.strategy.matrix.include.map(t => t.target)), new Set(Object.keys(DESKTOP_TARGETS)));
  assert.equal(release.jobs.desktop.needs.includes('interface'), true);
});

test('version selection orders tags numerically and keeps branch previews out of stable', () => {
  const tags = ['v1.9.8', 'v1.10.0', 'v8.0.0-dev', 'invalid'];
  assert.equal(nextReleaseTag(tags, { branch: 'main', runNumber: 30 }), 'v1.10.1');
  assert.equal(nextReleaseTag(tags, { branch: 'dev', bump: 'minor', runNumber: 30 }), 'v1.11.0-dev.30');
  assert.equal(nextReleaseTag(tags, { branch: 'main', bump: 'major' }), 'v2.0.0');
  assert.equal(nextReleaseTag([], { branch: 'main' }), 'v0.1.1');
  assert.throws(() => nextReleaseTag(tags, { bump: 'oops' }), /Invalid bump/);
});

test('RPM uses a numeric Version and prerelease Release below stable, without changing SemVer', () => {
  for (const version of ['1.0.1-dev', '1.0.1-rc.1', '1.0.1-dev-test.4+build-2', '1.0.1+build.1']) {
    const config = rpmBundleConfig(version);
    assert.equal(config.version, '1.0.1');
    assert.match(config.bundle.linux.rpm.release, /^0\.[a-zA-Z0-9._+]+$/);
    assert.equal(config.bundle.createUpdaterArtifacts, false);
  }
  assert.equal(rpmBundleConfig('1.0.1').bundle.linux.rpm.release, '1');
});

test('MSI and macOS build versions accept dev, rc and build metadata; unsupported MSI ranges fail early', () => {
  for (const version of ['1.0.1', '1.0.1-dev', '1.0.1-rc.1', '1.0.1+build.5']) {
    const config = installerBundleConfig(version);
    assert.equal(config.bundle.windows.wix.version, '1.0.1');
    assert.equal(config.bundle.macOS.bundleVersion, '1.0.1');
  }
  for (const version of ['256.0.0', '1.256.0', '1.0.65536']) assert.throws(() => installerBundleConfig(version), /MSI version limits/);
});

test('build-only preparation needs no secrets and still embeds the preview version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kubiki-unsigned-'));
  try {
    await mkdir(path.join(root, 'src-tauri'));
    await writeFile(path.join(root, 'package.json'), '{"version":"0.1.0"}');
    await writeFile(path.join(root, 'src-tauri/tauri.conf.json'), '{"version":"0.1.0"}');
    await writeFile(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nversion = "0.1.0"\n');
    await writeFile(path.join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "kubiki"\nversion = "0.1.0"\n');
    await prepareDesktopRelease(root, 'v1.0.1-dev', {}, { signed: false });
    assert.equal(JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json'))).version, '1.0.1-dev');
    assert.equal(JSON.parse(await readFile(path.join(root, '.kubiki-build/updater.conf.json'))).bundle.createUpdaterArtifacts, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function artifacts(tag = 'v9876.1.0-rc.1') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kubiki-pipeline-'));
  const sha = 'a'.repeat(40);
  const packages = {
    'x86_64-unknown-linux-gnu': { deb: 'kubiki.deb', rpm: 'kubiki.rpm', appimage: 'kubiki.AppImage' },
    'aarch64-apple-darwin': { dmg: 'kubiki_arm64.dmg', macos: 'kubiki.app.tar.gz' },
    'x86_64-apple-darwin': { dmg: 'kubiki_x64.dmg', macos: 'kubiki.app.tar.gz' },
    'x86_64-pc-windows-msvc': { nsis: 'kubiki_x64-setup.exe', msi: 'kubiki.msi' },
  };
  for (const [target, bundles] of Object.entries(packages)) {
    for (const [kind, name] of Object.entries(bundles)) {
      const dir = path.join(root, 'src-tauri/target', target, 'release/bundle', kind);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, name), `package for ${target}`);
      await writeFile(path.join(dir, `${name}.sig`), `signature for ${target}`);
    }
    const cli = path.join(root, 'crates/kubiki-core/target', target, 'release');
    await mkdir(cli, { recursive: true });
    await writeFile(path.join(cli, target.includes('windows') ? 'kubiki-cli.exe' : 'kubiki-cli'), 'CLI');
    await stageDesktopArtifacts(root, target, { tag, sha, signed: true });
  }
  return { root, dir: path.join(root, '.kubiki-build/artifacts'), tag, sha };
}

function githubMock({ exists = true, draft = true, latest = 'v1.0.0', failUpload = false } = {}) {
  let assets = [{ id: 1, name: 'stale-package', size: 100 }];
  let fail = failUpload;
  const events = [];
  const github = {
    rest: { git: { createRef: async () => events.push('tag') }, repos: {
      getReleaseByTag: async () => {
        if (!exists) throw Object.assign(new Error('Not found'), { status: 404 });
        return { data: { id: 123, draft } };
      },
      createRelease: async options => {
        if (exists) throw new Error('Existing draft should be reused');
        events.push('create-draft');
        assert.equal(options.draft, true);
        assert.equal(options.target_commitish, 'a'.repeat(40));
        return { data: { id: 123, draft: true } };
      },
      listReleaseAssets: 'list-assets',
      deleteReleaseAsset: async ({ asset_id }) => { events.push('delete'); assets = assets.filter(a => a.id !== asset_id); },
      uploadReleaseAsset: async ({ name, data }) => {
        events.push(name);
        if (fail) { fail = false; throw new Error('Upload interrupted'); }
        assets.push({ id: assets.length + 100, name, size: data.length });
      },
      getLatestRelease: async () => ({ data: { tag_name: latest } }),
      updateRelease: async options => { events.push(options); return { data: { html_url: 'https://example.test/release' } }; },
    } },
    paginate: async () => assets,
  };
  return { github, context: { repo: { owner: 'JustYarick', repo: 'kubiki' } }, core: { info() {} }, events };
}

test('publication rejects incomplete, corrupted or mixed-commit artifacts before any GitHub write', async () => {
  const fixture = await artifacts();
  try {
    const assets = await verifyDesktopArtifacts(fixture.dir, fixture.tag, fixture.sha);
    assert.ok(assets.some(a => a.name === 'kubiki_aarch64.app.tar.gz'));
    assert.ok(assets.some(a => a.name === 'kubiki_x64.app.tar.gz'));
    await assert.rejects(verifyDesktopArtifacts(fixture.dir, fixture.tag, 'b'.repeat(40)), /provenance/);
    const recordPath = path.join(fixture.dir, 'build-x86_64-pc-windows-msvc.json');
    const original = await readFile(recordPath, 'utf8');
    const incomplete = JSON.parse(original);
    incomplete.assets = incomplete.assets.filter(a => !a.name.endsWith('.msi'));
    await writeFile(recordPath, JSON.stringify(incomplete));
    await assert.rejects(verifyDesktopArtifacts(fixture.dir, fixture.tag, fixture.sha), /Missing .msi/);
    await writeFile(recordPath, original);
    await writeFile(path.join(fixture.dir, 'kubiki.AppImage'), 'tampered');
    const mock = githubMock();
    await assert.rejects(publishDesktopRelease(mock, fixture), /checksum/);
    assert.deepEqual(mock.events, []);
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('failed upload keeps the release unpublished; retry reuses the draft and publishes once', async () => {
  const fixture = await artifacts();
  const mock = githubMock({ failUpload: true });
  try {
    await assert.rejects(publishDesktopRelease(mock, fixture), /Upload interrupted/);
    assert.equal(mock.events.some(e => typeof e === 'object'), false);
    await publishDesktopRelease(mock, fixture);
    assert.equal(mock.events.filter(e => e === 'latest.json').length, 1);
    const published = mock.events.filter(e => typeof e === 'object');
    assert.equal(published.length, 1);
    assert.equal(published[0].prerelease, true);
    assert.equal(published[0].make_latest, 'false');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('published releases are never overwritten and older stable releases do not replace Latest', async () => {
  const fixture = await artifacts('v9876.1.0');
  try {
    const published = githubMock({ draft: false });
    await assert.rejects(publishDesktopRelease(published, fixture), /already published/);
    assert.equal(published.events.includes('delete'), false);
    const older = githubMock({ latest: 'v9999.0.0' });
    await publishDesktopRelease(older, fixture);
    assert.equal(older.events.at(-1).make_latest, 'false');
    const newer = githubMock({ exists: false });
    await publishDesktopRelease(newer, fixture);
    assert.ok(newer.events.includes('create-draft'));
    assert.equal(newer.events.at(-1).make_latest, 'true');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
