import { afterEach, expect, it } from 'vitest';
import { assertUpdateCanInstall } from '../../src/state/update_store';
import { useYamlDraftStore } from '../../src/state/yaml_draft_store';
import { useWorkspaceStore } from '../../src/state/workspace_store';
import { useMutationConfirmStore } from '../../src/state/mutation_confirm_store';

afterEach(() => {
  useYamlDraftStore.setState({ drafts: {} });
  useWorkspaceStore.setState({ tabs: [] });
  useMutationConfirmStore.setState({ pending: null });
});

it('blocks installation for unsaved editor drafts, including closed editor tabs', () => {
  useYamlDraftStore.getState().saveDraft('test', { draft: 'edited', fullDraft: 'edited', uid: 'uid', cleanView: true, resourceVersion: '1', dirty: true });
  expect(assertUpdateCanInstall).toThrow('unsaved YAML');
  useYamlDraftStore.getState().clearDraft('test');
  expect(assertUpdateCanInstall).not.toThrow();
});

it('blocks installation while a native mutation confirmation is open', () => {
  useMutationConfirmStore.setState({ pending: { id: 'pending', review: 'Change resource', resource: { context: 'prod', group: '', version: 'v1', kind: 'Pod', namespace: 'default', name: 'web', uid: 'uid' } } });
  expect(assertUpdateCanInstall).toThrow('confirmation');
});
