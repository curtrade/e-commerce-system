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

## Запуск

```bash
docker compose up -d --build
# health
curl :3001/health :3002/health :3003/health :3004/health
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

## Структура

```
apps/{orders,payments,inventory,notifications}/src   — сервисы (controller, service, consumer, …)
libs/common/src/{db,redis,kafka,events}              — общие клиенты и контракты
scripts/init-db.sql                                  — схема всех 4 БД + сидинг каталога
Dockerfile                                           — мульти-стейдж, параметризуется SERVICE arg
docker-compose.yml                                   — инфра + 4 сервиса
```
