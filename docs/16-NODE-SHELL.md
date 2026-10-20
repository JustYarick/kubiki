# Управляемый Node debug shell

Статус: OPS-03A DONE, OPS-03B TODO. Desktop transport реализован; реальный privileged Pod на пользовательском кластере в этом блоке не создавался.

## Проверка

Перезапустить `pnpm tauri dev` после обновления Rust. Nodes → объект → Node shell (либо соответствующий пункт ПКМ). Подготовка начинается автоматически при открытии Node shell и показывает backend system confirmation перед созданием helper. Начальный namespace — текущий выбранный namespace либо default при All namespaces; образ можно изменить в Configure. При ошибке/отмене повтор — только через Reconnect node shell, без автоматических retries. По умолчанию используется `docker.io/library/ubuntu:24.04`; образ должен иметь `/bin/sh`, `sleep`, `chroot`. Целевая нода должна быть Linux, host filesystem — содержать выбранный shell.

Создаётся privileged Pod с hostPID/IPC/network и hostPath `/` → `/host`, без service account token. После readiness exec запускает `chroot /host /bin/sh` (либо выбранный shell). Это доступ к файловой системе ноды с высокими привилегиями. Подготовка проверяет Node UID и разрешения get Node / create,get,delete Pod / get pods/exec. kube-rs 0.98 использует GET WebSocket upgrade. Admission/Pod Security или image pull могут запретить запуск даже после успешной проверки RBAC.

## Жизненный цикл

Сессия закреплена за context/Node UID и владельцем настоящего Tauri window. Максимум 8 managed preparations/sessions. Подготовка ограничена 120 секундами, отдельные API-запросы — 20. Статусы подготовки и cleanup доступны в header. Подключение использует общий xterm/ACK/backpressure transport; скрытие вкладки не пересоздаёт shell.

Exit, Disconnect, закрытие вкладки, Cancel, смена context/pagehide и destroy инициируют удаление helper. DELETE использует UID precondition, labels проверяются; чужой или пересозданный Pod не удаляется. Завершение удаления подтверждается GET/404. Ошибка удаления сохраняется для Retry cleanup. Reconnect/смена shell удаляют старый helper и создают новый. Команды не воспроизводятся автоматически.

Other debug Pods показывает помеченные Kubiki Pods выбранного namespace без активной сессии **в текущем процессе**. Другой экземпляр приложения может использовать такой Pod: удаление ручное, с проверкой UID/labels. Успешное ручное удаление снимает соответствующую failed lease.

Ограничения: аварийное завершение процесса или неопределённый результат POST после сетевого timeout могут оставить helper. `activeDeadlineSeconds=3600` завершает контейнер, но **не удаляет Pod**. Автоматическое удаление после crash не гарантируется; предусмотрено ручное восстановление. Exec endpoint адресуется по имени: проверка UID перед upgrade не даёт атомарной гарантии между GET и WebSocket.

## Проверки и оставшиеся задачи

5 Rust local HTTP/WS integration tests: реальная сериализация Pod, host chroot exec/stdin/output, отмена во время POST, RBAC/UID, retry cleanup, orphan deletion. 5 provider unit tests, Node routing/ACK test; 4 browser IPC tests: автоматическое подключение при открытии (одна preparation), ввод, reconnect/exit cleanup, cancel/late ready, отказ разрешений и ручное удаление.

OPS-03B: native GUI на тестовом кластере, admission/image pull/finalizers, реальные обрывы и длительные потоки, proxy/credentials, macOS/Windows transport. Browser IPC и локальный API этого не заменяют.

Основание модели helper: [Kubernetes — Debugging Kubernetes nodes](https://kubernetes.io/docs/tasks/debug/debug-cluster/kubectl-node-debug/), [Debug Running Pods](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/).
