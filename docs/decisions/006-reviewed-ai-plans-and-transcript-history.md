# 006: Native планы, исполнение и очищенная история AI

Дата: 2026-11-01. Статус: **частично заменено [ADR-010](010-conversational-markdown-plans.md)**.
Решение о хранении очищенной истории остаётся в силе; структурированные планы
больше не предлагаются модели. Ниже сохранено исходное обоснование.
Продолжает [ADR-005](005-bounded-ai-resource-queries.md).

## Контекст

Markdown/thinking не задают проверяемой границы между внутренним outline и планом
устранения проблемы. Повторная генерация операций после пользовательского review
может изменить payload, а восстановление старой истории не должно восстанавливать
разрешение на запись. Поиск истории требует собственного ограниченного storage.

## Решение

Сохранён модульный монолит: Rust runtime, общий Kubernetes core и desktop lifecycle.
Native PlanStore хранит bounded versioned artifacts с session/scope/policy binding.
Модель предлагает diagnosis/uncertainty/steps/evidence, backend назначает identity
и status. Investigate требует актуального remediation artifact в каждом turn.
UI представляет только типизированные планы; thinking остаётся thinking.

Native preflight фиксирует payload и текущую identity в одноразовом review token.
Детерминированный executor исполняет выбранные steps через общий mutation boundary,
а затем делает bounded read-back. Review token не является model tool. Неизвестный
исход не повторяет write. Dependencies различают verified и explicitly accepted.

SQLite/FTS5 хранит очищенный transcript, retention/export preferences и tombstones.
Native runs, approvals, raw tool outputs и plan bodies не восстанавливаются.
Schema V1 и миграция localStorage допускают безопасное восстановление Read only +
Plan. Поиск и обновление индекса выполняются транзакционно в native blocking task;
запись ограничена по количеству и размеру. FTS и database secure-delete включены.

## Альтернативы и последствия

- Markdown-план без registry отклонён: нет надёжных version/scope/step boundaries.
- Повторное LLM-исполнение подтверждённого текста отклонено: выбранные payloads
  должны сохраняться без повторной интерпретации.
- Durable raw run replay отложен: это другой privacy/storage contract, не обычная
  история чата. Потребуется отдельная модель восстановления и авторизации.
- Новые сервисы/агенты/MCP процессы не добавлены: текущая нагрузка обслуживается
  одним desktop runtime. UI, AI и core используют существующее подключение.

Registry и review tokens живут только в native session; смена конфигурации/модели
требует нового плана. Хранилище не содержит полного forensic run. Технический
verified не обещает application health. Helm/GitOps и прочие новые writes требуют
отдельного capability review. Актуальный пользовательский workflow описан в
[планировании и исполнении](../AI_PLAN_CONTRACT.md).
