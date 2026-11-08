import { useEffect, useSyncExternalStore } from 'react';
import { agentError, agentTransport, desktopAiAvailable } from './transport';
import type { SkillInfo } from './types';

let snapshot: { skills: SkillInfo[]; error: string } = { skills: [], error: '' };
let loaded = false;
let pending: Promise<void> | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function refreshInstalledSkills(force = true): Promise<void> {
  if (!desktopAiAvailable() || (loaded && !force)) return Promise.resolve();
  if (pending) return pending;
  pending = agentTransport.skills().then(skills => { snapshot = { skills, error: '' }; loaded = true; }).catch(error => { snapshot = { ...snapshot, error: agentError(error) }; }).finally(() => { pending = undefined; listeners.forEach(listener => listener()); });
  return pending;
}
export function useInstalledSkills() {
  const value = useSyncExternalStore(subscribe, () => snapshot);
  useEffect(() => { void refreshInstalledSkills(false); }, []);
  return value;
}
export function splitSkillReferences(text: string, names: ReadonlySet<string>): Array<{ text: string; skill: boolean }> {
  return text.split(/(\$[a-zA-Z0-9_-]+)/g).map((part, index, parts) => ({ text: part, skill: part.startsWith('$') && names.has(part.slice(1)) && (index === 0 || !/[\w$]$/.test(parts[index - 1])) }));
}
