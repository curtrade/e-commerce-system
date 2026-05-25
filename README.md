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
 └─ outbox publisher (SELECT … FOR UPDATE SKIP LOCKED, poll 1s, max 10 attempts, exp backoff) → Kafka
         ├─ inventory.consumer  → commit reservation
         └─ notifications.consumer → запись в notifications
```

## Компенсации (три слоя)

1. **Explicit release** — `orders` синхронно вызывает `inventory.release` при провале payments.
2. **Outbox `OrderFailed`** — атомарно с переводом заказа в `FAILED_*`; consumer inventory сделает release повторно (idempotent по reservationId).
3. **Reaper TTL** — `inventory.reaper` каждые 30 с релизит `PENDING` с истёкшим `expires_at`.

Плюс `saga-recovery` в `orders`: раз в 15 с переводит `PENDING` старше `SAGA_TIMEOUT_SEC` (60 с) в `FAILED_TIMEOUT` с событием `OrderFailed`.

## Outbox-ретраи

Outbox publisher (`apps/orders/src/outbox.publisher.ts`) поллит `orders_outbox` раз в секунду и публикует непубликованные строки в Kafka. При недоступности брокера работают три механизма защиты:

| Механизм | Что делает | Где |
|---|---|---|
| **Max attempts / dead-letter** | Строки с `attempts >= 10` исключаются из SELECT (`AND attempts < $1`). При достижении лимита пишется `WARN`-лог. Строка остаётся в таблице как dead-letter для ручного разбора. | `outbox.publisher.ts` — SELECT-фильтр + `logger.warn` |
| **Circuit breaker** | При первом сбое `producer.send` в batch оставшиеся строки пропускаются. Предотвращает N одинаковых ошибок на N строк при лежащем Kafka. | `outbox.publisher.ts` — `break` в цикле после первого `catch` |
| **Exponential backoff** | После сбоя следующий tick пропускается на `min(1s × 2^n, 60s)`, где n — число последовательных неудач. При успешном batch backoff сбрасывается. | `outbox.publisher.ts` — `nextRetryAt` + `consecutiveFailures` |

Прогрессия backoff: 2с → 4с → 8с → 16с → 32с → 60с (потолок). При даунтайме Kafka в 10 минут вместо 600 ERROR-строк в логе будет ~30.

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
- **Ограничение**: миграция `0_init` (Prisma baseline) содержит `trace_context` вместо устаревшей `trace_id`; строки в outbox до миграции опубликуются как новые корни трасс.

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

Покрыты все четыре сервиса — **138 тестов** (109 unit + 29 integration). Jest разведён на два проекта через `jest.config.ts`:

| Группа | Регистр | Команда | Окружение |
|---|---|---|---|
| `unit` | `*.spec.ts` | `npm run test:unit` | Только моки. Фабрики в `test/helpers/mock-factories.ts`: `createMockPg` (включая `txClientQuery` для проверки `withTransaction`), `createMockRedis` (с `raw().get/set` и `claimIdempotency`), `createMockKafkaProducer`, `pgResult()` для типобезопасных `QueryResult`. |
| `integration` | `*.int-spec.ts` | `npm run test:integration` | `globalSetup` поднимает один Postgres 16 и Redis 7 через `testcontainers`, создаёт 4 базы (`orders`/`payments`/`inventory`/`notifications`), накатывает на каждую её секцию из `scripts/init-db.sql`. Kafka не поднимается — продьюсер/консьюмер мокаются. `--runInBand`, `testTimeout: 60s`. |

`npm test` запускает обе группы. `npm run test:cov` — с покрытием.

**Тестовые хелперы** (`test/helpers/`):
- `createTestPg(service)` — реальный `PgService`, привязанный к базе сервиса через `DATABASE_URL_<SERVICE>`; дефолт — `orders`.
- `createTestRedis()` — реальный `RedisService` к контейнеру.
- `truncate(pg, ...tables)` плюс шорткаты `truncateOrders`/`truncatePayments`/`truncateReservations`/`truncateNotifications` — обнуление таблиц между тестами без рестарта контейнера.

### Unit (`apps/*/src/*.spec.ts`)

#### `apps/orders` (41 тест, 5 файлов)

**`orders.controller.spec.ts` — `OrdersController`** (тонкая обёртка над сервисом):
- `POST /` пробрасывает DTO в `service.createOrder` и возвращает его результат как есть.
- `GET /:id` возвращает строку, если сервис её отдал.
- `GET /:id` бросает `NotFoundException` с текстом `Order <id> not found`, если сервис вернул `null`.

**`orders.service.spec.ts` — `OrdersService`** (ядро саги, всё на моках pg/inventory/payments):
- happy path (5 проверок одного прогона): `INSERT orders` с `PENDING` и корректным `total`; idempotency-key вида `<orderId>:<attemptId>`, оба UUID, один и тот же ключ улетает в `reserve` и `charge`; `ttlSec` из конфига (значение специально не равно дефолту); `amount` в `charge` равен подсчитанному total; `release` не дергается; `withTransaction` ровно один с двумя запросами — `UPDATE orders … CONFIRMED` и `INSERT orders_outbox` с `event_type='OrderConfirmed'` и payload, содержащим `orderId/reservationId/paymentId/customerId/email/total`; результат — `CONFIRMED` с ids.
- ветка `FAILED_INVENTORY` (reserve кинул): `payments.charge` и `inventory.release` не вызываются; failOrder пишет `UPDATE … FAILED_INVENTORY` и `OrderFailed` outbox без `reservationId`; ответ — `FAILED_INVENTORY` с reason.
- ветка `FAILED_PAYMENT` (reserve ок, charge кинул): `inventory.release` вызывается с idempotency-key, оканчивающимся на `:release` (это `<reserveKey>:release`); failOrder пишет `FAILED_PAYMENT` и `OrderFailed` с `reservationId`; ответ — `FAILED_PAYMENT` с reason.
- закреплённый контракт `InventoryClient.release` не бросает: если бросит — failOrder не отработает и заказ останется `PENDING`. Тест документирует это поведение.
- `recoverStuckOrders`: возвращает 0 без транзакций, если нет «зависших»; SELECT использует `sagaTimeoutSec` из конфига; на каждую строку запускает `failOrder(FAILED_TIMEOUT, …)` с сохранением `reservationId`, payload `OrderFailed` без `reservationId` если его в строке не было.
- `getOrder`: `null` при пустом результате, первая строка при наличии.

**`outbox.publisher.spec.ts` — `OutboxPublisher`** (моки pg и kafka, `withSpan` тоже замокан, чтобы заглянуть в `parentTraceparent`):
- `onModuleInit` регистрирует интервал под именем `orders-outbox-publisher`.
- `tick` селектит `FROM orders_outbox` с `published_at IS NULL`, `attempts < $1` и `FOR UPDATE SKIP LOCKED`.
- На успешном `producer.send` каждая строка превращается в конверт `{ eventId, eventType, occurredAt, payload }`, в Kafka летит с `key = aggregate_id` и `topic = orders.events`, затем `UPDATE orders_outbox SET published_at = NOW()` ровно по этой строке.
- Если `producer.send` упал — выполняется `SET attempts = attempts + 1` без `published_at`.
- Circuit breaker: при сбое первой строки в batch остальные не пробуются — `producer.send` вызывается ровно 1 раз.
- Exponential backoff: после сбоя следующий tick пропускается, пока `Date.now() < nextRetryAt`; по истечении backoff tick срабатывает.
- Backoff сбрасывается после полностью успешного batch.
- `row.trace_context` пробрасывается в `withSpan` как `parentTraceparent` (восстановление родителя спана после outbox-границы).
- Защита от наложения тиков: пока первый `tick` висит на SELECT, второй вызов выходит сразу через guard `running` — повторного SELECT не происходит.

**`prisma-exception.filter.spec.ts` — `PrismaExceptionFilter`** (6 тестов):
- P2002 → 409 Conflict, P2025 → 404, P2003 → 400 (related resource), P2014 → 400 (invalid relation), unknown → 500 с логированием.
- Non-HTTP контекст (`host.getType() === 'rpc'`) — ошибка пробрасывается дальше, `switchToHttp` не вызывается.

**`saga-recovery.service.spec.ts` — `SagaRecoveryService`** (fake timers, мок `OrdersService`):
- `onModuleInit` регистрирует один интервал под именем `orders-saga-recovery`.
- На каждый тик (раз в 15 с) дергается `recoverStuckOrders`.
- Ошибку из `recoverStuckOrders` глотает с `logger.error`, интервал продолжает жить — следующий тик отрабатывает.

#### `apps/payments` (22 теста, 3 файла)

**`payments.controller.spec.ts` — `PaymentsController`**:
- `POST /charge` без `Idempotency-Key` бросает `BadRequestException`.
- `POST /charge` с заголовком — пробрасывает DTO и ключ в `service.charge`, возвращает результат.
- `POST /refund` — пробрасывает DTO.
- `GET /by-order/:orderId` — возвращает строку или бросает `NotFoundException('No payment for this order')`.

**`payments.service.spec.ts` — `PaymentsService`** (моки pg + redis; `Math.random` через `jest.spyOn`, `afterEach(restoreAllMocks)`):
- `charge` — cache hit в Redis (`pay:idem:<key>`): возвращает закэшированное, ни одного запроса в pg.
- `charge` — `Math.random() < failureRate` (взят 0.5, mock `Math.random` отдаёт 0.1): `BadGatewayException('Simulated payment provider failure')`, ни одного запроса в pg.
- `charge` — happy: `INSERT INTO payments … ON CONFLICT (idempotency_key) DO NOTHING` с правильными параметрами, последующий `SELECT id, status …`, результат кэшируется в Redis с TTL 24 ч.
- `charge` — параллельный путь ON CONFLICT: INSERT — no-op, SELECT отдаёт чужую строку → возвращаем её `paymentId`, всё равно кэшируем в Redis для следующего вызова.
- `charge` — если re-read внезапно ничего не нашёл: `BadGatewayException('Failed to persist payment')`, Redis не кэшируется.
- `refund` — `NotFoundException` если строки нет; идемпотентен на `REFUNDED` (только SELECT, без UPDATE); на статусе `FAILED` бросает `BadGatewayException('Cannot refund payment in FAILED')`; на `CHARGED` — `UPDATE payments SET status='REFUNDED'`.
- `getByOrder` — первая строка или `null`.

**`prisma-exception.filter.spec.ts` — `PrismaExceptionFilter`** (6 тестов):
- P2002 → 409, P2025 → 404, P2003 → 400, P2014 → 400, unknown → 500, non-HTTP context → rethrow.

#### `apps/inventory` (34 теста, 5 файлов)

**`inventory.controller.spec.ts` — `InventoryController`**:
- `POST /reserve` без `Idempotency-Key` бросает `BadRequestException`.
- `POST /reserve`, `POST /release`, `POST /commit` — пробрасывают DTO в сервис.

**`inventory.service.spec.ts` — `InventoryService`** (моки pg + redis):
- `reserve` — cache hit (`inv:idem:<key>`): возвращает закэшированное, `withTransaction` не вызывается.
- `reserve` — insufficient stock (первый `UPDATE inventory_items` отдал rowCount=0): `ConflictException('Insufficient stock for SKU SKU-A')` — имя первого SKU **в отсортированном порядке** (важная защита от deadlock).
- `reserve` — happy: SKU обновляются в порядке `['SKU-A','SKU-M','SKU-Z']` (входной список перемешан) с правильными `qty`, потом `INSERT INTO reservations` с `items` в том же отсортированном порядке; результат кэшируется в Redis с TTL 24 ч.
- `release` — `NotFoundException` при отсутствии; на `PENDING` обновляет stock и переводит в `RELEASED`; на `COMMITTED`/`RELEASED`/`EXPIRED` — no-op (idempotent, параметризованный тест через `it.each`).
- `commit` — `NotFoundException` при отсутствии; `COMMITTED` — no-op; `RELEASED`/`EXPIRED` — `ConflictException`; `PENDING` — `reserved → sold` для каждой позиции, затем `UPDATE reservations SET status='COMMITTED'`.
- `expirePending` — пустой набор → 0 без транзакций; для каждой строки старше `expires_at` вызывается `release`.

**`inventory.reaper.spec.ts` — `InventoryReaper`** (fake timers):
- `onModuleInit` регистрирует интервал `inventory-ttl-reaper`.
- Каждый тик (30 с) вызывает `inventory.expirePending`.
- Ошибки `expirePending` логируются `logger.error('Reaper failed: …')` и не останавливают цикл.

**`inventory.consumer.spec.ts` — `InventoryConsumer`** (мок `KafkaConsumerService`, ловим зарегистрированный `EnvelopeHandler`):
- Дубль по `eventId` (Redis `claimIdempotency` вернул `false`) — пропуск, без вызовов сервиса.
- `OrderConfirmed` → `inventory.commit({ reservationId })` из payload.
- `OrderFailed` с `reservationId` → `inventory.release({ reservationId })` (компенсация Layer 3).
- `OrderFailed` без `reservationId` → no-op (inventory тут уже не при делах).

**`prisma-exception.filter.spec.ts` — `PrismaExceptionFilter`** (6 тестов):
- P2002 → 409, P2025 → 404, P2003 → 400, P2014 → 400, unknown → 500, non-HTTP context → rethrow.

#### `apps/notifications` (12 тестов, 3 файла)

**`notifications.service.spec.ts` — `NotificationsService`**:
- `sendOrderConfirmedEmail` — `INSERT INTO notifications` с `channel='email'`, `subject='Order confirmed'`, и точным body `Your order <id> for $<total> is confirmed.`.
- `sendOrderFailedEmail` без email — ранний return, без `INSERT`.
- `sendOrderFailedEmail` с email — `INSERT … subject='Order failed'`, body `Order <id> failed: <reason>`.

**`notifications.consumer.spec.ts` — `NotificationsConsumer`**:
- Дубль по `eventId` — пропуск.
- `OrderConfirmed` → `sendOrderConfirmedEmail({ orderId, email, total })`.
- `OrderFailed` → `sendOrderFailedEmail({ orderId, email, reason })`.
- Неизвестный `eventType` — no-op.

**`prisma-exception.filter.spec.ts` — `PrismaExceptionFilter`** (6 тестов):
- P2002 → 409, P2025 → 404, P2003 → 400, P2014 → 400, unknown → 500, non-HTTP context → rethrow.

### Integration (`apps/*/src/*.int-spec.ts`)

`beforeEach` — truncate целевых таблиц и подчистка Redis-ключей в неймспейсе сервиса (`pay:idem:*`/`inv:idem:*`).

#### `apps/orders/src/orders.service.int-spec.ts`

- happy path: после `createOrder` в `orders` лежит строка `CONFIRMED` с `reservation_id`, `payment_id`, `total='19.00'`; в `orders_outbox` ровно одна строка `OrderConfirmed` с `published_at IS NULL` и нужным payload.
- `FAILED_INVENTORY`: в `orders` — `FAILED_INVENTORY` без `reservation_id/payment_id`, в outbox — `OrderFailed` без `reservationId`; `inventory.release` и `payments.charge` не вызывались.
- `FAILED_PAYMENT`: `inventory.release` вызвался с правильным `reservationId`, в `orders` — `FAILED_PAYMENT` со ссылкой на reservation, в outbox — `OrderFailed` с `reservationId`.
- атомарность CONFIRMED + outbox: через хук на `withTransaction` второй query в транзакции принудительно падает; проверяется, что `UPDATE orders` откатился (статус остался `PENDING`) и в `orders_outbox` ноль строк. INSERT `PENDING` до транзакции — не откатывается, это ожидаемо.

#### `apps/orders/src/outbox.publisher.int-spec.ts` (Kafka мокается, Postgres настоящая)

- одиночный издатель публикует все непубликованные строки ровно по разу, `eventId` совпадают со вставленными id; `published_at IS NULL` исчезает.
- при провале `producer.send` строка остаётся неопубликованной, `attempts` инкрементнулся до 1.
- строки с `attempts >= 10` (max attempts) не выбираются поллером — остаются в таблице как dead-letter.
- circuit breaker: при провале первого `producer.send` в batch остальные строки не пробуются, `attempts` увеличен только у первой.
- задокументированная гонка двух publishers: SELECT через `pool.query` авто-коммитится и снимает `FOR UPDATE SKIP LOCKED` раньше, чем стартует `UPDATE`, поэтому два параллельных publisher'а через детерминированные барьеры (без `setTimeout`) видят одни и те же строки и дважды отправляют их в Kafka (`send.mock.calls.length > N`). Все строки в итоге помечены `published_at` — eventually-correct. Тест пиннит текущее поведение; если SELECT+UPDATE завернут в одну транзакцию, тест станет `toBe(N)`.

#### `apps/orders/src/saga-recovery.int-spec.ts`

- старый `PENDING` (age = 100 с при `sagaTimeoutSec=60`) уезжает в `FAILED_TIMEOUT` с `error LIKE '%saga recovery%'`, в outbox появляется `OrderFailed` с тем же `reservationId`; свежий `PENDING` (age = 10 с) не трогается.
- повторный прогон по тому же набору возвращает 0 — `WHERE status='PENDING'` выступает естественным guard, в outbox по-прежнему одна строка.
- задокументированный дубль: ручной `failOrder(FAILED_PAYMENT)` + последующий `failOrder(FAILED_TIMEOUT)` для того же заказа дают две `OrderFailed`-строки в outbox (статус — last-writer-wins). Kafka-консьюмеры дедуплицируют по `eventId`, downstream видит одно событие, но в самой таблице — две строки. Тест фиксирует это до тех пор, пока в `failOrder` не появится status-guard.

#### `apps/payments/src/payments.service.int-spec.ts`

- `charge` — первый вызов вставляет строку, второй с тем же `idemKey` возвращает закэшированное в Redis, в БД по-прежнему одна строка.
- `charge` — конкурентный путь: оба `Promise.all`-вызова форсятся в cache-miss через `spyOn(redis.raw(), 'get')`, оба идут в Postgres → ON CONFLICT (idempotency_key) обеспечивает ровно одну строку, оба возвращают одинаковый `paymentId`.
- `charge` кэширует результат с TTL 24 ч (проверяется в диапазоне с допуском на drift).
- `refund` — `CHARGED → REFUNDED`, повторный refund idempotent (без второго UPDATE).
- `refund` платежа в `FAILED` (вставленного руками) — `BadGatewayException('Cannot refund payment in FAILED')`.

#### `apps/inventory/src/inventory.service.int-spec.ts`

`beforeEach` сидит каталог `SKU-A: 100`, `SKU-B: 50`, `SKU-C: 200`.

- `reserve` happy: `available` уменьшен, `reserved` увеличен ровно на запрошенное qty по каждому SKU; остальные SKU не трогаются; в `reservations` одна строка `PENDING` с `expires_at` в будущем.
- `reserve` insufficient stock: `ConflictException`, `inventory_items` без изменений, `reservations` пуст (rollback транзакции).
- `reserve` идемпотентен по `idemKey`: второй вызов возвращает тот же `reservationId`, без двойного декремента stock, в `reservations` одна строка.
- `release` — `PENDING → RELEASED`, stock возвращён; повторный `release` — no-op, stock не задваивается.
- `commit` — `PENDING → COMMITTED`, `reserved → sold`; commit после release — `ConflictException`.
- `expirePending` — для `PENDING` с back-дейченым `expires_at = NOW() - 1 hour` срабатывает: статус `RELEASED`, stock восстановлен; на свежих `PENDING` (`ttlSec=3600`) ничего не происходит.

#### `apps/notifications/src/notifications.service.int-spec.ts`

- `sendOrderConfirmedEmail` создаёт ряд с `channel='email'`, `subject='Order confirmed'`, точным body.
- `sendOrderFailedEmail` с email создаёт ряд с `subject='Order failed'`, body содержит причину.
- `sendOrderFailedEmail` без email — ноль рядов в таблице.

## Структура

```
apps/{orders,payments,inventory,notifications}/src   — сервисы (controller, service, consumer, …)
apps/*/src/*.spec.ts                                 — unit-тесты рядом с кодом
apps/*/src/*.int-spec.ts                             — integration-тесты против реальных Pg + Redis
libs/common/src/{db,redis,kafka,events,otel,logger}  — общие клиенты и контракты
test/setup/{global-setup,global-teardown}.ts         — testcontainers (Pg + Redis), создаёт 4 БД, накатывает init-db.sql
test/helpers/                                        — mock-factories, createTestPg(service), truncate(...)
jest.config.ts                                       — два projects: unit и integration
apps/*/prisma/                                       — Prisma-схемы и миграции для каждого сервиса
scripts/init-db.sql                                  — схема всех 4 БД + сидинг каталога
Dockerfile                                           — мульти-стейдж, параметризуется SERVICE arg
docker-compose.yml                                   — инфра + 4 сервиса
```
