# Native rendering: WebKitGTK/NVIDIA и плавность

Обновлено: 2026-10-20. Владелец возобновил исследование и уточнил: тормозит весь desktop UI в `pnpm tauri dev`, браузер работает плавно. Прежний запрет на эксперименты снят новым запросом. Ниже актуальное поведение; старый откат сохранён как история.

## Текущая политика запуска

- Убраны оба безусловных назначения `WEBKIT_DISABLE_DMABUF_RENDERER=1` из main/run. Единственная точка настройки — `src-tauri/src/graphics.rs`, до GTK/WebKit/Tokio.
- **auto** (по умолчанию): WebKit выбирает renderer; Kubiki не отключает DMABUF/compositing и не принуждает software/GL/backend/DPI. Только при наличии NVIDIA DRM device и Wayland задаёт `__NV_DISABLE_EXPLICIT_SYNC=1`, если пользователь не задал его сам. Это первый рекомендуемый workaround из [Tauri Linux Graphics](https://v2.tauri.app/develop/debug/linux-graphics/).
- **compatibility**: явно задаёт прежний `WEBKIT_DISABLE_DMABUF_RENDERER=1`; при NVIDIA/Wayland добавляет sync workaround. Для драйверов с blank window/framebuffer errors. Уступает в производительности в тяжёлых сценах.
- **system**: никаких overrides со стороны приложения. Сохраняет унаследованное окружение.
- Выбор: `KUBIKI_GRAPHICS_MODE=auto|compatibility|system` либо `--graphics=...`; CLI приоритетнее. Неверное значение — ошибка до запуска webview, а не молчаливый fallback. `--graphics-info` печатает режим, источник, обнаруженные признаки и ограниченный список графических env без старта GTK или чтения kubeconfig. Это сведения о запрошенной конфигурации, не подтверждение фактического GPU renderer.
- Raw env пользователя сохраняется в auto/system. Если shell/desktop launcher уже выставляет `WEBKIT_DISABLE_DMABUF_RENDERER=1` или `LIBGL_ALWAYS_SOFTWARE=1`, auto это не отменяет: источник виден в diagnostics. Для чистой проверки убрать соответствующую переменную только из окружения запуска.
- SVG, CSS, font/UI scale, карточки/подписи, React Flow rendering settings не менялись. Профили применяются только после полного перезапуска процесса.

## Повторная проверка текущего SVG — 2026-10-20

Машина: RTX 5070, NVIDIA 595.104.02, Hyprland/Wayland, WebKitGTK 2.54.1, GTK 3.24.53. Мониторы 180/60 Hz, scale 1; native probe сообщил devicePixelRatio=1 и viewport 1708×1384 (размер задаёт tiling compositor).

Одинаковый граф: 229 ресурсов / 730 связей, 180 синтетических кадров pan, production frontend. Запуски последовательно, пользовательский кластер не используется.

| Runtime | Режим | Средний rAF, мс | p95, мс | rAF FPS | Кадров >32 мс |
|---|---|---:|---:|---:|---:|
| GTK/WebKit | Прежний DMABUF disabled + sync workaround | 89.52 | 95 | 11.17 | 180/180 |
| GTK/WebKit | DMABUF default + sync workaround | 17.71 | 18 | 56.46 | 2/180 |
| Полное Tauri окно, Rust debug | compatibility | 92.23 | 99 | 10.84 | 180/180 |
| Полное Tauri окно, Rust debug | auto | 17.62 | 18 | 56.75 | 2/180 |

Это свидетельство конкретной причины тормозов тяжёлой сцены, независимой от Rust release optimization: одинаковые данные и frontend, меняется startup graphics policy. rAF — не счётчик фактически показанных монитором кадров и не измерение input-to-photon физической мыши. Нельзя обещать 180 Hz или аналогичный результат для всех GPU/чисел объектов. Простая прокрутка таблицы может быть плавной и в compatibility; это не доказывает отсутствие задержек на реальной нагрузке.

GTK snapshot с DMABUF при scale=1 просмотрен: основной UI читается чётко. Fractional DPI, перенос между мониторами, физический drag/ввод и субъективную чёткость на рабочем кластере нужно подтвердить отдельно. Старый опыт размытости не объявляется автоматически устранённым. Системный драйвер/Hyprland config не изменялись.

## Как проверить

Полностью закрыть старый процесс приложения; обычный frontend HMR не применяет env changes.

```sh
pnpm tauri dev
# Если нужен прежний режим:
KUBIKI_GRAPHICS_MODE=compatibility pnpm tauri dev
# Из корня репозитория, уже собранный бинарник; не открывает окно/кластер:
src-tauri/target/debug/kubiki --graphics-info
```

Isolated full-Tauri probe — отдельный example, не часть shipped app, без K8s managers/CLI или mutation commands; incognito webview, только mock reads/cleanup. Открывает временное окно и закрывает его после замера. `BENCH_MODE=scroll` измеряет прокрутку таблицы вместо pan. Одна и та же JS-процедура используется GTK и Tauri harness.

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 1422
# В другом терминале:
python3 tests/perf/topology_fixture.py > /tmp/kubiki-graphics-fixture.json
cargo build --manifest-path src-tauri/Cargo.toml --example graphics_probe --offline
BENCH_FIXTURE=/tmp/kubiki-graphics-fixture.json src-tauri/target/debug/examples/graphics_probe --graphics=compatibility
BENCH_FIXTURE=/tmp/kubiki-graphics-fixture.json src-tauri/target/debug/examples/graphics_probe
# BENCH_URL=http://127.0.0.1:1424 — аналогичная проверка с уже запущенным Vite dev.
```

Vite: при холодном старте первое открытие topology раньше вызывало late optimization `elk-worker.min.js` и full-page reload. Worker deep import добавлен в optimizeDeps.include; discovery для остальных пакетов сохранён. Это отдельный dev lifecycle дефект, не причина 11 FPS. См. [Vite dependency optimizer](https://vite.dev/config/dep-optimization-options.html).

## История: откат по просьбе о чёткости

В предыдущей итерации оптимизация была отложена: «мыльно … верни как было, потом буду разбираться».

### Поведение на момент прежнего отката

- Связи рисует прежний SVG renderer React Flow. Экспериментальный Canvas2D renderer удалён.
- Карточки и подписи не скрываются по масштабу или во время движения. Новые culling/compositing/CSS-оптимизации сняты.
- В `src-tauri/src/main.rs` и `src-tauri/src/lib.rs` восстановлены прежние `WEBKIT_DISABLE_DMABUF_RENDERER=1` и `__NV_DISABLE_EXPLICIT_SYNC=1`. Изменение этих переменных требует полного перезапуска desktop, HMR страницы недостаточно.
- Сохранены функциональные изменения: отдельный Events island, Namespace containers, фильтры/сортировка таблиц и единственный глобальный namespace picker.
- На момент прежнего отката проблема native pan оставалась открытой. Новый запрос и актуальные изменения описаны выше.

## Что установлено

Владелец подтвердил: в обычном браузере движение плавное, проблема проявляется в desktop. Поэтому результат Chromium не заменяет проверку WebKitGTK.

На этой машине: Linux/Wayland + NVIDIA, системный WebKitGTK **2.54.1**. Принудительное отключение DMABUF было продублировано в обеих точках запуска. Оно действительно присутствовало в окружении дочернего WebKitWebProcess. Исправление только `main.rs` не меняло итоговый режим: повторное назначение оставалось в `run()` библиотеки.

[Официальное руководство Tauri по Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/) описывает отключение DMABUF как compatibility workaround ценой более быстрого пути вывода; рекомендует не навязывать его всем работающим конфигурациям. Это не равнозначно отключению всего GPU: accelerated compositing и транспорт готовых кадров — разные части конвейера. [Описание графического конвейера WebKit](https://docs.webkit.org/Ports/WebKitGTK%20and%20WPE%20WebKit/Graphics.html).

## A/B на системном WebKitGTK

Отдельное видимое GTK/WebKit окно, mock HTTP snapshots, 229 ресурсов / 730 связей, 180 кадров синтетического перемещения фона. В обоих A/B запускался **один и тот же экспериментальный Canvas-вариант**, с одинаковой областью и камерой; остальные настройки сохранялись.

| Режим | Средний интервал rAF | p95 | Средняя частота rAF | Кадров >32 мс |
|---|---:|---:|---:|---:|
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | 53,42 мс | 59 мс | 18,72 FPS | 171 / 180 |
| Переменная DMABUF не задана, explicit sync workaround сохранён | 16,56 мс | 18 мс | 60,38 FPS | 0 / 180 |

Это локальное свидетельство влияния графического пути; синтетические DOM mouse events не измеряют всю цепочку физической мыши и не гарантируют такой FPS в любой диаграмме. После включения быстрого режима пользователь сообщил о размытости и запросил откат. **Быстрый режим не оставлен включённым.** После возврата SVG/прежних флагов новые performance-замеры не выполнялись.

## Примеры и варианты на будущее

- [React Flow performance](https://reactflow.dev/learn/advanced-use/performance): стабильные callbacks/объекты, memo компонентов, ограниченные subscriptions, простые CSS-стили, сворачивание больших деревьев. Это снижает нагрузку UI, но само по себе не устраняет медленный native presentation path.
- [Официальный Stress Test](https://reactflow.dev/examples/nodes/stress) был открыт и проверен в Chromium. Его структура и число связей отличаются от Kubernetes fixture; напрямую сравнивать FPS этих двух графов нельзя.
- [API React Flow](https://reactflow.dev/api-reference/react-flow): `onlyRenderVisibleElements` добавляет собственные расходы. Включение/выключение, а также `will-change` нужно проверять на целевом WebKit; эксперимент с безусловным рисованием всего графа и GPU promotion оказался хуже и снят.
- [Contextual Zoom](https://reactflow.dev/examples/interaction/contextual-zoom): вариант будущих уровней детализации. Текущий опыт скрытия деталей отменён по запросу владельца.
- Namespace реализован через [parentId/sub-flows](https://reactflow.dev/learn/layouting/sub-flows), с parent перед children и относительными координатами. Compound ELK поддерживает внешние связи через [INCLUDE_CHILDREN](https://eclipse.dev/elk/reference/options/org-eclipse-elk-hierarchyHandling.html); Node/PV/StorageClass остаются за рамкой namespace.

Ручные harness сохранены: `tests/perf/topology.mjs` для Chromium и `tests/perf/native_webkit.py` для системного WebKitGTK. Они используют вымышленные данные и не обращаются к настоящему кластеру. Native harness открывает временное окно; нужны Python GI, GTK3 и WebKit2 4.1. Дополнительный GTK harness (новое исследование разрешено текущим запросом):

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 1422
# В другом терминале, по одному запуску, без параллельных нагрузок:
BENCH_THROTTLE=4 BENCH_ZOOM=5 node tests/perf/topology.mjs
WEBKIT_DISABLE_DMABUF_RENDERER=1 __NV_DISABLE_EXPLICIT_SYNC=1 python3 tests/perf/native_webkit.py
env -u WEBKIT_DISABLE_DMABUF_RENDERER __NV_DISABLE_EXPLICIT_SYNC=1 python3 tests/perf/native_webkit.py
```

Сейчас harness рисует сохранённый SVG-вариант, поэтому новые результаты не обязаны повторять Canvas A/B выше. Следующая приёмка должна учитывать чёткость текста на разных zoom/DPI, полный Tauri, физический pan, p95/p99 frame time и native screen recordings, а не только средний rAF.
