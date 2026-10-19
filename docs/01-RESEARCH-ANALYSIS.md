# Kubiki — Исследование и анализ аналогов

> Примечание аудита 2026-10-20: это исследование и ориентиры. Оценки производительности/памяти не являются замерами Kubiki; актуальную готовность см. в [09-PROJECT-STATUS.md](09-PROJECT-STATUS.md).


> **Проект:** Kubiki — кроссплатформенная IDE для Kubernetes  
> **Дата:** 2026-10-19  
> **Статус:** Фаза исследования

---

## Оглавление

1. [Обзор рынка K8s IDE](#1-обзор-рынка-k8s-ide)
2. [Детальный анализ аналогов](#2-детальный-анализ-аналогов)
   - [Lens / Freelens](#21-lens--freelens)
   - [Headlamp](#22-headlamp)
   - [K9s](#23-k9s)
   - [Aptakube](#24-aptakube)
   - [Octant (archived)](#25-octant-archived)
   - [Kubenav](#26-kubenav)
   - [Monokle](#27-monokle)
3. [Сравнительная таблица](#3-сравнительная-таблица)
4. [Ключевые уроки и выводы](#4-ключевые-уроки-и-выводы)
5. [Анализ технологий](#5-анализ-технологий)
   - [GUI-фреймворки](#51-gui-фреймворки)
   - [K8s клиенты для Rust](#52-k8s-клиенты-для-rust)
   - [Терминал в Rust](#53-терминал-в-rust)
6. [Выбранный стек](#6-выбранный-стек)

---

## 1. Обзор рынка K8s IDE

Рынок Kubernetes IDE/dashboard инструментов можно разделить на три категории:

| Категория | Примеры | Характеристика |
|-----------|---------|----------------|
| **Desktop IDE (GUI)** | Lens, Freelens, Headlamp, Aptakube | Полнофункциональные десктоп-приложения с визуальным интерфейсом |
| **TUI (терминал)** | K9s | Терминальный интерфейс, максимальная скорость |
| **Web Dashboard** | Kubernetes Dashboard, Headlamp (in-cluster) | Запускается в кластере, доступ через браузер |

**Kubiki** нацелен на категорию **Desktop IDE** — полнофункциональное десктоп-приложение, работающее локально (serverless, без установки в кластер), с производительностью, приближенной к TUI.

---

## 2. Детальный анализ аналогов

### 2.1. Lens / Freelens

> [!NOTE]
> Lens — оригинальный проект (Kontena → Mirantis). После перехода на коммерческую модель (2023-2024) появился форк **OpenLens**, затем **Freelens** (активно поддерживается).

**Репозиторий:** [lensapp/lens](https://github.com/lensapp/lens) | [freelensapp/freelens](https://github.com/freelensapp/freelens)  
**Звёзды:** ~24k (Lens) / ~5.7k (Freelens)  
**Лицензия:** Проприетарная (Lens) / MIT (Freelens)

#### Архитектура

```
┌─────────────────────────────────────────────────────────┐
│                    ELECTRON                              │
│  ┌──────────────────┐  ┌──────────────────────────────┐ │
│  │  Main Process     │  │  Renderer Process            │ │
│  │  (Node.js)        │  │  (Chromium + React)          │ │
│  │                   │  │                              │ │
│  │  • KubeConfig     │◄─►  • React + TypeScript       │ │
│  │  • K8s API Client │IPC│  • MobX (state)            │ │
│  │  • node-pty       │  │  • xterm.js (terminal)      │ │
│  │  • Extension Host │  │  • CSS/Sass + Tailwind      │ │
│  │  • Local Proxy    │  │  • React Router             │ │
│  └──────────────────┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

**Стек:** Electron + React + TypeScript + MobX + xterm.js + node-pty  
**Сборка:** Webpack + Babel, electron-builder, Jest  
**State Management:** MobX — `@observable`, `@computed`, `@action`, `observer()` HOC

#### Структура кода

```
src/
├── common/      # Shared (типы, IPC-каналы, утилиты)
├── main/        # Electron Main Process (ОС, прокси, хранилище)
├── renderer/    # React UI (компоненты, вьюхи)
│   ├── components/
│   ├── views/
│   └── extension-api/
├── k8s/         # Модели K8s ресурсов, watchers, stores
└── extensions/  # Встроенные расширения
```

#### Работа с K8s API

- Main Process поднимает **локальный прокси** — инжектирует credentials, обрабатывает auth (OIDC, токены, сертификаты)
- Watch streams (`/api/v1/pods?watch=true`) — real-time delta events
- Events → IPC → MobX store → React re-render
- In-memory normalized cache всех ресурсов кластера

#### UI Layout

```
┌────────────────────────────────────────────────────────────┐
│ TITLE BAR: Back/Forward, Notifications, Profile, Settings  │
├───┬────────────────────────────────────────────────────────┤
│ H │  SIDEBAR (Navigation Tree)                             │
│ O │  ├─ Cluster: Overview, Nodes, Namespaces, Events, CRDs │
│ T │  ├─ Workloads: Pods, Deployments, DaemonSets, ...      │
│ B │  ├─ Config: ConfigMaps, Secrets, HPAs                  │
│ A │  ├─ Network: Services, Ingresses, NetworkPolicies      │
│ R │  ├─ Storage: StorageClasses, PVCs, PVs                 │
│   │  ├─ Access Control: RBAC                               │
│   │  └─ Apps: Helm Releases, Charts                        │
│(i │                                                        │
│ c │  MAIN CONTENT AREA                                     │
│ o │  (Tables, YAML editors, Dashboard, Metrics graphs)     │
│ n │                                                        │
│ s │                             ┌──────────────────────────┤
│) │                             │ DETAILS PANEL (drawer)    │
│   │                             │ • Metrics, Events         │
│   │                             │ • YAML/JSON editor        │
│   │                             │ • Container statuses      │
├───┴─────────────────────────────┴──────────────────────────┤
│ DOCK / BOTTOM PANEL (collapsible)                          │
│ • Terminal (context-aware kubectl) • Log Viewer             │
└────────────────────────────────────────────────────────────┘
```

#### K8s объекты (полный список)

**Workloads:** Pods, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, ReplicationControllers  
**Config & Storage:** ConfigMaps, Secrets, PVCs, PVs, StorageClasses  
**Network:** Services, Ingresses, IngressClasses, NetworkPolicies, Endpoints, EndpointSlices  
**RBAC:** ServiceAccounts, Roles, ClusterRoles, RoleBindings, ClusterRoleBindings  
**Cluster:** Nodes, Namespaces, Events, CRDs (+ любые CRD instances), HPAs, PDBs, PriorityClasses, RuntimeClasses, ResourceQuotas, LimitRanges  
**Ecosystem:** Helm Releases/Charts, Prometheus Metrics

#### Проблемы производительности

> [!CAUTION]
> **Критический недостаток Lens** — потребление памяти:
> - Baseline idle: **500 MB — 1.5+ GB RAM**
> - Multiple кластеры: 2-4+ GB
> - Memory leaks при длительной работе
> - CPU spikes при переключении кластеров с тысячами pod'ов

---

### 2.2. Headlamp

**Репозиторий:** [kubernetes-sigs/headlamp](https://github.com/kubernetes-sigs/headlamp)  
**Звёзды:** ~7,500+  
**Статус:** ✅ Активно — **официальный проект Kubernetes SIG UI**

- **Go backend (headlamp-server)** + React (TypeScript + MUI)
- **WebSocket мультиплексирование** — обход ограничения браузера на 6 соединений к одному домену
- **Plugin SDK** — React-based плагины + интеграция с Artifact Hub
- Двойной режим: desktop-app / in-cluster web dashboard
- Строгое соблюдение RBAC

---

### 2.3. K9s

**Репозиторий:** [derailed/k9s](https://github.com/derailed/k9s)  
**Звёзды:** ~35,000+ (самый популярный K8s инструмент)  
**Статус:** ✅ Очень активный

- 100% Go, TUI через `tcell`
- **Informers, NOT polling** — watch streams для real-time обновлений
- **DAO pattern** — слой абстракции между K8s API и UI
- **Command routing** — `:pods`, `:dp`, `:svc` — алиасы для навигации
- **Ultra-lightweight** — мгновенный запуск, минимальный CPU/RAM

---

### 2.4. Aptakube

**Тип:** Коммерческий (закрытый код)  
**Платформы:** macOS, Windows, Linux  
**Статус:** ✅ Активный

> [!IMPORTANT]
> **Aptakube использует Tauri (Rust backend + web UI)** — не Electron! Это доказывает работоспособность Tauri для K8s IDE:
> - Мгновенный запуск, 30–80 MB RAM в idle
> - Multi-cluster + multi-tab интерфейс
> - One-click port forwarding, aggregate logs, zero-config

---

### 2.5. Octant (archived)

**Репозиторий:** [vmware-archive/octant](https://github.com/vmware-archive/octant)  
**Звёзды:** ~6,000+  
**Статус:** ❌ Архивирован (январь 2023)

- **Уроки:** корпоративная зависимость (Broadcom/VMware), размытый фокус ("платформа" вместо простого дашборда), сложный gRPC-плагинный интерфейс.
- **Плюсы:** отличная идея графа зависимостей (Service → Deployment → ReplicaSet → Pods) и local-first подход.

---

### 2.6. Kubenav

**Репозиторий:** [kubenav/kubenav](https://github.com/kubenav/kubenav)  
**Звёзды:** ~2,300+  
**Стек:** Ionic + Capacitor + React (frontend) + Go Mobile (backend). Единственный с нативной поддержкой мобильных ОС.

---

### 2.7. Monokle

**Репозиторий:** [kubeshop/monokle](https://github.com/kubeshop/monokle)  
**Звёзды:** ~2,100+  
**Стек:** Electron + React. Фокус на YAML/манифестах и GitOps валидации, а не на кластерном дашборде.

---

## 3. Сравнительная таблица

| Инструмент | Язык | Фреймворк | ⭐ Stars | Плагины | RAM (idle) | Статус |
|---|---|---|---|---|---|---|
| **Lens** | TypeScript | Electron + React + MobX | ~24k | Dual-process extensions | 500MB–1.5GB | Коммерческий |
| **Freelens** | TypeScript | Electron + React + MobX | ~5.7k | Dual-process extensions | 500MB–1.5GB | ✅ Active (community) |
| **Headlamp** | Go + TS | React + Go server | ~7.5k | React SDK + Artifact Hub | ~200-300MB | ✅ Active (K8s SIG) |
| **K9s** | Go | tcell TUI | ~35k | Config only | ~20-50MB | ✅ Very Active |
| **Aptakube** | Rust + Web | **Tauri** | N/A | Нет | ~30-80MB | ✅ Commercial |
| **Octant** | Go + TS | Angular + Go | ~6k | gRPC plugins | ~100-200MB | ❌ Archived |
| **Kubenav** | Go + TS | Ionic + Go Mobile | ~2.3k | Нет | ~50-100MB | ✅ Active |
| **Monokle** | TypeScript | Electron + React | ~2.1k | VS Code ext | ~300-500MB | ⚠️ Maintenance |

---

## 4. Ключевые уроки и выводы

1. **Event-driven (Informers/Watch), НЕ polling** — все успешные инструменты используют K8s Watch API для real-time обновлений.
2. **Tauri > Electron** — Aptakube доказал, что Tauri + Rust = production-ready для K8s IDE с 10-15x экономией RAM.
3. **Local-first / Serverless** — пользователи предпочитают локальные инструменты, работающие через kubeconfig.
4. **DAO pattern** (K9s) — абстрактный слой между K8s API и UI — чистая архитектура.
5. **Zustand / Reactive State** — реактивное хранилище для real-time данных.
6. **Простые плагины > сложные** — компонентная архитектура расширений получает максимальное распространение.

---

## 5. Анализ технологий

### 5.1. GUI-фреймворки

| Параметр | Electron | Tauri v2 |
|---|---|---|
| Размер бинарника | 80–150+ MB | **3–15 MB** |
| Idle RAM | 150–300+ MB | **30–50 MB** |
| Cold Start | 1.0–3.0s | **0.2–0.8s** |
| WebView | Bundled Chromium | System WebView (WebView2/WebKit) |
| Backend | Node.js | **Rust** (tokio, async) |

**Почему не Iced/egui/Slint:** для IDE критически важны Monaco Editor (движок VS Code с валидацией схем K8s) и xterm.js (терминал с поддержкой ANSI/resize). Писать их с нуля на чистом Rust нецелесообразно.

### 5.2. K8s клиенты для Rust: kube-rs
- Статус: CNCF Sandbox Project — стандарт для Rust в экосистеме cloud-native.
- Возможности: `Api<T>`, `kube-runtime` (Watch streams, Informers, Reflector cache), `CustomResource` derive, WebSocket Exec / Attach / Port-Forward, `log_stream`.

### 5.3. Терминал: portable-pty + xterm.js
- `portable-pty` (WezTerm) — кроссплатформенный PTY (Linux PTY, macOS PTY, Windows ConPTY).
- `xterm.js` на фронтенде — проверенный временем терминальный эмулятор.

---

## 6. Выбранный стек

- **Backend:** Tauri v2, Rust (Tokio), `kube-rs`, `k8s-openapi`, `portable-pty`, `tauri-specta`.
- **Frontend:** React 19, TypeScript 5, Vite, Tailwind CSS v4, Monaco Editor, xterm.js, Dockview, Zustand, TanStack Table & Virtual.
