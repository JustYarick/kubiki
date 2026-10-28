#![cfg(unix)]
use kubiki_core::cluster::kubeconfig::KubeConfigManager;
use kubiki_core::helm::{
    mutations::{HelmMutation, PreparedHelmMutation},
    reader::HelmReader,
};
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    dir: PathBuf,
    program: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "kubiki-helm-write-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("chart.tgz"), "frozen chart").unwrap();
        fs::write(dir.join("repos.yaml"), "original configuration").unwrap();
        fs::write(dir.join("selected.yaml"), "apiVersion: v1\nkind: Config\nclusters:\n- name: selected\n  cluster:\n    server: https://selected.example\ncontexts:\n- name: prod\n  context:\n    cluster: selected\nusers: []\n").unwrap();
        let manifest = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: web\n  namespace: backend\ndata:\n  key: old\n";
        fs::write(dir.join("state.json"),serde_json::to_vec(&json!({"name":"web","namespace":"backend","version":2,"info":{"status":"deployed"},"manifest":manifest,"config":{"key":"old"},"hooks":[]})).unwrap()).unwrap();
        let program = dir.join("helm");
        fs::write(&program,r##"#!/usr/bin/env python3
import sys,json,os
from pathlib import Path
d=Path(__file__).parent;a=sys.argv[1:]
assert '--kubeconfig' in a
assert 'https://selected.example' in Path(a[a.index('--kubeconfig')+1]).read_text()
with open(d/'calls','a') as f:f.write(json.dumps(a)+'\n')
state=json.loads((d/'state.json').read_text())
if 'status' in a:
 if (d/'absent').exists():sys.stderr.write('Error: release: not found');sys.exit(1)
 revision=next((int(x.split('=')[1]) for x in a if x.startswith('--revision=')),None)
 if revision:state['version']=revision;state['manifest']=state['manifest'].replace('old','previous')
 print(json.dumps(state))
elif a[0]=='show':print('apiVersion: v2\nname: web\nversion: 1.0.0' if a[1]=='chart' else '')
elif a[0]=='env':print('HELM_REPOSITORY_CONFIG='+json.dumps(str(d/'repos.yaml')))
elif a[0:2]==['repo','list']:print(json.dumps([dict(name='demo',url='https://old.example/charts')]))
elif any(x in a for x in ['install','upgrade','rollback','uninstall']) or a[0]=='repo':
 if '--dry-run=server' in a:
  state['manifest']=state['manifest'].replace('old','new');state['config']={'key':'new'}
  if (d/'drift').exists():
   count=int((d/'dry-count').read_text()) if (d/'dry-count').exists() else 0
   (d/'dry-count').write_text(str(count+1));state['manifest']+=f'\n# render {count}\n'
  print(json.dumps(state))
 else:
  (d/'writes').write_text('written')
  if (d/'fail-write').exists():sys.stderr.write('failure with secret-value-must-not-leak');sys.exit(1)
  print('{}')
else:sys.stderr.write('Unexpected command');sys.exit(1)
"##).unwrap();
        fs::set_permissions(&program, fs::Permissions::from_mode(0o700)).unwrap();
        Self { dir, program }
    }
    fn request(&self, operation: &str) -> HelmMutation {
        let base = json!({"operation":operation,"context":"prod","namespace":"backend","name":"web","expected_revision":2,"run_hooks":false,"wait":true,"chart":self.dir.join("chart.tgz").to_str().unwrap(),"chart_version":null,"values":"key: new\n","create_namespace":false,"revision":1,"keep_history":false});
        let keys = match operation {
            "install" => vec![
                "operation",
                "context",
                "namespace",
                "name",
                "chart",
                "chart_version",
                "values",
                "create_namespace",
                "run_hooks",
                "wait",
            ],
            "upgrade" => vec![
                "operation",
                "context",
                "namespace",
                "name",
                "expected_revision",
                "chart",
                "chart_version",
                "values",
                "run_hooks",
                "wait",
            ],
            "rollback" => vec![
                "operation",
                "context",
                "namespace",
                "name",
                "expected_revision",
                "revision",
                "run_hooks",
                "wait",
            ],
            _ => vec![
                "operation",
                "context",
                "namespace",
                "name",
                "expected_revision",
                "keep_history",
                "run_hooks",
            ],
        };
        serde_json::from_value(Value::Object(
            keys.into_iter()
                .map(|key| (key.into(), base[key].clone()))
                .collect(),
        ))
        .unwrap()
    }
    async fn prepare(&self, request: HelmMutation) -> PreparedHelmMutation {
        let manager = KubeConfigManager::with_custom_path(self.dir.join("selected.yaml"));
        let reader = HelmReader::new(self.program.clone())
            .with_config_manager(&manager)
            .unwrap();
        PreparedHelmMutation::prepare(reader, request)
            .await
            .unwrap()
    }
    fn wrote(&self) -> bool {
        self.dir.join("writes").exists()
    }
    fn change_revision(&self) {
        let mut value: Value =
            serde_json::from_slice(&fs::read(self.dir.join("state.json")).unwrap()).unwrap();
        value["version"] = json!(3);
        fs::write(
            self.dir.join("state.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

#[tokio::test]
async fn preview_cancel_and_upgrade_consent_own_the_exact_payload() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare(fixture.request("upgrade")).await;
    assert!(
        prepared
            .review()
            .contains("UPDATE v1/ConfigMap/backend/web")
    );
    assert!(prepared.review().contains("BEFORE \"old\" → AFTER \"new\""));
    assert!(!prepared.review().contains("/data/key"));
    assert!(!fixture.wrote());
    assert_eq!(
        prepared
            .confirm_and_commit(|_| async { Ok(false) })
            .await
            .unwrap_err()
            .code,
        kubiki_core::core::api::ApiErrorCode::Cancelled
    );
    assert!(!fixture.wrote());
    let prepared = fixture.prepare(fixture.request("upgrade")).await;
    prepared
        .confirm_and_commit(|_| async {
            assert!(!fixture.wrote());
            // Changing the application's source file while consent is open must not
            // redirect post-consent verification or execution to another cluster.
            fs::write(fixture.dir.join("selected.yaml"), "changed.example").unwrap();
            Ok(true)
        })
        .await
        .unwrap();
    assert!(fixture.wrote());
    let calls = fs::read_to_string(fixture.dir.join("calls")).unwrap();
    assert!(calls.contains("--kube-context=prod"));
    assert!(calls.contains("--reset-values"));
    assert!(calls.contains("--no-hooks"));
}
#[tokio::test]
async fn install_rollback_and_uninstall_only_write_after_consent() {
    for op in ["install", "rollback", "uninstall"] {
        let fixture = Fixture::new();
        if op == "install" {
            fs::write(fixture.dir.join("absent"), "").unwrap();
        }
        let prepared = fixture.prepare(fixture.request(op)).await;
        assert!(!fixture.wrote());
        assert!(prepared.review().contains(&op.to_uppercase()));
        prepared
            .confirm_and_commit(|_| async { Ok(true) })
            .await
            .unwrap();
        assert!(fixture.wrote());
    }
}
#[tokio::test]
async fn changed_release_and_changed_frozen_chart_are_rejected() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare(fixture.request("upgrade")).await;
    let failure = prepared
        .confirm_and_commit(|_| async {
            fixture.change_revision();
            Ok(true)
        })
        .await
        .unwrap_err();
    assert_eq!(failure.status, Some(409));
    assert!(!fixture.wrote());
    let fixture = Fixture::new();
    let prepared = fixture.prepare(fixture.request("upgrade")).await;
    let calls = fs::read_to_string(fixture.dir.join("calls")).unwrap();
    let argv: Vec<String> = serde_json::from_str(
        calls
            .lines()
            .find(|line| line.contains("--dry-run=server"))
            .unwrap(),
    )
    .unwrap();
    let archive = argv.iter().find(|arg| arg.ends_with("chart.tgz")).unwrap();
    let failure = prepared
        .confirm_and_commit(|_| async {
            fs::write(archive, "changed archive").unwrap();
            Ok(true)
        })
        .await
        .unwrap_err();
    assert_eq!(failure.status, Some(409));
    assert!(!fixture.wrote());
}
#[tokio::test]
async fn nondeterministic_render_and_uncertain_writes_do_not_retry_or_leak_payloads() {
    let fixture = Fixture::new();
    fs::write(fixture.dir.join("drift"), "").unwrap();
    let prepared = fixture.prepare(fixture.request("upgrade")).await;
    assert_eq!(
        prepared
            .confirm_and_commit(|_| async { Ok(true) })
            .await
            .unwrap_err()
            .status,
        Some(409)
    );
    assert!(!fixture.wrote());
    let fixture = Fixture::new();
    fs::write(fixture.dir.join("fail-write"), "").unwrap();
    let prepared = fixture.prepare(fixture.request("uninstall")).await;
    let error = prepared
        .confirm_and_commit(|_| async { Ok(true) })
        .await
        .unwrap_err();
    assert!(!error.retryable);
    assert!(!error.message.contains("secret-value"));
    let calls = fs::read_to_string(fixture.dir.join("calls")).unwrap();
    assert_eq!(
        calls
            .lines()
            .filter(|line| line.contains("uninstall"))
            .count(),
        1
    );
}
#[tokio::test]
async fn repository_crud_and_cache_update_use_exact_config_snapshot() {
    for value in [
        json!({"operation":"repository_set","name":"new","url":"https://new.example/charts","previous_url":null}),
        json!({"operation":"repository_set","name":"demo","url":"https://new.example/charts","previous_url":"https://old.example/charts"}),
        json!({"operation":"repository_remove","name":"demo","expected_url":"https://old.example/charts"}),
        json!({"operation":"repository_update","name":null}),
    ] {
        let fixture = Fixture::new();
        let prepared = fixture
            .prepare(serde_json::from_value(value).unwrap())
            .await;
        assert!(!fixture.wrote());
        prepared
            .confirm_and_commit(|_| async { Ok(true) })
            .await
            .unwrap();
        assert!(fixture.wrote());
    }
    let fixture = Fixture::new();
    let prepared = fixture
        .prepare(
            serde_json::from_value(json!({"operation":"repository_update","name":null})).unwrap(),
        )
        .await;
    let failure = prepared
        .confirm_and_commit(|_| async {
            fs::write(fixture.dir.join("repos.yaml"), "changed").unwrap();
            Ok(true)
        })
        .await
        .unwrap_err();
    assert_eq!(failure.status, Some(409));
    assert!(!fixture.wrote());
}
#[test]
fn renderer_cannot_forge_approval_or_arbitrary_commands() {
    assert!(
        serde_json::from_value::<HelmMutation>(
            json!({"operation":"repository_update","name":null,"confirmed":true})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<HelmMutation>(json!({"operation":"exec","args":["delete"]}))
            .is_err()
    );
}
