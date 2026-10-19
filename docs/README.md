# Документация проекта Kubiki

> **Kubiki** — современная, высокопроизводительная кроссплатформенная IDE для Kubernetes.  
> Полноценный аналог Lens/OpenLens/Freelens с архитектурой без Electron (Tauri v2 + Rust + React 19), потребляющий в 10–15 раз меньше оперативной памяти и работающий полностью локально (serverless / local-first).

---

## Навигация по документации

Вся документация по исследованию, проектированию и разработке расположена в папке `./docs`:

| Документ | Содержание | Для кого предназначен |
|---|---|---|
| **[01-RESEARCH-ANALYSIS.md](./01-RESEARCH-ANALYSIS.md)** | Глубокий анализ существующих аналогов (Lens, Headlamp, K9s, Aptakube, Octant, Kubenav, Monokle), сравнительные таблицы, анализ причин провала Octant, разбор проблем с памятью в Electron, сравнение GUI-фреймворков для Rust (Tauri, Iced, Slint, egui, Dioxus) и обоснование выбора стека. | Архитекторы, Product Owners, Исследователи |
| **[02-ARCHITECTURE-AND-DESIGN.md](./02-ARCHITECTURE-AND-DESIGN.md)** | Детальное системное проектирование приложения: схема компонентов, архитектура бэкенда на Rust (Clean Architecture, Informer/Reflector manager, PTY pool, Port-forwarding engine), структура фронтенда (React 19 + TypeScript + Zustand), дизайн-код в стиле JetBrains/VS Code, модель событий IPC и фундамент системы плагинов. | Lead Developers, Инженеры, AI-агенты |
| **[03-KUBERNETES-SPECIFICATION.md](./03-KUBERNETES-SPECIFICATION.md)** | Полная спецификация функционала Kubernetes: матрица всех поддерживаемых объектов (Workloads, Storage, Config, Network, RBAC, Cluster), динамическое обнаружение и отображение любых CRD со схемами, реализация стриминга логов, интерактивного терминала (exec), проброса портов, полноценной интеграции с Helm 3 и сбора метрик. | Kubernetes/DevOps инженеры, Разработчики фичей |
| **[04-ROADMAP.md](./04-ROADMAP.md)** | Пошаговый Engineering Roadmap из 10 фаз (от Фазы 0 до Фазы 9), разбитый на блоки и атомарные задачи. Каждая задача снабжена описанием, списком создаваемых файлов, сигнатурами структур/команд, кодом и критериями верификации для прямой передачи ИИ-агенту на реализацию. | ИИ-агенты (AI Coding Agents), Разработчики |

---

## Ключевые технологические решения

- **Desktop Shell:** [Tauri v2](https://v2.tauri.app/) (нативный системный WebView, размер инсталлятора 3–15 МБ, потребление памяти 30–50 МБ в idle).
- **Backend Core:** [Rust](https://www.rust-lang.org/) + Tokio async runtime.
- **K8s Client:** [kube-rs](https://github.com/kube-rs/kube) (CNCF Sandbox Project) с поддержкой Informers, Watch streams, Exec, Port Forward, Log follow.
- **Frontend Stack:** React 19, TypeScript 5, Vite, [Tailwind CSS v4](https://tailwindcss.com/).
- **Кодовый редактор:** [Monaco Editor](https://microsoft.github.io/monaco-editor/) (движок VS Code) с поддержкой JSON-схем K8s, автодополнением и Live Diff.
- **Встроенный терминал:** [xterm.js](https://xtermjs.org/) + `portable-pty` в Rust.
- **Управление окнами и панелями:** [Dockview](https://dockview.dev/) (панели, вкладки, сплиты как в JetBrains / VS Code).
- **Реактивное состояние:** [Zustand](https://github.com/pmndrs/zustand) + типизированная шина событий.
- **Типизация IPC:** `tauri-specta` (автоматическая генерация TypeScript типов из Rust структур).

---

## Как передать проект на реализацию ИИ-агенту

Для запуска реализации автономным агентом достаточно передать следующую инструкцию:

```markdown
Привет! Ты реализуешь проект Kubiki по готовой архитектурной документации.
Изучи файлы в папке `./docs`:
- `./docs/01-RESEARCH-ANALYSIS.md` (контекст и стек)
- `./docs/02-ARCHITECTURE-AND-DESIGN.md` (системный дизайн)
- `./docs/03-KUBERNETES-SPECIFICATION.md` (спецификация K8s)
- `./docs/04-ROADMAP.md` (пошаговый роадмап)

Начни реализацию строго с **Фазы 0** документа `./docs/04-ROADMAP.md`.
Выполняй задачи последовательно, проверяя каждый шаг командами верификации из роадмапа.
```
