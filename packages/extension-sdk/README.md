# Kubiki Extension SDK

The SDK is an independently versioned public package maintained in the Kubiki
workspace. Extensions must not import application components, Zustand stores or
Tauri commands. Host API 1.0 supports manifests version 1 and trusted Node backends.

```ts
import { defineExtension } from '@kubiki/extension-sdk';
export const activate = defineExtension(context => ({
  methods: {
    hello: async (params, { signal }) => {
      signal.throwIfAborted();
      await context.settings.set('last-request', params);
      return 'Hello';
    },
  },
}));
```

Backend methods receive JSON and an AbortSignal; results must be JSON, without
undefined, functions or BigInts. Throw Error for an actionable user-facing error.
Use `context.subscriptions.push({ dispose })` or a returned `deactivate()` to close
connections, timers and subscriptions. The host calls cleanup on disable, last-view
close and shutdown, then enforces a deadline. Never rely exclusively on cleanup
for correctness of a remote database write.

Declare `settings`, `secrets` and/or `notifications` in `requestedCapabilities`.
Settings are namespaced JSON, limited to 64 KiB per extension. Secrets use the OS
credential store through `context.secrets.get/set/delete`; handle unavailability
and offer session-only credentials. Never put passwords in settings or logs.

```ts
import { connectPanel } from '@kubiki/extension-sdk/panel';
const host = await connectPanel();
const result = await host.call('hello', { message: 'Hi' });
const unsubscribe = host.onVisibility(visible => { /* pause view work when hidden */ });
```

Panels use a host-created MessagePort, receive semantic CSS theme variables, and
can call their own backend, settings and notifications. Their opaque-origin iframe
has no parent DOM, direct Tauri access, external scripts or network access. Bundle
all scripts/styles into the package; forms need JS handlers with preventDefault.
Rendering and output escaping are the author's responsibility.

The host activates lazily. Commands declared in `contributes.commands` appear in
the command palette and invoke their backend method with null params. Multiple
panels share one backend process. Default call deadline is 30 seconds; response
size is limited to 1 MiB. Cancelled calls receive an AbortSignal; an already applied
external write cannot be undone by cancellation.

The Node backend is trusted local code with the user's OS privileges. SDK
capabilities constrain mediated Kubiki services, not arbitrary Node filesystem
and network access. A separate process provides failure isolation, not a security
sandbox against malicious backend code.
