import gi, json, os, sys
from pathlib import Path
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib, Gdk

GLib.set_prgname('kubiki-render-benchmark')
# Manual, visible GTK benchmark; not part of the browser test suite.
# An optional JSON fixture can be supplied as the first argument; otherwise use the built-in synthetic fixture.
from topology_fixture import topology_fixture
lists = json.loads(Path(sys.argv[1]).read_text()) if len(sys.argv) > 1 else topology_fixture()
seed = '''(() => {
  const lists = LISTS;
  const original = window.fetch;
  window.fetch = function(input, options) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/k8s/')) return original.call(this, input, options);
    const data = url.pathname.endsWith('/helm/releases') ? {context:'test',namespace:'perf',offset:0,limit:100,has_more:false,items:[]} : url.pathname.endsWith('/contexts') ? [{name:'test',is_current:true}] : url.pathname.endsWith('/ping') ? {version:{gitVersion:'v1.34.0'}} : url.pathname.endsWith('/namespaces') ? ['perf'] : {items:lists[url.searchParams.get('kind')] || []};
    return Promise.resolve(new Response(JSON.stringify(data), {headers:{'Content-Type':'application/json'}}));
  };
})();'''.replace('LISTS', json.dumps(lists))
script = f'window.__kubikiBench = {json.dumps({"mode": os.environ.get("BENCH_MODE", "pan"), "zoom": int(os.environ.get("BENCH_ZOOM", "5")), "frames": int(os.environ.get("BENCH_FRAMES", "180"))})}; window.__kubikiFinish = data => window.webkit.messageHandlers.benchmark.postMessage(JSON.stringify(data));' + Path(__file__).with_name('native_pan.js').read_text()
manager=WebKit2.UserContentManager()
manager.add_script(WebKit2.UserScript.new(seed, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
manager.register_script_message_handler('benchmark')
window=Gtk.Window(title='Kubiki renderer benchmark (automatic)')
window.set_default_size(1280,800)
window.set_accept_focus(False)
window.set_focus_on_map(False)
window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
view=WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(),user_content_manager=manager)
finished = False
def finish(data):
    global finished
    if finished: return
    finished = True
    def complete():
        print(json.dumps({'dmabufDisabled':os.environ.get('WEBKIT_DISABLE_DMABUF_RENDERER','unset'),'explicitSyncDisabled':os.environ.get('__NV_DISABLE_EXPLICIT_SYNC','unset'),'webkit':f'{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}','gtkScale':view.get_scale_factor(),'hardwarePolicy':str(view.get_settings().get_hardware_acceleration_policy()),'result':data}),flush=True)
        window.destroy();Gtk.main_quit()
    path = os.environ.get('BENCH_SCREENSHOT')
    if path:
        def snapshot_ready(view, result, _):
            try: view.get_snapshot_finish(result).write_to_png(path)
            except Exception as error: data['snapshotError'] = str(error)
            complete()
        view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, snapshot_ready, None)
    else: complete()
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
