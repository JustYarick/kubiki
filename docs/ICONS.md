# Resource icons

## Application logo

The product logo lives in `public/brand/`. Use `kubiki-logo-color-dark.svg`
for the title bar and the gray mark on quiet surfaces such as the empty workspace
and About page. The `-dark` and `-light` suffixes name the intended background;
the SVG files include transparent backgrounds and outlined lettering.

The editable design document is `docs/brand/kubiki.vectorcraft`. It includes the
color and gray variants, their separate export artboards, and small-size previews.
The same presentation is available as [PNG](brand/kubiki-preview.png) and
[PDF](brand/kubiki-preview.pdf) without Vectorcraft.

`kubiki-app-icon.svg` is the source for the desktop application icon. Regenerate
the platform files with:

```sh
pnpm exec tauri icon public/brand/kubiki-app-icon.svg --output src-tauri/icons
```

The Tauri bundle configuration already references the PNG, ICO and ICNS files in
`src-tauri/icons/`. Rebuild and reinstall the desktop package to update an
installed application's launcher icon. The browser favicon uses the color mark.

## Resource symbols

Kubiki uses [Lucide](https://lucide.dev/icons), a free open source outline SVG set.
Its [ISC license](https://lucide.dev/license) permits commercial use; Feather-derived
icons retain their MIT notices in the installed package. Icons are imported from
the existing `lucide-react` dependency and bundled locally.

The shared registry is `src/core/resource_icons.ts`. Use `resourceIcon(kind,
apiVersionOrGroup)` for resources and `CATEGORY_ICONS` for navigation. The resolver
also accepts `custom:group/Kind` collection keys. API groups matter: a native Helm
release uses `Anchor`, while a Flux `HelmRelease` uses `PackageCheck`.

| Navigation | Lucide icon | Meaning |
| --- | --- | --- |
| Flux | Waves | Continuous reconciliation |
| Argo CD | Workflow | Application delivery |
| Custom Resources | Blocks | API extensions |
| Helm | Anchor | Release management |
| Admission Policies | ClipboardCheck | Admission checks |
| Gateway API | Waypoints | Traffic routing |
| Device Resources | Cpu | Allocatable devices |

Flux resource icons distinguish Git repositories, OCI containers, chart
repositories, charts, Kustomizations, Helm releases, image automation and
notifications. Argo CD distinguishes applications, application sets and projects.
Workload controllers also have individual symbols.

The same resource uses the same icon in the explorer (including its duplicate CRD
entry), table, badge, tab, breadcrumb and inspector. Unknown custom resources use
`FileBox`; recognized controller families retain their family symbol as a fallback.
These are semantic UI symbols rather than product logos.

Keep outline icons, `currentColor`, the existing UI scale, and a 1.75–1.8 stroke
for compact resource labels. Decorative icons alongside visible labels should have
`aria-hidden="true"`. Preserve accessible names on icon-only controls.
