import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names, resolving tailwind conflicts. */
export function cx(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
