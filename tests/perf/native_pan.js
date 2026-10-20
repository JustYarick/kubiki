// Shared by the GTK and full-Tauri probes. Synthetic data only, no live operations.
(async () => {
  const config = window.__kubikiBench ?? {};
  const wait = async fn => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const value = fn(); if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('UI timed out: ' + document.body.innerText.slice(-1000));
  };
  const button = name => [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === name || button.innerText === name);
  try {
    const table = await wait(() => document.querySelector('[data-testid=resource-table]')?.innerText.includes('pod-0') && document.querySelector('[data-testid=resource-table]'));
    const scroll = config.mode === 'scroll';
    let pane, start, before;
    if (!scroll) {
      (await wait(() => button('Cluster topology'))).click();
      (await wait(() => button('Diagram scope'))).click();
      (await wait(() => [...document.querySelectorAll('[role=option]')].find(option => option.innerText.startsWith('Namespace: perf ')))).click();
      await wait(() => document.querySelector('.react-flow__node-resource') && ![...document.querySelectorAll('[role=status]')].some(element => element.innerText.includes('Arranging')));
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (!scroll) {
      for (let index = 0; index < (config.zoom ?? 5); index++) {
        button('Zoom In')?.click(); button('Zoom in')?.click();
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      pane = document.querySelector('.react-flow__pane');
      const bounds = pane.getBoundingClientRect();
      start = { x: bounds.x + bounds.width * .4, y: bounds.y + bounds.height * .75 };
      before = document.querySelector('.react-flow__viewport').style.transform;
      pane.dispatchEvent(new MouseEvent('mousedown', { view: window, bubbles: true, button: 1, buttons: 4, clientX: start.x, clientY: start.y }));
    }
    const frames = []; let previous = performance.now(), index = 0;
    const frame = now => {
      frames.push(now - previous); previous = now;
      if (scroll) table.scrollTop = (Math.sin(index / 12) + 1) * (table.scrollHeight - table.clientHeight) / 2;
      else window.dispatchEvent(new MouseEvent('mousemove', { view: window, bubbles: true, button: 1, buttons: 4, clientX: start.x + Math.sin(index / 12) * 150, clientY: start.y + Math.cos(index / 12) * 70 }));
      if (++index < (config.frames ?? 180)) { requestAnimationFrame(frame); return; }
      if (!scroll) window.dispatchEvent(new MouseEvent('mouseup', { view: window, bubbles: true, button: 1, buttons: 0, clientX: start.x, clientY: start.y }));
      const sorted = [...frames].sort((a, b) => a - b), mean = frames.reduce((sum, value) => sum + value, 0) / frames.length;
      window.__kubikiFinish({
        mode: scroll ? 'table scroll' : 'topology pan',
        moved: scroll ? table.scrollTop > 0 : before !== document.querySelector('.react-flow__viewport').style.transform,
        nodes: document.querySelectorAll('.react-flow__node').length, edges: document.querySelectorAll('.react-flow__edge').length,
        meanFrameMs: mean, p95FrameMs: sorted[Math.floor(sorted.length * .95)], fps: 1000 / mean, over32ms: frames.filter(frame => frame > 32).length,
        frames: frames.length, devicePixelRatio, viewport: { width: innerWidth, height: innerHeight },
        transform: document.querySelector('.react-flow__viewport')?.style.transform,
      });
    };
    requestAnimationFrame(frame);
  } catch (error) { window.__kubikiFinish({ error: String(error) }); }
})();
