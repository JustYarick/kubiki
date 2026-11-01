import { Children, cloneElement, isValidElement, type ReactNode, type ReactElement } from 'react';
import { splitSkillReferences, useInstalledSkills } from '../skill_catalog';

export function SkillReferenceText({ text }: { text: string }) {
  const { skills } = useInstalledSkills();
  const names = new Set(skills.map(skill => skill.name));
  return <>{splitSkillReferences(text, names).map((part, index) => part.skill ? <span key={index} className="ai-skill-reference" title={`Installed skill ${part.text}`}><span className="sr-only">Skill </span>{part.text}</span> : part.text)}</>;
}
export function highlightSkillChildren(children: ReactNode): ReactNode {
  return Children.map(children, child => {
    if (typeof child === 'string') return <SkillReferenceText text={child} />;
    if (!isValidElement(child) || ['code', 'pre', 'a'].includes(String(child.type))) return child;
    const element = child as ReactElement<{ children?: ReactNode }>;
    return cloneElement(element, {}, highlightSkillChildren(element.props.children));
  });
}
