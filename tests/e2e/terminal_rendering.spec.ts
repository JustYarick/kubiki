import { expect, test, type Page } from '@playwright/test';
import { captureScreenshot } from './helpers/screenshots';

async function openTerminal(page: Page, fallback = false) {
  if (fallback) await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, type: string, ...args: any[]) {
      return type === 'webgl2' ? null : (original as any).call(this, type, ...args);
    } as typeof original;
  });
  await page.goto('/');
  await page.evaluate(async () => {
    const { createTerminalView } = await import(/* @vite-ignore */ '/src/core/terminal_view.ts' as string);
    const frame = document.createElement('div'); frame.className = 'terminal-frame';
    Object.assign(frame.style, { position: 'fixed', inset: '40px', zIndex: '10000' });
    const host = document.createElement('div'); host.className = 'terminal-surface';
    frame.append(host); document.body.append(frame);
    const sizes: any[] = [];
    const view = createTerminalView(host, { terminalFontFamily: "'JetBrains Mono Variable'", terminalFontSize: 14, terminalLineHeight: 1.2, terminalScrollback: 1000 }, (cols: number, rows: number) => sizes.push({cols, rows}));
    await view.ready;
    const terminal = view.terminal; terminal.options.disableStdin = false;
    (window as any).__terminalTest = { ...view, sizes, host, frame };
    await new Promise<void>(resolve => terminal.write('\x1b[?1049h\x1b[2J\x1b[HA🟢B\r\nпривет é\r\nPowerline: \ue0b0  Nerd: \uf120', resolve));
  });
}

for (const fallback of [false, true]) {
  test(`TUI grid keeps Unicode widths and screen bounds with ${fallback ? 'DOM fallback' : 'available renderer'}`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await openTerminal(page, fallback);
    expect(await page.evaluate(() => {
      const { terminal } = (window as any).__terminalTest;
      const line = terminal.buffer.active.getLine(0);
      return { width: line.getCell(1).getWidth(), afterEmoji: line.getCell(3).getChars() };
    })).toEqual({width: 2, afterEmoji: 'B'});
    if (fallback) await expect(page.locator('.terminal-surface').last()).toHaveAttribute('data-terminal-renderer', 'dom');
    for (const width of [1000, 1440, 1100]) {
      await page.setViewportSize({width, height: 800});
      await expect.poll(() => page.evaluate(() => {
        const { host, terminal } = (window as any).__terminalTest;
        const bounds = host.querySelector('.xterm-screen').getBoundingClientRect();
        const available = host.getBoundingClientRect();
        return bounds.right <= available.right + 1 && bounds.bottom <= available.bottom + 1
          && bounds.width > available.width * .9 && terminal.cols > 10 && terminal.rows > 10;
      })).toBe(true);
    }
    await page.evaluate(async () => {
      const { terminal } = (window as any).__terminalTest;
      const { cols, rows } = terminal;
      await new Promise<void>(resolve => terminal.write(`\x1b[1;1H┌${'─'.repeat(cols - 2)}┐\x1b[${rows};1H└${'─'.repeat(cols - 2)}┘`, resolve));
    });
    await captureScreenshot(page, {path: `test-results/terminal-${fallback ? 'dom' : 'accelerated'}.png`});
    expect(errors).toEqual([]);
  });
}

test('renderer loss preserves the TUI buffer and hidden panes do not shrink the PTY', async ({ page }) => {
  await openTerminal(page);
  const hiddenSizes = await page.evaluate(() => {
    const view = (window as any).__terminalTest;
    const before = {cols: view.terminal.cols, rows: view.terminal.rows};
    view.frame.style.display = 'none'; view.fit();
    return {before, after: {cols: view.terminal.cols, rows: view.terminal.rows}};
  });
  expect(hiddenSizes.after).toEqual(hiddenSizes.before);
  await page.evaluate(() => {
    const view = (window as any).__terminalTest;
    view.frame.style.display = ''; view.fit();
    for (const canvas of view.host.querySelectorAll('.xterm-screen canvas')) {
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  });
  await expect(page.locator('.terminal-surface').last()).toHaveAttribute('data-terminal-renderer', 'dom');
  await expect(page.locator('.terminal-surface').last().locator('.xterm-rows')).toContainText('A🟢B');
  expect(await page.evaluate(() => (window as any).__terminalTest.terminal.buffer.active.getLine(1).translateToString(true))).toContain('привет');
});


test('initial cell measurement waits for text and symbol fonts', async ({ page }) => {
  await page.addInitScript(() => {
    const releases: Array<() => void> = [];
    (window as any).__releaseTerminalFonts = () => releases.forEach(resolve => resolve());
    document.fonts.load = () => new Promise<FontFace[]>(resolve => releases.push(() => resolve([])));
  });
  const opening = openTerminal(page);
  await expect(page.locator('.terminal-surface').last()).toBeVisible();
  await expect(page.locator('.terminal-surface').last().locator('.xterm-screen')).toHaveCount(0);
  await page.evaluate(() => (window as any).__releaseTerminalFonts());
  await opening;
  await expect(page.locator('.terminal-surface').last().locator('.xterm-screen')).toBeVisible();
});


test('software full-screen grids stay compact and restore the preferred shell spacing', async ({ page }) => {
  await openTerminal(page, true);
  expect(await page.evaluate(() => (window as any).__terminalTest.terminal.options.lineHeight)).toBe(1);
  await page.evaluate(() => {
    (window as any).__terminalTest.applyAppearance({terminalFontFamily: 'monospace', terminalFontSize: 16, terminalLineHeight: 1.5, terminalScrollback: 1000});
  });
  expect(await page.evaluate(() => (window as any).__terminalTest.terminal.options.lineHeight)).toBe(1);
  await page.evaluate(async () => {
    const { terminal } = (window as any).__terminalTest;
    await new Promise<void>(resolve => terminal.write('\x1b[?1049l', resolve));
  });
  expect(await page.evaluate(() => (window as any).__terminalTest.terminal.options.lineHeight)).toBe(1.5);
});
