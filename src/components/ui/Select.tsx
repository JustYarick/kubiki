import { Children, isValidElement, type ReactElement, type SelectHTMLAttributes, type OptionHTMLAttributes } from 'react';
import { selectedFirst } from '../../core/utils/selected_first';

/** Native keyboard/accessibility behavior with the current choice at the top. */
export function Select({ children, value, defaultValue, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const selected = new Set([value ?? defaultValue].flat().filter(entry => entry !== undefined).map(String));
  const options = selectedFirst(Children.toArray(children), child => {
    if (!isValidElement<OptionHTMLAttributes<HTMLOptionElement>>(child) || child.type !== 'option') return false;
    const option = child as ReactElement<OptionHTMLAttributes<HTMLOptionElement>>;
    return selected.has(String(option.props.value ?? option.props.children));
  });
  return <select {...props} value={value} defaultValue={defaultValue}>{options}</select>;
}
