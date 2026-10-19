# Архитектура и системное проектирование Kubiki

> **Проект:** Kubiki — Event-Driven, Serverless K8s Desktop IDE  
> **Стек:** Tauri v2 (Rust) + React 19 / TypeScript 5 + Tailwind CSS v4 + Monaco Editor + xterm.js  
> **Дизайн-код:** JetBrains IDE (Fleet / New UI) + VS Code (Dark+/Modern)

---

## 1. Концепция и архитектурные принципы

Kubiki строится как **local-first, serverless desktop IDE** для работы с кластерами Kubernetes. Приложение не требует установки серверных компонентов (in-cluster agents) и работает исключительно через локальный `kubeconfig`, полностью наследуя пользовательские права RBAC.

### Фундаментальные принципы
1. **Zero Electron Overhead:** Использование системного WebView через Tauri v2 и асинхронного runtime Tokio на Rust снижает потребление RAM в 10–15 раз (30–60 МБ в idle).
2. **Event-Driven Reactive Core:** Никакого активного polling API. Real-time состояние кластера формируется через K8s Watch Streams и Informer Cache на стороне Rust и транслируется во фронтенд через типизированную шину событий.
3. **Clean Architecture & Separation of Concerns:**
   - **Rust Backend:** Управление соединениями, K8s informers/reflectors, PTY-процессы, TCP port-forwarding, Helm engine, кэширование, шифрование secrets.
   - **Frontend UI:** Рендеринг, раскладка окон (docking), виртуализированные списки, Monaco Editor, xterm.js, визуализация метрик.
4. **JetBrains / VS Code Ergonomics:**
   - Строгая панельная сетка (Activity Bar слева, collapsible Tool Windows, нижний Dock с вкладками терминалов/логов, правый Inspector).
   - Топовая поддержка горячих клавиш (Command Palette `Cmd+P` / `Cmd+Shift+P`, Quick Switcher `Cmd+K`).
   - Глубокая кастомизация (темы, хоткеи, раскладки).

---

## 2. Общая схема системы

```mermaid
graph TD
    subgraph UI ["Frontend (React 19 + TypeScript)"]
        UI_Store["Zustand Reactive Store"]
        UI_Layout["Dockview / Mosaic Layout"]
        UI_Tree["K8s Resource Navigator (Tree)"]
        UI_Table["Virtualized Table (TanStack)"]
        UI_Monaco["Monaco Editor (YAML / CRD Schemas)"]
        UI_Terminal["xterm.js Terminal & Log Streamer"]
        UI_Palette["Command Palette / Action Engine"]
    end

    subgraph IPC ["Tauri v2 IPC Bridge (Type-safe via Specta)"]
        IPC_Cmd["Commands (Async invoke: CRUD, Exec, Helm)"]
        IPC_Events["Event Bus (Push: Watches, PTY data, Logs, Metrics)"]
    end

    subgraph Core ["Rust Backend (Tokio Runtime)"]
        subgraph K8s_Engine ["K8s Engine (kube-rs)"]
            ClusterMgr["Cluster & Kubeconfig Manager"]
            InformerPool["Informer & Reflector Store (In-Memory Cache)"]
            WatchStreamer["Event Stream Multiplexer"]
            ExecHandler["Pod Exec / Attach (WebSocket)"]
            PortForwarder["TCP Port-Forwarding Tunnel Manager"]
            LogStreamer["Log Tail / Follow Engine"]
        end

        subgraph PTY_Engine ["Terminal Engine"]
            PTYMgr["portable-pty Session Pool"]
        end

        subgraph Helm_Engine ["Helm Engine"]
            HelmCLI["Helm Driver (helm binary wrapper / client)"]
        end

        subgraph Plugin_Host ["Extension Engine (Foundation)"]
            ExtHost["Plugin Manifest & Hook Dispatcher"]
        end
    end

    subgraph External ["External Environment"]
        K8s_API["Kubernetes API Servers (Multi-cluster)"]
        Local_Kubeconfig["~/.kube/config & Cloud Auth Helpers"]
        Local_Shell["OS Shell (bash / zsh / pwsh)"]
        Prometheus["Prometheus / Metrics Server"]
    end

    UI_Store <--> IPC_Events
    UI_Table & UI_Monaco & UI_Terminal <--> IPC_Cmd
    IPC_Cmd <--> ClusterMgr & ExecHandler & PortForwarder & PTYMgr & HelmCLI
    IPC_Events <-- WatchStreamer & LogStreamer & PTYMgr

    ClusterMgr <--> Local_Kubeconfig
    InformerPool & WatchStreamer & ExecHandler & PortForwarder & LogStreamer <--> K8s_API
    PTYMgr <--> Local_Shell
    InformerPool <--> Prometheus
```

