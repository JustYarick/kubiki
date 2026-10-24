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
  const button = (name, root = document) => [...root.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === name || button.innerText === name);
  try {
    // Opening a workspace tab before the initial context is resolved pins it to "unknown".
    await wait(() => document.querySelector('.app-statusbar')?.textContent.includes('Pods: 180/180'));
    const scroll = config.mode === 'scroll';
    let table;
    let pane, start, before;
    if (scroll) {
      button('Expand All')?.click();
      (await wait(() => [...document.querySelectorAll('[data-testid=explorer-panel] button')].find(element => /^Pods(?:\s+\d+)?$/.test(element.innerText.trim())))).click();
      table = await wait(() => document.querySelector('[data-testid=resource-table]')?.innerText.includes('pod-0') && document.querySelector('[data-testid=resource-table]'));
    } else {
      (await wait(() => button('Cluster topology'))).click();
      (await wait(() => {
        const actions = document.querySelector('.topology-scope-actions');
        return actions && button('All Namespaces', actions);
      })).click();
      await wait(() => document.querySelector('.react-flow__node-resource') && ![...document.querySelectorAll('[role=status]')].some(element => element.innerText.includes('Arranging')));
      const settings = await wait(() => button('Diagram settings'));
      if (settings.getAttribute('aria-expanded') !== 'true') settings.click();
      (await wait(() => button('Show all'))).click();
      settings.click();
    }
    await document.fonts.ready;
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
    }
    if (config.variant && config.variant !== 'default') {
      const style = document.createElement('style');
      style.textContent = config.variant === 'flat' ? '.topology-node { box-shadow: none !important; }' : config.variant === 'no-labels' ? '.topology-edge-control { display: none !important; }' : '';
      document.head.append(style);
    }
    // rAF measures JS scheduling, not physical presentation or end-to-end input latency.
    const idleFrames = [];
    await new Promise(resolve => {
      let previous;
      const idle = now => {
        if (previous !== undefined) idleFrames.push(now - previous);
        previous = now;
        if (idleFrames.length < 60) requestAnimationFrame(idle); else resolve();
      };
      requestAnimationFrame(idle);
    });
    if (!scroll) pane.dispatchEvent(new MouseEvent('mousedown', { view: window, bubbles: true, button: 1, buttons: 4, clientX: start.x, clientY: start.y }));
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
        variant: config.variant ?? 'default', idleMeanFrameMs: idleFrames.reduce((sum, value) => sum + value, 0) / idleFrames.length,
        userAgent: navigator.userAgent, visibility: document.visibilityState,
        visualViewportScale: window.visualViewport?.scale,
        uiScale: document.documentElement.dataset.uiScale,
        graphUiFactor: document.querySelector('.react-flow__viewport') ? getComputedStyle(document.querySelector('.react-flow__viewport')).getPropertyValue('--ui-factor').trim() : null,
        domElements: document.querySelectorAll('*').length,
        labels: document.querySelectorAll('.topology-edge-control').length,
        fontFamily: getComputedStyle(document.body).fontFamily,
        measurement: 'requestAnimationFrame scheduling under synthetic DOM mouse events; not presented-frame FPS',
      });
    };
    requestAnimationFrame(frame);
  } catch (error) { window.__kubikiFinish({ error: String(error) }); }
})();
