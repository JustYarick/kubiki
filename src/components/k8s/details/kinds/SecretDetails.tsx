import type { ResourceItem } from '../../../../types/k8s';
import { FullManifest } from '../../../../views/FullManifest';
import { ProblemsBanner } from '../blocks/ProblemsBanner';
import { SecretDataEditorBlock } from '../blocks/SecretDataEditorBlock';
import { UsedByList } from '../blocks/UsedByList';
import { MetadataBlock } from '../blocks/MetadataBlock';
import { SecretOriginBlock } from '../blocks/SecretOriginBlock';

interface SecretDetailsProps {
  item: ResourceItem;
  onNavigate: (item: ResourceItem) => void;
}

export function SecretDetails({ item, onNavigate }: SecretDetailsProps) {
  return (
    <div className="details-stack">
      {/* 1. "What's wrong" diagnostic banner */}
      <ProblemsBanner item={item} />

      <SecretOriginBlock item={item} onNavigate={onNavigate} />

      {/* 2. Secret Data Editor (hydrates full Secret payload on demand) */}
      <FullManifest item={item} loadingLabel="Loading Secret data…">
        {(hydrated) => <SecretDataEditorBlock item={hydrated} />}
      </FullManifest>

      {/* 3. Used by consumers (who uses this secret) */}
      <UsedByList item={item} onNavigate={onNavigate} />

      {/* 4. Metadata */}
      <MetadataBlock item={item} onNavigate={onNavigate} />
    </div>
  );
}
