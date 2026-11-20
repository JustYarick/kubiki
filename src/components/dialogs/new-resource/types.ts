import type { ComponentType } from 'react';
import type { NewResourceType } from '../../../core/resources/new_resource';
import type { ResourceCreatorModel } from '../../../core/resources/creators';

export interface ResourceCreatorFormProps<TState> {
  state: TState;
  type: NewResourceType;
  disabled: boolean;
  onChange: (next: TState) => void;
}

export interface RegisteredResourceCreator<TState = any> {
  model: ResourceCreatorModel<TState>;
  Form: ComponentType<ResourceCreatorFormProps<TState>>;
}