---

## 3. Архитектура Rust Backend

### 3.1. Структура крейтов и модулей (Clean Architecture)

```
src-tauri/
├── Cargo.toml
├── tauri.conf.json
├── src/
│   ├── main.rs                   # Точка входа Tauri
│   ├── lib.rs                    # Инициализация плагинов и модулей
│   │
│   ├── core/                     # Ядро и бизнес-логика (не зависит от Tauri IPC)
│   │   ├── error.rs              # Единая типизированная иерархия ошибок (thiserror)
│   │   ├── events.rs             # Event types и внутренний Event Bus (tokio::sync::broadcast)
│   │   └── config.rs             # Настройки приложения, кэш, профили
│   │
│   ├── cluster/                  # Домен кластеров Kubernetes
│   │   ├── kubeconfig.rs         # Парсер и watcher файлов ~/.kube/config
│   │   ├── context.rs            # Менеджер активных контекстов и аутентификации
│   │   ├── client.rs             # Фабрика kube::Client с пулом соединений
│   │   └── auth_helpers.rs       # Поддержка AWS IAM, GKE, AKS, OIDC exec plugins
│   │
│   ├── informer/                 # Event-Driven кэш K8s объектов
│   │   ├── store.rs              # In-memory хранилище состояния ресурсов кластера
│   │   ├── reflector.rs          # Обёртки над kube_runtime::reflector
│   │   └── manager.rs            # Управление жизненным циклом watchers по неймспейсам
│   │
│   ├── pod_ops/                  # Операции реального времени над Pods
│   │   ├── logs.rs               # Асинхронный стриминг логов с backpressure
│   │   ├── exec.rs               # WebSocket терминал внутри контейнера (kube exec)
│   │   └── port_forward.rs       # TCP socket tunneling на локальные порты
│   │
│   ├── helm/                     # Helm package manager
│   │   ├── release.rs            # Список релизов, история, rollback
│   │   ├── repository.rs         # Управление репозиториями чартов
│   │   └── installer.rs          # Установка/апгрейд чартов с передачей values.yaml
│   │
│   ├── terminal/                 # Локальный PTY терминал
│   │   ├── pty_session.rs        # Сессия portable-pty
│   │   └── manager.rs            # Пул активных терминальных сессий с авто-контекстом
│   │
│   ├── plugin/                   # Фундамент системы плагинов
│   │   ├── manifest.rs           # Спецификация манифеста плагина
│   │   └── registry.rs           # Реестр хуков и расширений интерфейса
│   │
│   └── ipc/                      # Адаптеры Tauri IPC (контроллеры)
│       ├── cluster_commands.rs
│       ├── resource_commands.rs
│       ├── pod_commands.rs
│       ├── helm_commands.rs
│       ├── pty_commands.rs
│       └── specta_bindings.rs    # Генератор TypeScript определений (tauri-specta)
```

---

## 4. Архитектура Frontend (React 19 + TypeScript)

### 4.1. Структура директорий

