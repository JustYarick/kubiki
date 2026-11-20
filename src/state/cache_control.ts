import { useClusterStore } from './cluster_store';
import { useDetailCache } from './detail_cache';
import { useResourceStore } from './resource_store';
import { refreshResourceWatches } from './resource_watch';
import { resetStaleRefreshToasts } from './stale_error_toast';
import { clearHelmInventoryCache } from '../providers/helm_inventory_subscriptions';
import { clearGitOpsDashboardCache } from '../providers/use_gitops_dashboard';
import { clearFluxHelmOwnersCache } from '../providers/use_flux_helm_owners';
import { clearCustomResourcesCache } from '../providers/use_custom_resources';
import { clearOverviewMetricsCache } from '../providers/use_overview_metrics';

/**
 * Drops in-memory cached snapshots across stopped resource tables, dashboard polls,
 * metrics history caches, and detail caches. When `refreshActive` is true, also
 * refreshes currently open watches and polling dashboards.
 */
export async function clearAllResourceCaches(options: { refreshActive?: boolean } = {}): Promise<void> {
  const { refreshActive = false } = options;
  const context = useClusterStore.getState().currentContext ?? undefined;

  useDetailCache.getState().clear(context);
  useResourceStore.getState().clearStoppedSnapshots();
  clearHelmInventoryCache(refreshActive);
  clearGitOpsDashboardCache(refreshActive);
  clearFluxHelmOwnersCache(refreshActive);
  clearCustomResourcesCache(refreshActive);
  clearOverviewMetricsCache(refreshActive);
  resetStaleRefreshToasts();

  if (refreshActive) {
    await refreshResourceWatches().catch(() => {});
  }
}
