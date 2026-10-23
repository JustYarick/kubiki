import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './overflow-tooltip.css';

interface Target { element: HTMLElement; owner: HTMLElement; text: string }

function clipped(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (style.textOverflow === 'ellipsis' || Number.parseInt(style.webkitLineClamp) > 0)
    && element.clientWidth > 0
    && (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
}

function findTarget(origin: HTMLElement, keyboard = false): Target | undefined {
  if (origin.closest('input, textarea, [contenteditable="true"], .monaco-editor, .xterm, [role="tooltip"]')) return;
  let element: HTMLElement | null = origin;
  while (element && element !== document.body) {
    if (clipped(element)) {
      const text = element.textContent?.trim();
      if (text) return { element, owner: origin, text };
    }
    element = element.parentElement;
  }
  if (keyboard) {
    const activeRow = origin.querySelector('tr.focused') ?? origin;
    for (const child of Array.from(activeRow.querySelectorAll<HTMLElement>('*')).slice(0, 100)) {
      if (clipped(child) && child.textContent?.trim()) return { element: child, owner: origin, text: child.textContent.trim() };
    }
  }
}

/** One delegated tooltip for ellipsized text, including virtual table rows and portals. */
export function OverflowTooltip() {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useEffect(() => {
    let candidate: Target | undefined;
    let visible = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let leaveTimer: ReturnType<typeof setTimeout> | undefined;
    const titles = new Map<HTMLElement, string>();
    const restoreTitles = () => {
      for (const [element, title] of titles) if (!element.hasAttribute('title')) element.setAttribute('title', title);
      titles.clear();
    };
    const close = () => {
      clearTimeout(timer); clearTimeout(leaveTimer);
      if (candidate) {
        const descriptions = (candidate.owner.getAttribute('aria-describedby') ?? '').split(' ').filter(value => value && value !== id);
        if (descriptions.length) candidate.owner.setAttribute('aria-describedby', descriptions.join(' '));
        else candidate.owner.removeAttribute('aria-describedby');
      }
      candidate = undefined; visible = false; restoreTitles(); setTarget(null);
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!candidate?.element.isConnected || !clipped(candidate.element) || candidate.element.textContent?.trim() !== candidate.text) { close(); return; }
        const describedBy = candidate.owner.getAttribute('aria-describedby');
        candidate.owner.setAttribute('aria-describedby', [describedBy, id].filter(Boolean).join(' '));
        visible = true; setTarget({ ...candidate });
      }, 500);
    };
    const consider = (origin: HTMLElement, keyboard = false) => {
      const next = findTarget(origin, keyboard);
      if (next?.element === candidate?.element && next?.owner === candidate?.owner) return;
      close(); candidate = next;
      if (!next) return;
      // Avoid a second, browser-native tooltip with an uncontrolled delay.
      for (const start of [next.owner, next.element]) {
        let element: HTMLElement | null = start;
        while (element && element !== document.body) {
          const title = element.getAttribute('title');
          if (title !== null) { titles.set(element, title); element.removeAttribute('title'); }
          element = element.parentElement;
        }
      }
      schedule();
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !(event.target instanceof HTMLElement)) return;
      if (popup.current?.contains(event.target)) { clearTimeout(leaveTimer); return; }
      consider(event.target);
    };
    const move = (event: PointerEvent) => {
      if (!candidate || visible || event.pointerType === 'touch') return;
      if (event.movementX || event.movementY) schedule();
    };
    const out = (event: PointerEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && (popup.current?.contains(next) || candidate?.element.contains(next))) return;
      clearTimeout(timer);
      if (visible) leaveTimer = setTimeout(close, 120); else close();
    };
    const focus = (event: FocusEvent) => { if (event.target instanceof HTMLElement) consider(event.target, true); };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !candidate) return;
      if (visible) { event.preventDefault(); event.stopPropagation(); }
      close();
    };
    const keyup = (event: KeyboardEvent) => {
      if (event.key.startsWith('Arrow') && document.activeElement instanceof HTMLElement) consider(document.activeElement, true);
    };
    const blur = () => close();
    const dismissOutsidePopup = (event: Event) => { if (!(event.target instanceof Node) || !popup.current?.contains(event.target)) close(); };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerout', out);
    document.addEventListener('pointerdown', dismissOutsidePopup, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('keyup', keyup);
    document.addEventListener('scroll', dismissOutsidePopup, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', blur);
    // Virtualized rows can be replaced while the pointer is stationary.
    const observer = new MutationObserver(records => {
      if (!candidate) return;
      if (!candidate.element.isConnected) { close(); return; }
      if (records.some(record => candidate!.element.contains(record.target)) && (candidate.element.textContent?.trim() !== candidate.text || !clipped(candidate.element))) close();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      clearTimeout(timer); clearTimeout(leaveTimer); restoreTitles(); observer.disconnect();
      if (candidate) {
        const remaining = (candidate.owner.getAttribute('aria-describedby') ?? '').split(' ').filter(value => value && value !== id).join(' ');
        if (remaining) candidate.owner.setAttribute('aria-describedby', remaining); else candidate.owner.removeAttribute('aria-describedby');
      }
      document.removeEventListener('pointerover', over); document.removeEventListener('pointermove', move); document.removeEventListener('pointerout', out);
      document.removeEventListener('pointerdown', dismissOutsidePopup, true); document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur);
      document.removeEventListener('keydown', keydown, true); document.removeEventListener('keyup', keyup); document.removeEventListener('scroll', dismissOutsidePopup, true);
      window.removeEventListener('resize', close); window.removeEventListener('blur', blur);
    };
  }, [id]);

  useLayoutEffect(() => {
    if (!target || !popup.current) return;
    const anchor = target.element.getBoundingClientRect();
    const bounds = popup.current.getBoundingClientRect();
    const below = anchor.bottom + 6;
    const top = below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 6;
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) });
  }, [target]);

  return target && createPortal(<div ref={popup} id={id} role="tooltip" className="overflow-tooltip kubiki-scrollbar" style={position}>{target.text}</div>, document.body);
}
