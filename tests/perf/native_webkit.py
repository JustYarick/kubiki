import gi, json, os, sys
from pathlib import Path
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib, Gdk

GLib.set_prgname('kubiki-render-benchmark')
# Manual, visible GTK benchmark; not part of the browser test suite.
# An optional JSON fixture can be supplied as the first argument; otherwise use the built-in synthetic fixture.
lists = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 else {
    'Namespace': [{'metadata': {'uid': 'ns', 'name': 'perf'}}], 'Pod': [], 'Service': [], 'Node': [], 'ReplicaSet': [], 'Deployment': [], 'ConfigMap': []}
if len(sys.argv) == 1:
    for index in range(8):
        lists['Node'].append({'metadata': {'uid': f'node-{index}', 'name': f'worker-{index}'}})
    for index in range(10):
        meta = {'name': f'web-{index}', 'namespace': 'perf', 'uid': f'dep-{index}'}
        lists['Deployment'].append({'metadata': meta, 'spec': {'replicas': 18}, 'status': {'readyReplicas': 18}})
        lists['ReplicaSet'].append({'metadata': {'uid': f'rs-{index}', 'name': f'web-{index}-rs', 'namespace': 'perf', 'ownerReferences': [{'uid': f'dep-{index}', 'kind': 'Deployment', 'name': f'web-{index}'}]}, 'spec': {'replicas': 18}, 'status': {'readyReplicas': 18}})
        lists['Service'].append({'metadata': {'uid': f'svc-{index}', 'name': f'service-{index}', 'namespace': 'perf'}, 'spec': {'selector': {'app': f'web-{index}'}}})
        lists['ConfigMap'].append({'metadata': {'uid': f'config-{index}', 'name': f'config-{index}', 'namespace': 'perf'}})
    for index in range(180):
        lists['Pod'].append({'metadata': {'uid': f'pod-{index}', 'name': f'pod-{index}', 'namespace': 'perf', 'labels': {'app': f'web-{index % 10}'}, 'ownerReferences': [{'uid': f'rs-{index % 10}', 'kind': 'ReplicaSet', 'name': f'web-{index % 10}-rs'}]}, 'spec': {'nodeName': f'worker-{index % 8}', 'containers': [{'name': 'app'}], 'volumes': [{'name': 'config', 'configMap': {'name': f'config-{index % 10}'}}]}, 'status': {'phase': 'Running', 'containerStatuses': [{'name': 'app', 'ready': True, 'state': {'running': {}}}]}})
seed = '''(() => {
  const lists = LISTS;
  const original = window.fetch;
  window.fetch = function(input, options) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/k8s/')) return original.call(this, input, options);
    const data = url.pathname.endsWith('/contexts') ? [{name:'test',is_current:true}] : url.pathname.endsWith('/ping') ? {version:{gitVersion:'v1.34.0'}} : url.pathname.endsWith('/namespaces') ? ['perf'] : {items:lists[url.searchParams.get('kind')] || []};
    return Promise.resolve(new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}}));
  };
})();'''.replace('LISTS', json.dumps(lists))
script = '''(async () => {
  const wait = async (fn) => { for(let i=0;i<600;i++){ const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,50)); }throw new Error('UI timed out: '+document.body.innerText.slice(-1000)); };
  const button = (name) => [...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===name || b.innerText===name);
  try {
    await wait(()=>document.querySelector('[data-testid=resource-table]')?.innerText.includes('pod-0'));
    (await wait(()=>button('Cluster topology'))).click();
    (await wait(()=>button('Diagram scope'))).click();
    (await wait(()=>[...document.querySelectorAll('[role=option]')].find(b=>b.innerText.startsWith('Namespace: perf ')))).click();
    await wait(()=>document.querySelector('.react-flow__node-resource') && ![...document.querySelectorAll('[role=status]')].some(e=>e.innerText.includes('Arranging')));
    await new Promise(r=>setTimeout(r,1000));
    for(let i=0;i<5;i++){button('Zoom In')?.click();button('Zoom in')?.click();await new Promise(r=>setTimeout(r,100));}
    const pane=document.querySelector('.react-flow__pane'), bounds=pane.getBoundingClientRect();
    const start={x:bounds.x+bounds.width*.4,y:bounds.y+bounds.height*.75};
    const before=document.querySelector('.react-flow__viewport').style.transform;
    pane.dispatchEvent(new MouseEvent('mousedown',{view:window,bubbles:true,button:1,buttons:4,clientX:start.x,clientY:start.y}));
    const frames=[];let previous=performance.now();let i=0;
    const frame=(now)=>{
      frames.push(now-previous);previous=now;
      window.dispatchEvent(new MouseEvent('mousemove',{view:window,bubbles:true,button:1,buttons:4,clientX:start.x+Math.sin(i/12)*150,clientY:start.y+Math.cos(i/12)*70}));
      if(++i<180){requestAnimationFrame(frame);return;}
      window.dispatchEvent(new MouseEvent('mouseup',{view:window,bubbles:true,button:1,buttons:0,clientX:start.x,clientY:start.y}));
      const sorted=[...frames].sort((a,b)=>a-b), mean=frames.reduce((a,b)=>a+b,0)/frames.length;
      window.webkit.messageHandlers.benchmark.postMessage(JSON.stringify({moved:before!==document.querySelector('.react-flow__viewport').style.transform,nodes:document.querySelectorAll('.react-flow__node').length,edges:document.querySelectorAll('.react-flow__edge').length,canvas:document.querySelector('[data-testid=topology-connections]')?.dataset.drawnEdges,meanFrameMs:mean,p95FrameMs:sorted[Math.floor(sorted.length*.95)],fps:1000/mean,over32ms:frames.filter(f=>f>32).length,frames:frames.length}));
    };requestAnimationFrame(frame);
  }catch(error){window.webkit.messageHandlers.benchmark.postMessage(JSON.stringify({error:String(error)}));}
})();'''
manager=WebKit2.UserContentManager()
manager.add_script(WebKit2.UserScript.new(seed, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
manager.register_script_message_handler('benchmark')
window=Gtk.Window(title='Kubiki renderer benchmark (automatic)')
window.set_default_size(1280,800)
window.set_accept_focus(False)
window.set_focus_on_map(False)
window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
view=WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(),user_content_manager=manager)
def finish(data):
    print(json.dumps({'dmabufDisabled':os.environ.get('WEBKIT_DISABLE_DMABUF_RENDERER','unset'),'webkit':f'{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}','result':data}),flush=True)
    window.destroy();Gtk.main_quit()
def message(manager,result): finish(json.loads(result.get_js_value().to_string()))
manager.connect('script-message-received::benchmark',message)
def loaded(view,event):
    if event==WebKit2.LoadEvent.FINISHED: view.evaluate_javascript(script,-1,None,None,None,None,None)
view.connect('load-changed',loaded)
view.connect('web-process-terminated',lambda *args:finish({'error':'WebKit terminated'}))
window.add(view);window.show_all()
view.load_uri(os.environ.get('BENCH_URL','http://127.0.0.1:1422'))
GLib.timeout_add_seconds(45,lambda:finish({'error':'native benchmark timeout'}) or False)
Gtk.main()
