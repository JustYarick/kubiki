# Документация проекта Kubiki

> **Kubiki** — современная, высокопроизводительная кроссплатформенная IDE для Kubernetes.  
> Полноценный аналог Lens/OpenLens/Freelens с архитектурой без Electron (на базе чистого Rust-движка `kubiki-core`), потребляющий минимум памяти и работающий полностью локально (serverless / local-first).

---

## Навигация по документации

Вся документация по исследованию, проектированию и разработке расположена в папке `./docs`:

| Документ | Содержание | Для кого предназначен |
|---|---|---|
| **[01-RESEARCH-ANALYSIS.md](./01-RESEARCH-ANALYSIS.md)** | Глубокий анализ существующих аналогов (Lens, Headlamp, K9s, Aptakube, Octant, Kubenav, Monokle), сравнительные таблицы, анализ причин провала Octant, разбор проблем с памятью в Electron, сравнение GUI-фреймворков для Rust. | Архитекторы, Product Owners, Исследователи |
| **[02-ARCHITECTURE-AND-DESIGN.md](./02-ARCHITECTURE-AND-DESIGN.md)** | Системное проектирование приложения: схема компонентов, архитектура бэкенда на Rust (Clean Architecture, Informer/Reflector manager, PTY pool, Port-forwarding engine), дизайн-код в стиле JetBrains/VS Code. | Lead Developers, Инженеры, AI-агенты |
| **[03-KUBERNETES-SPECIFICATION.md](./03-KUBERNETES-SPECIFICATION.md)** | Полная спецификация функционала Kubernetes: матрица всех поддерживаемых объектов (Workloads, Storage, Config, Network, RBAC, Cluster), динамическое обнаружение и отображение любых CRD со схемами, логи, exec, port-forward, Helm 3 и метрики. | DevOps инженеры, Разработчики фичей |
| **[04-ROADMAP.md](./04-ROADMAP.md)** | Пошаговый Engineering Roadmap из 10 фаз (от Фазы 0 до Фазы 9), разбитый на блоки и атомарные задачи. | ИИ-агенты (AI Coding Agents), Разработчики |
| **[05-HEADLESS-CORE-API.md](./05-HEADLESS-CORE-API.md)** | **Спецификация и API готового ядра `kubiki-core`**: описание сервисов, примеры кода, запуск тестов, использование CLI инструмента `kubiki-cli` и инструкция по подключению любого UI. | Frontend разработчики, UI AI-агенты |

---

## Как передать проект на создание UI другому ИИ-агенту

Для запуска разработки UI автономным агентом передайте следующую инструкцию:

```markdown
Привет! Ты разрабатываешь интерфейс для проекта Kubiki.
Весь основной бэкенд-движок Kubernetes уже полностью готов, оттестирован и находится в папке `crates/kubiki-core`.

Изучи документацию:
- `./docs/05-HEADLESS-CORE-API.md` (полное описание API движка kubiki-core)
- `./docs/02-ARCHITECTURE-AND-DESIGN.md` (требования к раскладке и стилю JetBrains / VS Code)

Подключи к своему UI-проекту крейт `kubiki-core = { path = "../crates/kubiki-core" }` и создай интерфейс на выбранном стеке.
```
