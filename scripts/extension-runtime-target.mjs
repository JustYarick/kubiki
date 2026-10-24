const targets = {
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64' },
  'x86_64-pc-windows-msvc': { platform: 'win', arch: 'x64' },
  'aarch64-pc-windows-msvc': { platform: 'win', arch: 'arm64' },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64' },
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64' },
};

/** Tauri's selected target determines the bundled runtime, including cross-builds. */
export function extensionRuntimeTarget(env = process.env, hostPlatform = process.platform, hostArch = process.arch) {
  const selected = env.TAURI_ENV_TARGET_TRIPLE;
  const requested = env.KUBIKI_BUILD_TARGET;
  if (selected && requested && selected !== requested) {
    throw new Error(`Conflicting desktop targets: Tauri selected ${selected}, KUBIKI_BUILD_TARGET is ${requested}`);
  }
  const target = selected || requested;
  if (target) {
    if (!Object.hasOwn(targets, target)) {
      throw new Error(`Unsupported extension runtime target: ${target}. Build separate supported architectures instead of a universal or musl package.`);
    }
    return { ...targets[target], target };
  }
  const platform = { linux: 'linux', darwin: 'darwin', win32: 'win' }[hostPlatform];
  if (!platform || !['x64', 'arm64'].includes(hostArch)) throw new Error('Unsupported extension runtime platform');
  return { platform, arch: hostArch };
}
