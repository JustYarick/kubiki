# Дорожная карта реализации Kubiki (Engineering Roadmap)

> Статусы фаз по коду на 2026-10-20: [09-PROJECT-STATUS.md](09-PROJECT-STATUS.md). Ниже план работ; наличие задачи не означает её выполнение.


> **Назначение документа:** Пошаговое руководство для автономной или парной разработки приложения Kubiki.  
> **Целевая аудитория:** Разработчики и автономные ИИ-агенты (AI Coding Agents).  
> **Принцип выполнения:** Строго последовательный переход от базовых слоев (инфраструктура, ядро Rust, IPC) к сложным интерактивным подсистемам (Watch streams, xterm, Monaco, Helm).

---

## Ближайшие исполняемые задачи

Текущий backlog со статусами, зависимостями и критериями: [10-IMPLEMENTATION-TASKS.md](10-IMPLEMENTATION-TASKS.md). В нём выделены читаемые детали/annotations, стабильный YAML, warning indicators и подробный план диаграмм **по уровням cluster → namespace → workload → Pod / Node**, со сворачиванием групп, фильтрами, раскладкой и экспортом (GRAPH-00…12).

## Общая структура этапов разработки

```
┌────────────────────────────────────────────────────────────────────────┐
│ Фаза 0: Инициализация окружения, шаблонизация и CI                     │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 1: Rust Core & Модель Kubeconfig / Multi-cluster                  │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 2: Shell, Дизайн-система (JetBrains/VSCode) & Docking Layout      │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 3: Event-Driven Watch Engine & Таблицы Workloads                  │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 4: Интерактивный Pod Ops (Logs Streaming, Exec PTY, Port-Forward) │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 5: Конфигурация, Сеть, Хранилище и RBAC                           │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 6: Monaco YAML Editor с Live Diff и CRD Explorer                  │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 7: Полноценный Helm 3 Package Manager                             │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 8: Метрики, Мониторинг & Дашборд нод                              │
├────────────────────────────────────────────────────────────────────────┤
│ Фаза 9: Foundation системы плагинов, Настройки & Production Release    │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Фаза 0: Инициализация окружения, шаблонизация и CI

### 0.1. Инициализация проекта Tauri v2 + React
- **Задача 0.1.1: Создание структуры репозитория Tauri v2**
  - Шаблон `react-ts` + `vite` с менеджером пакетов `pnpm`.
- **Задача 0.1.2: Настройка зависимостей Rust Backend (`src-tauri/Cargo.toml`)**
  - Добавление `kube` (0.98+), `k8s-openapi`, `tokio`, `serde`, `thiserror`, `anyhow`, `tauri-specta`, `portable-pty`, `tracing`.
- **Задача 0.1.3: Настройка зависимостей Frontend (`package.json`)**
  - Установка `zustand`, `@tanstack/react-table`, `@tanstack/react-virtual`, `@monaco-editor/react`, `@xterm/xterm`, `dockview`, `lucide-react`, `tailwindcss`.
- **Задача 0.1.4: Интеграция генерации типов tauri-specta**
  - Автоматическая генерация типов `src/bindings/commands.ts`.

---

## Фаза 1: Rust Core & Модель Kubeconfig / Multi-cluster

### 1.1. Подсистема управления Kubeconfig
- **Задача 1.1.1: Модуль парсинга и обнаружения контекстов (`src-tauri/src/cluster/kubeconfig.rs`)**
  - Чтение `~/.kube/config`, извлечение контекстов, пользователей, кластеров, namespace.
- **Задача 1.1.2: Пул клиентов и фабрика подключений (`src-tauri/src/cluster/client.rs`)**
  - `ClientPool` на базе `Arc<RwLock<HashMap<String, kube::Client>>>`.
  - Команды `get_contexts`, `set_current_context`, `get_cluster_version`.
- **Задача 1.1.3: Поддержка cloud auth exec helpers (AWS, GKE, AKS, OIDC)**

---

## Фаза 2: Shell, Дизайн-система (JetBrains/VSCode) & Docking Layout

### 2.1. Базовый макет и темы оформления
- **Задача 2.1.1: Настройка тем оформления (JetBrains Darcula, VS Code Dark+, Light)**
- **Задача 2.1.2: Кастомный TitleBar с селектором контекстов и namespace**
- **Задача 2.1.3: Боковая панель навигации (Cluster Tree Navigator) в стиле Lens**
- **Задача 2.1.4: Интеграция Dockview (табы, сплиты, док терминала)**

---

## Фаза 3: Event-Driven Watch Engine & Таблицы Workloads

### 3.1. Watch & Informer Engine на Rust
- **Задача 3.1.1: Диспетчер подписок на K8s Watch Streams (`src-tauri/src/informer/manager.rs`)**
  - Batching событий каждые 50 мс для защиты React event loop.
- **Задача 3.1.2: Нормализованный Zustand Store (`src/state/resource_store.ts`)**
- **Задача 3.1.3: Виртуализированный компонент `ResourceTable` (`@tanstack/react-virtual`)**
- **Задача 3.1.4: Экраны Workloads (Pods, Deployments, StatefulSets, DaemonSets, Jobs, CronJobs)**

---

## Фаза 4: Интерактивный Pod Ops (Logs Streaming, Exec PTY, Port-Forward)

- **Задача 4.1: Pod Logs Viewer (`src-tauri/src/pod_ops/logs.rs` & `LogStreamViewer.tsx`)**
  - Асинхронный стриминг через `log_stream()`, multi-container выбор, `previous: true`, regex-поиск, экспорт.
- **Задача 4.2: Интерактивный терминал в контейнере (`src-tauri/src/pod_ops/exec.rs` & `XTerminal.tsx`)**
  - Двусторонний WebSocket стрим stdin/stdout/stderr, обработка window resize.
- **Задача 4.3: Port Forwarding Engine (`src-tauri/src/pod_ops/port_forward.rs` & `PortForwardsView.tsx`)**
  - Локальный TCP listener, туннелирование в под, статистика байт, открытие в браузере.

---

## Фаза 5: Конфигурация, Сеть, Хранилище и RBAC

- **Задача 5.1: ConfigMaps & Secrets (маскирование паролей, auto Base64)**
- **Задача 5.2: PersistentVolumeClaims, PVs & StorageClasses**
- **Задача 5.3: Services, Ingresses (кликабельные хосты) & NetworkPolicies (визуальный граф)**
- **Задача 5.4: RBAC Matrix (ServiceAccounts, Roles, ClusterRoles, RoleBindings)**

---

## Фаза 6: Monaco YAML Editor с Live Diff и CRD Explorer

- **Задача 6.1: Monaco YAML Editor с K8s JSON Schema и Live Diff перед `kubectl apply`**
- **Задача 6.2: Динамический CRD Explorer (парсинг дополнительных колонок и динамические таблицы)**

---

## Фаза 7: Полноценный Helm 3 Package Manager

- **Задача 7.1: Управление репозиториями чартов (add, update, remove, search)**
- **Задача 7.2: Управление релизами (list, history, values.yaml в Monaco, upgrade, rollback в 1 клик)**

---

## Фаза 8: Метрики, Мониторинг & Дашборд нод

- **Задача 8.1: Интеграция с Metrics Server (`metrics.k8s.io`)**
- **Задача 8.2: Автообнаружение Prometheus и визуализация графиков утилизации CPU/Memory**

---

## Фаза 9: Foundation системы плагинов, Настройки & Production Release

- **Задача 9.1: Локальный загрузчик плагинов (`~/.config/kubiki/plugins/`)**
- **Задача 9.2: Редактор Keybindings и Настроек**
- **Задача 9.3: Сборка релизных пакетов для Linux, macOS и Windows**
