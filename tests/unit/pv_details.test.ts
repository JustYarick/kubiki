import { describe, it, expect } from 'vitest';
import { memoryText, quantity } from '../../src/core/resources/quantities';
import type { ResourceItem } from '../../src/types/k8s';

describe('PvDetails data extraction', () => {
  const samplePv: ResourceItem = {
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    name: 'pv-storage-01',
    uid: 'pv-uid-1',
    status: 'Bound',
    raw: {
      metadata: {
        name: 'pv-storage-01',
        uid: 'pv-uid-1',
      },
      spec: {
        capacity: {
          storage: '100Gi',
        },
        accessModes: ['ReadWriteOnce'],
        persistentVolumeReclaimPolicy: 'Retain',
        storageClassName: 'fast-ssd',
        volumeMode: 'Filesystem',
        claimRef: {
          namespace: 'default',
          name: 'my-pvc',
        },
        csi: {
          driver: 'pd.csi.storage.gke.io',
          volumeHandle: 'projects/test/disks/disk-1',
        },
      },
      status: {
        phase: 'Bound',
      },
    },
  };

  it('correctly reads capacity from spec.capacity.storage for PV', () => {
    const raw = samplePv.raw ?? {};
    const spec = raw.spec ?? {};
    const capacityStorage = spec.capacity?.storage;
    expect(capacityStorage).toBe('100Gi');
    expect(memoryText(quantity(capacityStorage))).toBe('100 GiB');
  });

  it('extracts reclaimPolicy and claimRef cleanly', () => {
    const spec = samplePv.raw?.spec ?? {};
    expect(spec.persistentVolumeReclaimPolicy).toBe('Retain');
    expect(spec.claimRef).toEqual({ namespace: 'default', name: 'my-pvc' });
    expect(spec.csi?.driver).toBe('pd.csi.storage.gke.io');
  });
});
