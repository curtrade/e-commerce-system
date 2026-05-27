-- Bootstrap one Postgres instance with one database per microservice.
-- Runs only on first volume init (docker-entrypoint-initdb.d).
-- Tables are created by Prisma migrations (prisma migrate deploy).

CREATE DATABASE orders;
CREATE DATABASE payments;
CREATE DATABASE inventory;
CREATE DATABASE notifications;
