import { useMemo } from 'react';
import type { ResourceItem, ResourceKind } from '../../../types/k8s';
import { customColumnValue, type CustomResourceType } from '../../../core/resources/custom_resource_types';
import { presentationFor, fieldText, fieldValue } from '../../../core/resources/resource_presentations';
import { columnsFor, BASE_COLUMNS, type ColumnDef } from './columns';
import type { WorkloadPodActivity } from '../../../core/resources/workload_pod_activity';

export function useResourceColumns(effectiveKind: ResourceKind, customType: CustomResourceType | undefined, podsByNode: Map<string, number>, podActivity?: Map<string, WorkloadPodActivity>) {
  return useMemo<ColumnDef[]>(() => {
    if (!customType) return columnsFor(effectiveKind, { podsByNode, podActivity });
    const printers = customType.columns.filter(column => column.name.toLowerCase() !== 'age').map((column, index) => ({
      id: /^(status|phase)$/i.test(column.name) ? 'status' : `printer-${index}`,
      label: column.name,
      get: (item: ResourceItem) => customColumnValue(item.raw, column.jsonPath),
    }));
    if (printers.length > 0) {
      return [
        BASE_COLUMNS[0],
        ...(customType.namespaced ? [BASE_COLUMNS[1]] : []),
        ...(printers.some(column => column.id === 'status') ? [] : [{ id: 'status', label: 'Status', get: (item: ResourceItem) => item.status }]),
        ...printers,
        { id: 'age', label: 'Age', align: 'right', get: (item: ResourceItem) => item.age },
      ];
    }
    const presentation = presentationFor({ kind: customType.kind, apiVersion: `${customType.group}/${customType.version}` });
    if (presentation && presentation.fields.length > 0) {
      return [
        BASE_COLUMNS[0],
        ...(customType.namespaced ? [BASE_COLUMNS[1]] : []),
        { id: 'status', label: 'Status', get: item => item.status },
        ...presentation.fields.map((field, index) => ({ id: `gitops-${index}`, label: field.label, get: (item: ResourceItem) => fieldText(fieldValue(item.raw, field.path)) })),
        { id: 'age', label: 'Age', align: 'right', get: (item: ResourceItem) => item.age },
      ];
    }
    return [
      BASE_COLUMNS[0],
      ...(customType.namespaced ? [BASE_COLUMNS[1]] : []),
      { id: 'status', label: 'Status', get: (item: ResourceItem) => item.status },
      { id: 'age', label: 'Age', align: 'right', get: (item: ResourceItem) => item.age },
    ];
  }, [effectiveKind, customType, podsByNode, podActivity]);
}
