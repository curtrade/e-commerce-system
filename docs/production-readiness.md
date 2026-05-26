# Production Readiness Checklist

## Готово

- [x] CI/CD пайплайн (GitHub Actions: lint, test, build matrix, deploy staging/prod)
- [x] Docker Swarm стек (docker-stack.yml с replicas, rolling updates, healthchecks)
- [x] Security headers (Helmet: X-Content-Type-Options, X-Frame-Options, HSTS)
- [x] CORS (enableCors во всех сервисах)
- [x] Rate limiting (@nestjs/throttler: 60 req/min на IP, @SkipThrottle на /health)
- [x] ESLint — 0 ошибок (86 исправлено)
- [x] Секреты (Docker Swarm Secrets: entrypoint инъекция, .env.secrets на сервере, create-swarm-secrets.sh)
- [x] Prometheus-метрики (OTEL SDK → OTEL Collector → Prometheus → Grafana)

## Важно (до первых пользователей)

- [x] Swagger/OpenAPI — /docs на orders(:3001), payments(:3002), inventory(:3003)
- [x] E2E-тесты (docker compose + Jest: saga happy path, FAILED_INVENTORY, validation, Kafka propagation)
- [ ] **Алерты в Grafana** — дашборды есть, но нет threshold-алертов (latency, error rate, outbox backlog)
- [ ] **Бэкапы БД** — нет скриптов backup/restore и cron-расписания
- [ ] **Реальный email-провайдер** — NotificationsService пишет в БД, но не отправляет (SendGrid / AWS SES)
- [ ] **Реальный платёжный шлюз** — PaymentsService — мок с FAILURE_RATE. Нужен Stripe / YooKassa

## Желательно (улучшает надёжность)

- [ ] **Event schema registry** — Kafka-события не версионированы. Изменение формата — breaking change для консьюмеров
- [ ] **Dead Letter Topic** — outbox помечает "мёртвые" строки, но Kafka DLT не настроен
- [ ] **Liveness/Readiness пробы** — `/health` возвращает `{ status: 'ok' }`, но не проверяет Postgres/Redis/Kafka. K8s/Swarm не сможет корректно маршрутизировать трафик
- [ ] **Soft deletes** — все DELETE жёсткие. Для e-commerce нужна возможность восстановления (заказы, платежи)
- [ ] **Multi-env конфиги** — нет `.env.prod` / `.env.staging`. Одна среда — один конфиг
- [ ] **Coverage thresholds** — Jest собирает покрытие, но нет порога (80%+) — регрессия незаметна

## На перспективу

- [ ] **Kubernetes-манифесты** (Helm chart / Kustomize) — для горизонтального масштабирования
- [ ] **Полнотекстовый поиск** (Elasticsearch / Meilisearch) — по товарам и заказам
- [ ] **Файловый storage** (S3) — изображения товаров
- [ ] **Chaos testing** — поведение при падении Kafka, Redis, БД
