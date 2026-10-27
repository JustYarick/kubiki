#![cfg(unix)]
use kubiki_core::helm::reader::{HelmDocument, HelmReader};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    dir: PathBuf,
    program: PathBuf,
}
impl Fixture {
    fn new(body: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kubiki-helm-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        let program = dir.join("helm-fixture");
        fs::write(
            &program,
            format!("#!/usr/bin/env python3\nimport sys,json,time,os\na=sys.argv[1:]\n{body}\n"),
        )
        .unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        Self { dir, program }
    }
    fn reader(&self) -> HelmReader {
        HelmReader::new(self.program.clone())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn one_complete_snapshot_preserves_all_releases_and_scope() {
    let fixture = Fixture::new(
        r#"
assert a[0] == '--kube-context=prod $(literal); spaces'
assert 'list' in a and '--max=0' in a and not any(x.startswith('--offset') for x in a)
with open(__file__+'.calls','a') as f:f.write('storage snapshot\n')
assert '--namespace=backend' in a and '--all-namespaces' not in a
assert all(x in a for x in ['--deployed','--failed','--pending','--uninstalled','--uninstalling']) and '--superseded' not in a
print(json.dumps([dict(name='web-'+str(i), namespace='backend', revision='2', updated='now', status='failed', chart='web-1.0', app_version='1') for i in range(401)]))
"#,
    );
    let page = fixture
        .reader()
        .inventory("prod $(literal); spaces", Some("backend"))
        .await
        .unwrap();
    assert_eq!(page.len(), 401);
    assert_eq!(
        fs::read_to_string(fixture.program.with_extension("calls"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[tokio::test]
async fn empty_cluster_and_wrong_namespace_are_distinct() {
    let empty = Fixture::new("assert '--all-namespaces' in a\nprint('null')");
    let page = empty.reader().inventory("prod", None).await.unwrap();
    assert!(page.is_empty());
    let wrong = Fixture::new(
        r#"print(json.dumps([dict(name='web', namespace='other', revision='1', updated='', status='deployed', chart='web', app_version='1')]))"#,
    );
    assert_eq!(
        wrong
            .reader()
            .inventory("prod", Some("backend"))
            .await
            .unwrap_err()
            .status,
        Some(500)
    );
}

#[tokio::test]
async fn content_and_history_are_pinned_and_read_only() {
    let fixture = Fixture::new(
        r#"
assert a[0:2] == ['--kube-context=prod', '--namespace=backend']
assert not any(x in a for x in ['rollback','uninstall','upgrade','install','update','add'])
if 'history' in a:
    assert '--max=256' in a and 'web' in a
    print(json.dumps([dict(revision=2, updated='now', status='deployed', chart='web', app_version='1', description='Upgrade complete')]))
else:
    assert a[2:5] in [['get','values','web'], ['get','manifest','web'], ['get','notes','web']]
    assert '--revision=2' in a
    assert ('--output=yaml' in a) == ('values' in a)
    print('test document')
"#,
    );
    let reader = fixture.reader();
    assert_eq!(
        reader.history("prod", "backend", "web").await.unwrap()[0].revision,
        2
    );
    for document in [
        HelmDocument::Values,
        HelmDocument::Manifest,
        HelmDocument::Notes,
    ] {
        assert_eq!(
            reader
                .content("prod", "backend", "web", 2, document)
                .await
                .unwrap(),
            "test document\n"
        );
    }
}

#[tokio::test]
async fn repository_errors_never_look_like_an_empty_configuration() {
    let empty = Fixture::new(
        "assert a==['repo','list','--output=json']\nsys.stderr.write('Error: no repositories to show\\n')\nsys.exit(1)",
    );
    assert!(empty.reader().repositories().await.unwrap().is_empty());
    let failure = Fixture::new(
        "sys.stderr.write('Error: permission denied reading repositories.yaml')\nsys.exit(1)",
    );
    assert!(failure.reader().repositories().await.is_err());
    let malformed = Fixture::new("print('{broken json}')");
    assert_eq!(
        malformed.reader().repositories().await.unwrap_err().status,
        Some(500)
    );
}

#[tokio::test]
async fn missing_binary_bad_requests_and_rbac_are_visible() {
    let absent = HelmReader::new(PathBuf::from("/nonexistent/kubiki-test-helm"));
    assert_eq!(
        absent.inventory("prod", None).await.unwrap_err().status,
        Some(503)
    );
    assert_eq!(
        absent
            .content("prod", "backend", "--help", 1, HelmDocument::Values)
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    assert_eq!(
        absent
            .content("prod", "backend", "web", 0, HelmDocument::Values)
            .await
            .unwrap_err()
            .status,
        Some(400)
    );
    let forbidden = Fixture::new(
        "sys.stderr.write('Error: list: secrets is forbidden for user test')\nsys.exit(1)",
    );
    assert_eq!(
        forbidden
            .reader()
            .inventory("prod", None)
            .await
            .unwrap_err()
            .status,
        Some(403)
    );
}

#[tokio::test]
async fn oversized_output_is_bounded() {
    let fixture =
        Fixture::new("sys.stdout.write('x' * (8*1024*1024+1))\nsys.stdout.flush()\ntime.sleep(60)");
    let start = Instant::now();
    assert_eq!(
        fixture
            .reader()
            .content("prod", "backend", "web", 1, HelmDocument::Manifest)
            .await
            .unwrap_err()
            .status,
        Some(413)
    );
    assert!(start.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn stalled_process_times_out_and_is_killed() {
    let fixture = Fixture::new("open(__file__+'.pid','w').write(str(os.getpid()))\ntime.sleep(60)");
    let start = Instant::now();
    assert_eq!(
        fixture
            .reader()
            .with_read_timeout(Duration::from_millis(150))
            .inventory("prod", None)
            .await
            .unwrap_err()
            .status,
        Some(504)
    );
    assert!(start.elapsed() < Duration::from_secs(20));
    let pid: i32 = fs::read_to_string(fixture.program.with_extension("pid"))
        .unwrap()
        .parse()
        .unwrap();
    for _ in 0..100 {
        if unsafe { libc::kill(pid, 0) } != 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("Timed-out Helm child is still alive");
}

#[tokio::test]
async fn hook_documents_use_read_only_pinned_get() {
    let fixture = Fixture::new(
        r#"
assert a == ['--kube-context=prod', '--namespace=backend', 'get', 'hooks', 'web', '--revision=2']
print('apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: migrate')
"#,
    );
    let output = fixture
        .reader()
        .content("prod", "backend", "web", 2, HelmDocument::Hooks)
        .await
        .unwrap();
    assert!(output.contains("kind: Job"));
}

#[tokio::test]
async fn selected_kubeconfig_is_private_pinned_and_removed_with_reader() {
    use kubiki_core::cluster::kubeconfig::KubeConfigManager;
    let fixture = Fixture::new(
        r#"
path=a[a.index('--kubeconfig')+1]
config=open(path).read()
assert 'https://selected.example' in config and 'changed.example' not in config
assert os.path.join(os.path.dirname(__file__), 'ca.crt') in config
open(__file__+'.config-path','w').write(path)
print('[]')
"#,
    );
    let source = fixture.dir.join("selected.yaml");
    fs::write(&source, "apiVersion: v1\nkind: Config\nclusters:\n- name: selected\n  cluster:\n    server: https://selected.example\n    certificate-authority: ca.crt\ncontexts:\n- name: prod\n  context:\n    cluster: selected\nusers: []\n").unwrap();
    let manager = KubeConfigManager::with_custom_path(source.clone());
    let reader = fixture.reader().with_config_manager(&manager).unwrap();
    fs::write(source, "changed.example").unwrap();
    reader.inventory("prod", None).await.unwrap();
    let path =
        PathBuf::from(fs::read_to_string(fixture.program.with_extension("config-path")).unwrap());
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    drop(reader);
    assert!(!path.exists());
}
