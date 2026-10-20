# Спецификация и API ядра Kubiki Core

> Аудит 2026-10-20: наличие API и успешных unit tests не подтверждает полноту или готовность к production. Открытые риски watch/exec/PF/Helm и объём тестов: [08-UX-TECHNICAL-AUDIT.md](08-UX-TECHNICAL-AUDIT.md).


> **Крейт:** `crates/kubiki-core`  
> **Статус:** headless-сервисы реализованы частично; live integration и production QA не завершены
> **Язык:** Чистый Rust 2024 (Tokio, kube-rs, k8s-openapi, portable-pty)

---

## 1. Архитектура ядра

`kubiki-core` спроектирован по принципам Clean Architecture без каких-либо графических библиотек (полный headless). Он предоставляет универсальный API для построения любого интерфейса (десктопного, TUI, веб-сервиса или CLI).

```
crates/kubiki-core/
├── src/
│   ├── lib.rs                  # Главный фасад со всеми реэкспортами
│   ├── bin/
│   │   └── kubiki-cli.rs       # CLI инструмент для прямого запуска из терминала
│   ├── core/
│   │   ├── error.rs            # Типизированный KubikiError (thiserror + serde)
│   │   └── events.rs           # EventBus на базе tokio::sync::broadcast
│   ├── cluster/
│   │   ├── kubeconfig.rs       # KubeConfigManager: парсер ~/.kube/config, список контекстов
│   │   ├── client.rs           # ClusterClientPool: пул соединений kube::Client + healthcheck
│   │   └── namespaces.rs       # NamespaceService: листинг неймспейсов и can-i RBAC проверки
│   ├── informer/
│   │   ├── delta.rs            # Модели ResourceDelta (Applied, Deleted, Restarted)
│   │   ├── store.rs            # In-memory нормализованный кэш ResourceStore
│   │   └── watcher.rs          # InformerManager: стриминг событий K8s Watch Streams
│   ├── pod_ops/
│   │   ├── logs.rs             # PodLogService: стриминг логов с follow, tail, контейнерами
│   │   ├── exec.rs             # PodExecService: интерактивный WebSocket шелл в контейнере
│   │   └── port_forward.rs     # PortForwardManager: локальные TCP сокеты + статистика
│   ├── crd/
│   │   ├── discovery.rs        # CrdDiscoveryService: список CRD и additionalPrinterColumns
│   │   └── dynamic_client.rs   # DynamicCrdService: динамические запросы через DynamicObject
│   ├── helm/
│   │   ├── model.rs            # Модели HelmRelease, HelmRepo, HelmHistory
│   │   └── client.rs           # HelmClient: list, history, rollback, repo add/update, values
│   └── metrics/
│       └── client.rs           # MetricsService: сбор метрик NodeMetrics и PodMetrics
└── tests/
    └── engine_tests.rs         # Интеграционные тесты хранилища, шины и моделей
```

---

## 2. Ключевые сервисы и примеры использования

### 2.1. Управление контекстами Kubeconfig

```rust
use kubiki_core::KubeConfigManager;

let mgr = KubeConfigManager::new();
let contexts = mgr.list_contexts()?;
for ctx in contexts {
    println!("Context: {} (current: {})", ctx.name, ctx.is_current);
}
```

### 2.2. Пул клиентов и проверка подключения

```rust
use kubiki_core::{ClusterClientPool, KubeConfigManager};

let config_mgr = KubeConfigManager::new();
let pool = ClusterClientPool::new(config_mgr);

let client = pool.get_client("minikube").await?;
let health = pool.check_health("minikube").await?;
println!("K8s version: {}", health.git_version);
```

### 2.3. Event-Driven Informer и Watch Streams

```rust
use kubiki_core::{InformerManager, ResourceStore};
use kubiki_core::core::api::ResourceQuery;

let store = ResourceStore::new();
let informers = InformerManager::new(store.clone());
let query = ResourceQuery {
    context: "minikube".into(), group: "".into(), version: "v1".into(),
    kind: "Pod".into(), namespace: Some("default".into()),
};
// client: kube::Client, созданный для того же context.
let mut rx = informers.start_watch("cli", "pods", query, async move { Ok(client) }).await?;
while let Some(message) = rx.recv().await {
    println!("Watch message: {:?}", message);
    // Завершить цикл по сигналу приложения, затем обязательно stop_watch.
}
informers.stop_watch("cli", "pods").await;
```

API изменён в DATA-02/03A: generic `start_watch::<Pod>` и глобальный broadcast заменены ResourceQuery и отдельной bounded очередью подписки. `ResourceStore::snapshot(&WatchScope)` возвращает `None` до первого полного списка и `Some([])` для успешно синхронизированного пустого scope. `Restarted` атомарно заменяет только эту область; InitApply остаётся внутри буфера. `stop_watch`/`stop_owner` отменяют задачу и удаляют cache scope. Получатель и registry должны освобождаться явно; drop manager отменяет фоновые задачи. Протокол, таймауты, transport и ограничения — [12](12-DATA-CONTRACT-AND-APPEARANCE.md).


### 2.4. Стриминг логов подов

```rust
use kubiki_core::{PodLogOptions, PodLogService};
use futures::StreamExt;

let opts = PodLogOptions {
    follow: true,
    tail_lines: Some(100),
    timestamps: true,
    ..Default::default()
};

let mut stream = PodLogService::get_log_stream(client, "default", "my-pod", opts).await?;
while let Some(line_res) = stream.next().await {
    if let Ok(line) = line_res {
        println!("{line}");
    }
}
```

### 2.5. Проброс портов (Port Forwarding Manager)

```rust
use kubiki_core::PortForwardManager;

let pfm = PortForwardManager::new();

// Открыть локальный порт на 127.0.0.1 (0 = автовыбор свободного порта)
let session = pfm.start_pod_forward(client, "default", "nginx-pod", 80, Some(8080)).await?;
println!("Tunnel active on http://127.0.0.1:{}", session.local_port);

// Остановка туннеля
pfm.stop_forward(&session.id).await?;
```

### 2.6. Helm 3 Package Manager

```rust
use kubiki_core::HelmClient;

// Список установленных релизов
let releases = HelmClient::list_releases(Some("all")).await?;

// Откат на ревизию 1
HelmClient::rollback("my-release", 1, "default").await?;
```

---

## 3. Запуск CLI инструмента `kubiki-cli`

Для прямой работы с движком без написания кода доступен CLI инструмент:

```bash
# Список всех контекстов
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- contexts

# Текущий контекст
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- current-context

# Проверка соединения и версия K8s
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- ping

# Список пространств имен
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- namespaces

# Обнаружение всех CRD и дополнительных колонок
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- crds

# Метрики CPU/Memory нод и подов
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- metrics

# Список релизов Helm 3
cargo run --manifest-path crates/kubiki-core/Cargo.toml --bin kubiki-cli -- helm-releases
```

---

## 4. Инструкция для следующего ИИ-агента

Если следующий ИИ-агент будет создавать интерфейс (TUI на `ratatui`, нативный GUI на `iced` / `gpui`, или десктопный UI):
- Добавить в зависимости своего интерфейса: `kubiki-core = { path = "../crates/kubiki-core" }`
- Проверить конкретный сервис по коду и live integration tests; не считать наличие API подтверждением полной готовности. См. аудит 08 и status report 09.
