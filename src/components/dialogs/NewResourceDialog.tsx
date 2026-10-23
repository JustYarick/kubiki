import { useEffect, useState } from 'react';
import { resourceType, apiVersionFor as typeApiVersion } from '../../core/resources/resource_types';
import type { ResourceKind } from '../../types/k8s';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Input, Label } from '../ui/Input';
const apiVersionFor = (kind: ResourceKind): string => typeApiVersion(resourceType(kind));

const templateFor = (kind: ResourceKind, name: string, ns: string): string => {
  const head = [`apiVersion: ${apiVersionFor(kind)}`, `kind: ${kind}`, 'metadata:', `  name: ${name}`, ...(ns ? [`  namespace: ${ns}`] : []), 'spec:'];
  if (['Deployment', 'StatefulSet'].includes(kind))
    return [...head, '  replicas: 1', '  selector:', '    matchLabels:', `      app: ${name}`, '  template:', '    metadata:', '      labels:', `        app: ${name}`, '    spec:', '      containers:', '      - name: app', '        image: nginx:1.27-alpine', '        ports:', '        - containerPort: 80'].join('\n') + '\n';
  if (kind === 'Service')
    return [...head, '  type: ClusterIP', '  selector:', `    app: ${name}`, '  ports:', '  - port: 80', '    targetPort: 8080'].join('\n') + '\n';
  return [...head, '  # edit me…'].join('\n') + '\n';
};

export function NewResourceDialog({
  open, kind, defaultNs, onClose, onCreate,
}: {
  open: boolean;
  kind: ResourceKind;
  defaultNs: string;
  onClose: () => void;
  onCreate: (name: string, ns: string, yaml: string) => void;
}) {
  const [name, setName] = useState('');
  const [ns, setNs] = useState(defaultNs);
  const [yaml, setYaml] = useState('');

  useEffect(() => {
    if (open) {
      setName(`my-${kind.toLowerCase()}`);
      setNs(defaultNs);
      setYaml(templateFor(kind, `my-${kind.toLowerCase()}`, defaultNs));
    }
  }, [open, kind, defaultNs]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={560}
      title={`New ${kind}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!/^[a-z0-9][a-z0-9-]*$/.test(name)} onClick={() => onCreate(name, ns, yaml)}>
            Create (demo)
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>Name (DNS-1123)</Label>
            <Input value={name} onChange={(e) => { setName(e.target.value); setYaml(templateFor(kind, e.target.value || '…', ns)); }} />
            {!/^[a-z0-9][a-z0-9-]*$/.test(name) && <span className="text-[length:calc(10px*var(--ui-factor))] text-[var(--status-danger)]">lowercase letters, digits and “-” only</span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Namespace</Label>
            <Input value={ns} onChange={(e) => { setNs(e.target.value); setYaml(templateFor(kind, name, e.target.value)); }} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-h-0">
          <Label>Manifest</Label>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
            className="flex-1 min-h-[calc(220px*var(--ui-factor))] resize-none bg-[var(--bg-canvas)] border border-[var(--border-default)] rounded-[calc(6px*var(--ui-factor))] p-3 font-mono text-[length:calc(11.5px*var(--ui-factor))] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-colors kubiki-scrollbar"
          />
        </div>
        <p className="text-[length:calc(11px*var(--ui-factor))] text-[var(--text-muted)]">
          Demo mode — manifest will be stored in local memory store.
        </p>
      </div>
    </Modal>
  );
}