```
src/
├── main.tsx                      # Точка входа React
├── App.tsx                       # Главный Layout и провайдеры
│
├── bindings/                     # Автогенерируемые TS типы из Rust (tauri-specta)
│   └── commands.ts
│
├── core/                         # Системные сервисы фронтенда
│   ├── ipc.ts                    # Типизированный фасад над Tauri invoke / listen
│   ├── event_bus.ts              # Локальная шина событий UI
│   ├── keybindings.ts            # Глобальный диспетчер горячих клавиш
│   └── theme.ts                  # Модуль тем (JetBrains Darcula, VS Code Dark+, Light)
│
├── state/                        # Реактивные хранилища (Zustand)
│   ├── cluster_store.ts          # Список кластеров, выбранный контекст, namespace
│   ├── resource_store.ts         # Кэш объектов K8s по типам (GVK)
│   ├── terminal_store.ts         # Активные вкладки терминалов и сессий
│   ├── log_viewer_store.ts       # Состояние потоков логов, фильтры, regex
│   ├── port_forward_store.ts     # Активные туннели
│   └── ui_layout_store.ts        # Состояние панелей, сплитов, открытых табов
│
├── components/                   # UI библиотека компонентов в стиле JetBrains/VS Code
│   ├── common/                   # Базовые атомы (Button, Dropdown, Modal, Badge, Tooltip)
│   ├── layout/                   # Компоненты разметки (TitleBar, ActivityBar, Sidebar, Dock, Inspector)
│   ├── k8s/                      # ResourceTable, StatusBadge, YamlEditor, ResourceGraph
│   ├── terminal/                 # XTerminal, LogStreamViewer
│   └── command_palette/          # CommandPalette, search_provider
│
└── views/                        # Основные экраны приложения (Workloads, Network, Storage, Config, RBAC, CRDs, Helm)
```

---

## 5. Дизайн-система и компоновка интерфейса

Интерфейс спроектирован по канонам современных IDE (**JetBrains Fleet / New UI** и **VS Code**):

```
┌───┬───────────────────────────────────────────────────────────────────────────┬───┐
│ ☰ │ ⎈ [prod-cluster-us-east]  namespace: [ default ▾ ]    🔍 Search (Cmd+P) │ × │
├───┼─────────────────┬───────────────────────────────────────────┬─────────────┴───┤
│ ☸ │ CLUSTER TREE    │ TABS: [ Pods × ] [ deployment/api-server ]│ INSPECTOR       │
│   │ ▼ Workloads     ├───────────────────────────────────────────┤ Pod: api-gw-x91 │
│ 📦│   ● Pods (42)   │ 🔍 Filter...  Namespace: all ▾    [+ Apply]│ Status: Running │
│   │   ○ Deployments │ Name           Ready  Status   Restarts IP│ Restarts: 0     │
│ 🌐│   ○ DaemonSets  │ 🟢 api-gw-x91  1/1    Running  0    10.2│ CPU: 12m        │
│   │   ○ StatefulSets│ 🟢 auth-svc-2  2/2    Running  1    10.3│ Mem: 145Mi      │
│ 💾│   ○ Jobs        │ 🔴 worker-err  0/1    CrashLp  12   10.4│ ─────────────── │
│   │ ▼ Config        │ 🟡 redis-0     0/1    Pending  0    -   │ Containers (1)  │
│ 🛡 │   ○ ConfigMaps  │                                           │ Volumes (2)     │
│   │   ○ Secrets     │                                           │ Events (4)      │
│ ⚓ │ ▼ Network       │                                           │ [Edit YAML]     │
│   │   ○ Services    │                                           │ [Terminal]      │
│ ⚙ │   ○ Ingresses   │                                           │ [View Logs]     │
├───┴─────────────────┴───────────────────────────────────────────┴─────────────────┤
│ DOCK: [ >_ Terminal 1 ] [ 📋 Logs (api-gw-x91) ] [ 🔀 Ports (2) ] [ ⚠ Events ]   │
│ 2026-10-19T14:30:00Z [INFO] HTTP GET /api/v1/health HTTP/1.1 200 OK              │
│ 2026-10-19T14:30:01Z [INFO] Handled request in 2.4ms                             │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Цветовая палитра и темы (JetBrains Darcula / VS Code Dark+)
- **Background Deep:** `#1e1f22` (основной фон редактора/таблиц)
- **Background Sidebar:** `#2b2d30` (панели навигации, деревья)
- **Background Surface / Card:** `#313438` (активные элементы, инспекторы)
- **Border / Divider:** `#393b40` (тонкие разделители 1px)
- **Accent Primary:** `#3574f0` (акцент JetBrains Blue) / `#007acc` (VS Code Blue)
- **Status Colors:**
  - Running / Ready: `#59a869` (зеленый)
  - Warning / Pending: `#e5b742` (желтый/янтарный)
  - Error / CrashLoop: `#e05555` (красный)
  - Terminating: `#787878` (нейтральный серый)
