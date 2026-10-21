import { helmResource } from '../core/resources/helm';
import type { HelmRelease } from '../providers/helm_types';
import { useResourceStore } from './resource_store';
import { useUiStore } from './ui_store';

/** Release revisions update the same selectable resource and keep navigation history intact. */
export function cacheHelmReleases(context: string, releases: HelmRelease[]) {
  const store = useResourceStore.getState();
  const resources = new Map(store.resources.HelmRelease);
  let changed = false;
  const items = releases.map(release => {
    const item = helmResource(context, release);
    const existing = resources.get(item.uid);
    if (existing && JSON.stringify(existing.raw?.release) === JSON.stringify(release)) return existing;
    resources.set(item.uid, item); changed = true; return item;
  });
  if (changed) store.setResourcesForKind('HelmRelease', [...resources.values()]);
  return items;
}

export function inspectHelmRelease(context: string, release: HelmRelease) {
  const [item] = cacheHelmReleases(context, [release]);
  useResourceStore.getState().selectItem(item);
  useUiStore.setState({ inspectorCollapsed: false, rightTab: 'overview' });
}
