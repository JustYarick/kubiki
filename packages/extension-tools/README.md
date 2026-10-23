# Kubiki extension tools

Requires Node 24 or newer for development. End users get a bundled runtime in
Kubiki desktop and do not need Node/npm.

```sh
npx --package @kubiki/extension-tools kubiki-extension init my-extension
cd my-extension
npm install
npx kubiki-extension dev .
npm run build
```

Edit extension.json to give the package your own stable publisher-qualified ID,
name and description. Implement src/backend.ts and src/panel.ts, with optional
src/panel.css. React is optional: the SDK panel bridge is framework-independent.
The development command prints a loopback-only browser URL, runs the backend in
a child process and reloads changes in src/ or extension.json. Its credential
store is in memory only. Always also test the final package in Kubiki desktop.

`kubiki-extension pack <folder>` builds one self-contained CJS backend and inline
UI bundle. Output contains the .kubiki-extension ZIP and a .sha256 sidecar in dist/.
Publish both as GitHub Release assets, then paste the repository or release URL
into Kubiki's Extensions manager. Each release must have exactly one extension
package. A release tag and extension.json version should match.

The included release workflow creates a draft GitHub release for review. It needs
the SDK/tools versions declared in package.json to be published first. The SDK and
tools namespaces are package names, not claims that npm publication has occurred.

For development before npm publication, build the SDK in the Kubiki workspace and
pack SDK/tools to tarballs. Init accepts `--sdk /absolute/path/to/sdk.tgz`; set the
new project's tools dependency to the packaged tools tarball as well. The
`scripts/check-external-extension.mjs` workspace check exercises that exact path
outside the application repository.

Packages support compiled JavaScript and static assets only. Native Node addons
and install scripts are unsupported. Supported manifest hostApi is a SemVer range
against host API 1.0.0, separate from the desktop application version.
