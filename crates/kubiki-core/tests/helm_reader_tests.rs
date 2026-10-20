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
async fn pages_all_statuses_with_literal_context_and_namespace() {
    let fixture = Fixture::new(
        r#"
assert a[0] == '--kube-context=prod $(literal); spaces'
assert 'list' in a and '--offset=100' in a and '--max=101' in a
assert '--namespace=backend' in a and '--all-namespaces' not in a
assert all(x in a for x in ['--deployed','--failed','--pending','--uninstalled','--superseded','--uninstalling'])
print(json.dumps([dict(name='web-'+str(i), namespace='backend', revision='2', updated='now', status='failed', chart='web-1.0', app_version='1') for i in range(101)]))
"#,
    );
    let page = fixture
        .reader()
        .releases("prod $(literal); spaces", Some("backend"), 100)
        .await
        .unwrap();
    assert_eq!(page.context, "prod $(literal); spaces");
    assert_eq!(page.offset, 100);
    assert_eq!(page.items.len(), 100);
    assert!(page.has_more);
}

#[tokio::test]
async fn empty_cluster_and_wrong_namespace_are_distinct() {
    let empty = Fixture::new("assert '--all-namespaces' in a\nprint('null')");
    let page = empty.reader().releases("prod", None, 0).await.unwrap();
    assert!(page.items.is_empty() && !page.has_more);
    let wrong = Fixture::new(
        r#"print(json.dumps([dict(name='web', namespace='other', revision='1', updated='', status='deployed', chart='web', app_version='1')]))"#,
    );
    assert_eq!(
        wrong
            .reader()
            .releases("prod", Some("backend"), 0)
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
        absent.releases("prod", None, 0).await.unwrap_err().status,
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
            .releases("prod", None, 0)
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
            .releases("prod", None, 0)
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
