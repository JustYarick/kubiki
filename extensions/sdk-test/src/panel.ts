import { connectPanel } from '@kubiki/extension-sdk/panel';
void connectPanel().then(async (host) => {
  const heading = document.createElement('h1');
  heading.textContent = 'SDK Diagnostics';
  const output = document.createElement('pre');
  output.setAttribute('role', 'status');
  output.style.whiteSpace = 'pre-wrap';
  const run = document.createElement('button');
  run.textContent = 'Run SDK checks';
  const notify = document.createElement('button');
  notify.textContent = 'Test notification';
  const visibility = document.createElement('p');
  host.onVisibility((visible) => {
    visibility.textContent = `Panel visibility: ${visible ? 'visible' : 'paused'}`;
  });
  run.onclick = async () => {
    run.disabled = true;
    const results: string[] = [];
    try {
      results.push(String(await host.call('check')));
      const echo = await host.call('echo', {
        unicode: 'Привет 🌍',
        list: [1, true, null],
      });
      if (
        JSON.stringify(echo) !==
        JSON.stringify({ unicode: 'Привет 🌍', list: [1, true, null] })
      )
        throw new Error('RPC round trip failed');
      results.push('Panel ↔ backend RPC and Unicode: PASS');
      try {
        await host.call('fail');
        throw new Error('Expected error was lost');
      } catch (e) {
        if (
          !(e instanceof Error) ||
          !e.message.includes('Expected SDK diagnostic error')
        )
          throw e;
      }
      results.push('Error propagation: PASS');
      const controller = new AbortController();
      const waiting = host.call('wait', null, controller.signal);
      controller.abort();
      try {
        await waiting;
        throw new Error('Cancellation was lost');
      } catch (e) {
        if (
          !(e instanceof Error) ||
          !e.message.toLowerCase().includes('cancel')
        )
          throw e;
      }
      results.push('Cancellation: PASS');
      results.push(
        'Lifecycle: hide this tab, reopen it, then disable/re-enable the extension.',
      );
    } catch (error) {
      results.push(`FAIL: ${error instanceof Error ? error.message : error}`);
    } finally {
      output.textContent = results.join('\n');
      run.disabled = false;
    }
  };
  notify.onclick = async () => {
    try {
      output.textContent += '\n' + String(await host.call('notify'));
    } catch (e) {
      output.textContent += '\n' + String(e);
    }
  };
  document
    .getElementById('root')!
    .append(heading, run, notify, visibility, output);
  run.click();
});
