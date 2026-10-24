import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extensionRuntimeTarget } from '../../scripts/extension-runtime-target.mjs';

test('cross-building bundles the target runtime instead of the build host runtime', () => {
  for (const [target, platform, arch] of [
    ['x86_64-apple-darwin', 'darwin', 'x64'],
    ['aarch64-apple-darwin', 'darwin', 'arm64'],
    ['x86_64-pc-windows-msvc', 'win', 'x64'],
    ['aarch64-pc-windows-msvc', 'win', 'arm64'],
    ['x86_64-unknown-linux-gnu', 'linux', 'x64'],
    ['aarch64-unknown-linux-gnu', 'linux', 'arm64'],
  ]) {
    assert.deepEqual(extensionRuntimeTarget({ TAURI_ENV_TARGET_TRIPLE: target }, 'linux', 'x64'), { target, platform, arch });
    assert.deepEqual(extensionRuntimeTarget({ KUBIKI_BUILD_TARGET: target }, 'darwin', 'arm64'), { target, platform, arch });
  }
});

test('standalone desktop preparation retains the native host architecture', () => {
  assert.deepEqual(extensionRuntimeTarget({}, 'win32', 'x64'), { platform: 'win', arch: 'x64' });
  assert.deepEqual(extensionRuntimeTarget({}, 'darwin', 'arm64'), { platform: 'darwin', arch: 'arm64' });
});

test('rejects mismatched CI and Tauri targets instead of shipping a wrong executable', () => {
  assert.throws(() => extensionRuntimeTarget({ KUBIKI_BUILD_TARGET: 'aarch64-apple-darwin', TAURI_ENV_TARGET_TRIPLE: 'x86_64-apple-darwin' }), /Conflicting desktop targets/);
  for (const target of ['universal-apple-darwin', 'x86_64-unknown-linux-musl', 'i686-pc-windows-msvc']) {
    assert.throws(() => extensionRuntimeTarget({ TAURI_ENV_TARGET_TRIPLE: target }), /Unsupported extension runtime target/);
  }
  assert.throws(() => extensionRuntimeTarget({}, 'linux', 'ia32'), /Unsupported extension runtime platform/);
});
