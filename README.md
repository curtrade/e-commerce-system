# e-commerce-system

Учебная имплементация саги «заказ → резерв → оплата → подтверждение» из дизайн-документа
[curtrade/system-design/e-commerce-system](https://github.com/curtrade/system-design/tree/main/e-commerce-system).
NestJS-монорепо из четырёх сервисов на одной Postgres / Redis / Kafka.

## Сервисы

| Сервис | Порт | Роль |
|---|---|---|
| `orders` | 3001 | Saga-оркестратор: создаёт заказ, синхронно дергает inventory и payments, пишет outbox |
| `inventory` | 3003 | Резерв/release/commit стока с TTL, потребляет события заказа |
| `payments` | 3002 | Идемпотентный charge/refund, симуляция отказа через `FAILURE_RATE` |
| `notifications` | 3004 | Kafka-консьюмер, пишет уведомления в БД (email-провайдер не подключён) |

Общая инфра: `postgres:5432`, `redis:6379`, `kafka:9092`, `kafka-ui:8080`.
Observability: `otel-collector:4318` (OTLP HTTP), `jaeger:16686` (трейсы), `loki:3100` (логи), `grafana:3000` (UI).
В одном инстансе Postgres создаются 4 базы (`init-db.sql`), Redis разделён по DB 0–3.

## Шина

Все события идут одним топиком `orders.events` в общем конверте:

```ts
{ eventId, eventType, occurredAt, traceId, payload }
```

Типы: `OrderConfirmed`, `OrderFailed` (`OrderFulfilled` / `OrderRefunded` зарезервированы).

## Saga happy-path

```
POST /orders
 └─ orders: INSERT order(PENDING)
 └─ HTTP  inventory.reserve(ttl=900s)   ── Idempotency-Key: <orderId>:<attemptId>
 └─ HTTP  payments.charge               ── тот же ключ
 └─ tx:   UPDATE order=CONFIRMED + INSERT orders_outbox(OrderConfirmed)
 └─ outbox publisher (SELECT … FOR UPDATE SKIP LOCKED, poll 1s) → Kafka
         ├─ inventory.consumer  → commit reservation
         └─ notifications.consumer → запись в notifications
```

## Компенсации (три слоя)

1. **Explicit release** — `orders` синхронно вызывает `inventory.release` при провале payments.
2. **Outbox `OrderFailed`** — атомарно с переводом заказа в `FAILED_*`; consumer inventory сделает release повторно (idempotent по reservationId).
3. **Reaper TTL** — `inventory.reaper` каждые 30 с релизит `PENDING` с истёкшим `expires_at`.

Плюс `saga-recovery` в `orders`: раз в 15 с переводит `PENDING` старше `SAGA_TIMEOUT_SEC` (60 с) в `FAILED_TIMEOUT` с событием `OrderFailed`.

## Идемпотентность

- HTTP-эндпоинты `inventory.reserve` и `payments.charge` требуют заголовок `Idempotency-Key`.
- В `orders` ключ = `${orderId}:${attemptId}`.
- `payments` хранит ключ в БД (`UNIQUE`) и в Redis (`pay:idem:*`, TTL 24 ч).
- `inventory` кэширует результат reserve в Redis (`inv:idem:*`, TTL 24 ч).
- Kafka-консьюмеры дедуплицируют по `eventId` через `redis.claimIdempotency` (TTL 7 дней).

## Observability (traces + logs)

Сервисы шлют OTLP HTTP в **otel-collector**, который разводит сигналы: трейсы → Jaeger,
логи → Loki. Grafana подцеплена к Loki и Jaeger через provisioning (`scripts/grafana-datasources.yaml`),
auth выключен — UI открывается на `http://localhost:3000`.

- **Инициализация**: `tracing.js` подгружается через `NODE_OPTIONS=--require=/app/tracing.js`. Внутри `NodeSDK` поднимает `traceExporter: OTLPTraceExporter()` и `logRecordProcessors: [BatchLogRecordProcessor(OTLPLogExporter())]` без явного `url` — экспортёры берут эндпоинт из `OTEL_EXPORTER_OTLP_ENDPOINT` и сами подставляют `/v1/traces` и `/v1/logs`.
- **Auto-instrumentation**: HTTP, `pg`, `ioredis`, `kafkajs`, `pino`. `fs`/`net`/`dns` отключены как шум.
- **Логгер**: `nestjs-pino` подключён через `AppLoggerModule` из `libs/common/src/logger` во все 4 модуля; в `main.ts` — `app.useLogger(app.get(Logger))` с `bufferLogs: true`. JSON-выход, `/health` отфильтрован, `x-request-id` берётся из заголовка или генерится новым UUID.
- **Корреляция**: `@opentelemetry/instrumentation-pino` врезает `trace_id`/`span_id`/`trace_flags` в каждую запись лога, выполненную внутри активного спана. В Grafana derivedField на Loki ловит `trace_id` и открывает спан в Jaeger одним кликом (`scripts/grafana-datasources.yaml`).
- **Sending**: та же инструментация добавляет destination в pino — записи логов улетают в Logs SDK → BatchLogRecordProcessor → OTLPLogExporter → Collector → Loki (`/otlp/v1/logs`, требует `allow_structured_metadata: true` в `loki-config.yaml`).
- **Через outbox-границу руками**. Авто-пропагация рвётся, потому что между `INSERT outbox` и публикацией в Kafka сидит polling-цикл в другом таймере. В транзакции `orders` сохраняем W3C `traceparent` в `orders_outbox.trace_context` через `captureTraceparent()` (`orders.service.ts:137,182`), а `OutboxPublisher` восстанавливает его как родителя спана `outbox.publish` через `withSpan(..., { parentTraceparent: row.trace_context })` (`outbox.publisher.ts:58-67`).
- **Хелперы** в `libs/common/src/otel/with-span.ts`: `withSpan(tracerName, spanName, fn, { parentTraceparent? })` и `captureTraceparent()`. Используются ещё в `saga-recovery.service.ts` — фоновая джоба восстановления получает собственный root-спан.
- **Env**: `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT` (base, без `/v1/...`), `LOG_LEVEL` (по умолчанию `info`).
- **Ограничение**: миграция `1779373518241_orders-outbox-trace-context.js` снесла старую колонку `trace_id`; строки в outbox до миграции опубликуются как новые корни трасс.

## Запуск

```bash
docker compose up -d --build
# health
curl :3001/health :3002/health :3003/health :3004/health
# трассы и логи: Jaeger :16686, Grafana → Explore → Loki / Jaeger на :3000
# happy-path (каталог уже заполнен SKU-RED-SHIRT-M / SKU-BLUE-MUG / SKU-NOTEBOOK-A5)
curl -X POST :3001/orders -H 'content-type: application/json' -d '{
  "customerId":"c1","email":"a@b.c",
  "items":[{"sku":"SKU-BLUE-MUG","qty":2,"unitPrice":7.5}]
}'
```

Dev-режим (без контейнеров) — поднять Postgres/Redis/Kafka локально и `npm run start:<service>`.

## Расхождения с дизайн-документом

- Межсервисный RPC реализован как **HTTP**, а не gRPC.
- Notifications **не отправляет реальные письма** — только лог и запись в БД.
- Один Postgres-инстанс с базой на сервис вместо отдельных инстансов (логически DB-per-service сохранён).
- Все события публикуются в один топик `orders.events`; `StockChanged` и фоновые проекции не реализованы.
- Refund-flow при системном долге описан в дизайне, но не автоматизирован.

## Тестирование

Покрыт только `apps/orders` — там, где живёт сага. Jest разведён на два проекта через `jest.config.ts`:

| Группа | Регистр | Команда | Окружение |
|---|---|---|---|
| `unit` | `*.spec.ts` | `npm run test:unit` | Только моки (`test/helpers/mock-factories.ts`): `PgService`, `KafkaProducerService`, `SchedulerRegistry`, HTTP-клиенты `inventory`/`payments`. |
| `integration` | `*.int-spec.ts` | `npm run test:integration` | `globalSetup` поднимает Postgres 16 и Redis 7 через `testcontainers`, накатывает схему из `scripts/init-db.sql` + миграции `migrations/orders`. Kafka не поднимается — продьюсер мокается. `--runInBand`, `testTimeout: 60s`. |

`npm test` запускает обе группы. `npm run test:cov` — с покрытием.

### Unit (`apps/orders/src/*.spec.ts`)

**`orders.controller.spec.ts` — `OrdersController`** (тонкая обёртка над сервисом):
- `POST /` пробрасывает DTO в `service.createOrder` и возвращает его результат как есть.
- `GET /:id` возвращает строку, если сервис её отдал.
- `GET /:id` бросает `NotFoundException` с текстом `Order <id> not found`, если сервис вернул `null`.

**`orders.service.spec.ts` — `OrdersService`** (ядро саги, всё на моках pg/inventory/payments):
- happy path (5 проверок одного прогона): `INSERT orders` с `PENDING` и корректным `total`; idempotency-key вида `<orderId>:<attemptId>`, оба UUID, один и тот же ключ улетает в `reserve` и `charge`; `ttlSec` из конфига (а не зашитые 900); `amount` в `charge` равен подсчитанному total; `release` не дергается; `withTransaction` ровно один с двумя запросами — `UPDATE orders … CONFIRMED` и `INSERT orders_outbox` с `event_type='OrderConfirmed'` и payload, содержащим `orderId/reservationId/paymentId/customerId/email/total`; результат — `CONFIRMED` с ids.
- ветка `FAILED_INVENTORY` (reserve кинул): `payments.charge` и `inventory.release` не вызываются; failOrder пишет `UPDATE … FAILED_INVENTORY` и `OrderFailed` outbox без `reservationId`; ответ — `FAILED_INVENTORY` с reason.
- ветка `FAILED_PAYMENT` (reserve ок, charge кинул): `inventory.release` вызывается с idempotency-key, оканчивающимся на `:release` (это `<reserveKey>:release`); failOrder пишет `FAILED_PAYMENT` и `OrderFailed` с `reservationId`; ответ — `FAILED_PAYMENT` с reason.
- закреплённый контракт `InventoryClient.release` не бросает: если бросит — failOrder не отработает и заказ останется `PENDING`. Тест документирует это поведение.
- `recoverStuckOrders`: возвращает 0 без транзакций, если нет «зависших»; SELECT использует `sagaTimeoutSec` из конфига; на каждую строку запускает `failOrder(FAILED_TIMEOUT, …)` с сохранением `reservationId`, payload `OrderFailed` без `reservationId` если его в строке не было.
- `getOrder`: `null` при пустом результате, первая строка при наличии.

**`outbox.publisher.spec.ts` — `OutboxPublisher`** (моки pg и kafka, `withSpan` тоже замокан, чтобы заглянуть в `parentTraceparent`):
- `onModuleInit` регистрирует интервал под именем `orders-outbox-publisher`.
- `tick` селектит `FROM orders_outbox` с `published_at IS NULL` и `FOR UPDATE SKIP LOCKED`.
- На успешном `producer.send` каждая строка превращается в конверт `{ eventId, eventType, occurredAt, payload }`, в Kafka летит с `key = aggregate_id` и `topic = orders.events`, затем `UPDATE orders_outbox SET published_at = NOW()` ровно по этой строке.
- Если `producer.send` упал — выполняется `SET attempts = attempts + 1` без `published_at`.
- `row.trace_context` пробрасывается в `withSpan` как `parentTraceparent` (восстановление родителя спана после outbox-границы).
- Защита от наложения тиков: пока первый `tick` висит на SELECT, второй вызов выходит сразу через guard `running` — повторного SELECT не происходит.

**`saga-recovery.service.spec.ts` — `SagaRecoveryService`** (fake timers, мок `OrdersService`):
- `onModuleInit` регистрирует один интервал под именем `orders-saga-recovery`.
- На каждый тик (раз в 15 с) дергается `recoverStuckOrders`.
- Ошибку из `recoverStuckOrders` глотает с `logger.error`, интервал продолжает жить — следующий тик отрабатывает.

### Integration (`apps/orders/src/*.int-spec.ts`)

Те же три файла, но против настоящей Postgres из контейнера. Между тестами — `truncateOrders(pg)`.

**`orders.service.int-spec.ts`** — проверяет, что `OrdersService` действительно пишет ожидаемые строки:
- happy path: после `createOrder` в `orders` лежит строка `CONFIRMED` с `reservation_id`, `payment_id`, `total='19.00'`; в `orders_outbox` ровно одна строка `OrderConfirmed` с `published_at IS NULL` и нужным payload.
- `FAILED_INVENTORY`: в `orders` — `FAILED_INVENTORY` без `reservation_id/payment_id`, в outbox — `OrderFailed` без `reservationId`; `inventory.release` и `payments.charge` не вызывались.
- `FAILED_PAYMENT`: `inventory.release` вызвался с правильным `reservationId`, в `orders` — `FAILED_PAYMENT` со ссылкой на reservation, в outbox — `OrderFailed` с `reservationId`.
- атомарность CONFIRMED + outbox: через хук на `withTransaction` второй query в транзакции принудительно падает; проверяется, что `UPDATE orders` откатился (статус остался `PENDING`) и в `orders_outbox` ноль строк. INSERT `PENDING` до транзакции — не откатывается, это ожидаемо.

**`outbox.publisher.int-spec.ts`** — Kafka мокается, Postgres настоящая:
- одиночный издатель публикует все непубликованные строки ровно по разу, `eventId` совпадают со вставленными id; `published_at IS NULL` исчезает.
- при провале `producer.send` строка остаётся неопубликованной, `attempts` инкрементнулся до 1.
- задокументированная гонка двух publishers: SELECT через `pool.query` авто-коммитится и снимает `FOR UPDATE SKIP LOCKED` раньше, чем стартует `UPDATE`, поэтому два параллельных publisher'а через детерминированные барьеры (без `setTimeout`) видят одни и те же строки и дважды отправляют их в Kafka (`send.mock.calls.length > N`). Все строки в итоге помечены `published_at` — eventually-correct. Тест пиннит текущее поведение; если SELECT+UPDATE завернут в одну транзакцию, тест станет `toBe(N)`.

**`saga-recovery.int-spec.ts`** — `OrdersService.recoverStuckOrders` против реальной Postgres:
- старый `PENDING` (age = 100 с при `sagaTimeoutSec=60`) уезжает в `FAILED_TIMEOUT` с `error LIKE '%saga recovery%'`, в outbox появляется `OrderFailed` с тем же `reservationId`; свежий `PENDING` (age = 10 с) не трогается.
- повторный прогон по тому же набору возвращает 0 — `WHERE status='PENDING'` выступает естественным guard, в outbox по-прежнему одна строка.
- задокументированный дубль: ручной `failOrder(FAILED_PAYMENT)` + последующий `failOrder(FAILED_TIMEOUT)` для того же заказа дают две `OrderFailed`-строки в outbox (статус — last-writer-wins). Kafka-консьюмеры дедуплицируют по `eventId`, downstream видит одно событие, но в самой таблице — две строки. Тест фиксирует это до тех пор, пока в `failOrder` не появится status-guard.

## Структура

```
apps/{orders,payments,inventory,notifications}/src   — сервисы (controller, service, consumer, …)
libs/common/src/{db,redis,kafka,events}              — общие клиенты и контракты
scripts/init-db.sql                                  — схема всех 4 БД + сидинг каталога
Dockerfile                                           — мульти-стейдж, параметризуется SERVICE arg
docker-compose.yml                                   — инфра + 4 сервиса
```
