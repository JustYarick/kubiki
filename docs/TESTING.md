# Test suites

| Command | Coverage |
| --- | --- |
| `pnpm test` | Pure logic, state, parsing, resource identity, adapters, permissions and cancellation contracts. |
| `cargo test --locked --manifest-path crates/kubiki-ai/Cargo.toml` | Native AI policy, provider stream decoding, model metadata and tool runtime tests using a local HTTP server. |
| `pnpm test:desktop` | Build provenance, updater manifests, publication gates, release channels and VirusTotal request pacing/report verification. No public files are uploaded by these tests. |
| `pnpm test:extensions` | Extension package validation, capabilities, settings, cancellation and local host process/RPC lifecycles. |
| `pnpm test:e2e` | Standard browser regression suite, including large inventories, stream cleanup, reviewed operations and representative responsive layouts. |
| `pnpm test:e2e:full` | The same browser suite plus every original width/scale combination. Publication CI runs this full layout matrix automatically. |

Install dependencies and prepare the extension fixtures before browser tests:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm extensions:build
pnpm test:e2e
```

## Browser runtime and isolation

`tests/e2e/ai_agent.spec.ts` uses mocked native IPC for dynamic model discovery,
credentials, permission editing, streamed chat, resource entry points, proposals
and Stop. Agent Rust tests do not call paid providers or a live cluster. Core
`revocable_mutation_tests` verifies cancellation after commit's final read prevents
an actual write. These fixtures do not establish real model quality or OS keyring
behavior on every platform.

The suite uses two workers across independent files. Tests within one file stay
sequential. On a small machine, use `pnpm test:e2e --workers=1`.
The default browser is Chromium; `PLAYWRIGHT_BROWSER=webkit` selects WebKit when
its browser binary and native dependencies have been installed.

The test server uses **127.0.0.1:1430**, separate from the development server on
1420. It does not reuse an existing server and receives an empty kubeconfig.
Kubernetes APIs and desktop IPC are mocked by scenarios; optional external Redis
integration remains opt-in through `KUBIKI_REDIS_PACKAGE` and its existing settings.
Extension integration tests actually launch local Node processes. This suite does
not prove live-cluster transport, installed native applications or macOS GPU FPS.

`PLAYWRIGHT_BASE_URL` uses an externally managed server and disables automatic
server startup. Some scenarios import `/src` modules, so the entire suite still
requires Vite; production-preview runs must select compatible scenarios.

## Native Kubernetes TLS regression

`src-tauri/src/kubernetes_tls_tests.rs` constructs real HTTPS clients with the
desktop's complete dependency feature graph. It checks Kubernetes-first and
AI-first startup in isolated subprocesses: Rustls's process-global provider must
not be initialized accidentally by another parallel test. A mocked Kubernetes
service or a standalone core build cannot catch conflicts introduced by desktop
dependencies. AI uses `rustls-no-provider` with the existing Ring backend, matching
Kubernetes and the updater; enabling reqwest's `rustls` feature also adds AWS-LC
and can make kube's automatic crypto-provider selection panic.

The current-context probe is ignored in CI. To explicitly check connectivity using
the actual native client before and after AI initialization, run:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib \
  kubernetes_tls_tests::current_cluster_version_is_reachable_before_and_after_ai \
  -- --exact --ignored --nocapture
```

This probe uses the current kubeconfig context and only requests `/version`.
It does not change configuration or Kubernetes resources.

## Standard and full layout coverage

The standard matrix has desktop, tablet and narrow/high-scale cases for details,
Overview and YAML/topology. The full matrix retains the additional original
width/scale combinations. No stress or operation-safety tests are omitted from
the standard suite. List the current scenarios with `pnpm exec playwright test
--list`; set `E2E_FULL_LAYOUT=1` to list the full matrix. The optional Redis
scenario is skipped without its package.

CI selects the full matrix when publishing (`E2E_FULL_LAYOUT=1`), independently
of test worker count. It does not skip required test jobs or change failure policy.

## Reports and diagnostic images

Every normal run writes **`test-results/report.json`** with per-scenario timings
and results. CI retains it in `interface-test-results` even on success and writes
the ten slowest scenarios into the job summary. Generate that summary locally:

```sh
node scripts/summarize-e2e.mjs
```

Failure screenshots and traces are retained automatically. Successful-run images
are optional review artifacts, not image-diff assertions. Set `E2E_SCREENSHOTS=1`
to collect them, for example on Linux/macOS:

```sh
E2E_SCREENSHOTS=1 pnpm test:e2e:full
```

Compare repeated timings on the same machine, worker count, layout matrix and
screenshot setting. Separate failing deadline waits from passing test duration;
CPU/memory/FPS are different measurements. Manual renderer probes live under
`tests/perf/` and are described in [Desktop rendering](DESKTOP_RENDERING.md).

## Maintaining coverage

Keep pure decisions in unit tests: API group routing, names, parsing and policy
tables do not need browser startup. Browser checks should assert visible behavior
and real interaction. Share fixture helpers so namespace discovery and list/watch
snapshots describe the same objects and honor the requested namespace.

When merging scenarios that repeat startup/navigation, carry their meaningful
assertions into the surviving scenario. A style property's existence is not proof
that focus is visible; a non-strict scroll-size comparison is not proof that an
element scrolls. Use actual geometry, focus and scroll movement.

Keep cancellation, late-response isolation, unsaved-data retention, exact mutation
identity and process/watch/tunnel cleanup covered even when simplifying layout
or catalog checks. Do not compensate for broken fixtures with retries, sleeps
or larger timeouts.
