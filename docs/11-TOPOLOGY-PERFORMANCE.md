# Диаграммы: исследование плавности и откат

Обновлено: 2026-10-20. **Оптимизация рендеринга отложена по прямому запросу владельца:** «мыльно … верни как было, потом буду разбираться».

## Активное поведение после отката

- Связи рисует прежний SVG renderer React Flow. Экспериментальный Canvas2D renderer удалён.
- Карточки и подписи не скрываются по масштабу или во время движения. Новые culling/compositing/CSS-оптимизации сняты.
- В `src-tauri/src/main.rs` и `src-tauri/src/lib.rs` восстановлены прежние `WEBKIT_DISABLE_DMABUF_RENDERER=1` и `__NV_DISABLE_EXPLICIT_SYNC=1`. Изменение этих переменных требует полного перезапуска desktop, HMR страницы недостаточно.
- Сохранены функциональные изменения: отдельный Events island, Namespace containers, фильтры/сортировка таблиц и единственный глобальный namespace picker.
- Проблема низкой частоты pan в desktop **не считается решённой**. Следующие графические эксперименты не запускать без нового запроса владельца.

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

Ручные harness сохранены: `tests/perf/topology.mjs` для Chromium и `tests/perf/native_webkit.py` для системного WebKitGTK. Они используют вымышленные данные и не обращаются к настоящему кластеру. Native harness открывает временное окно; нужны Python GI, GTK3 и WebKit2 4.1. Пример будущего запуска после отдельного решения продолжить исследование:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 1422
# В другом терминале, по одному запуску, без параллельных нагрузок:
BENCH_THROTTLE=4 BENCH_ZOOM=5 node tests/perf/topology.mjs
WEBKIT_DISABLE_DMABUF_RENDERER=1 __NV_DISABLE_EXPLICIT_SYNC=1 python3 tests/perf/native_webkit.py
env -u WEBKIT_DISABLE_DMABUF_RENDERER __NV_DISABLE_EXPLICIT_SYNC=1 python3 tests/perf/native_webkit.py
```

Сейчас harness рисует сохранённый SVG-вариант, поэтому новые результаты не обязаны повторять Canvas A/B выше. Следующая приёмка должна учитывать чёткость текста на разных zoom/DPI, полный Tauri, физический pan, p95/p99 frame time и native screen recordings, а не только средний rAF.
