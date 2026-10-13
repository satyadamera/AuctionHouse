-- Runs once when the MySQL container is first created.
-- The test database is separate so integration tests never touch demo data.
CREATE DATABASE IF NOT EXISTS auctra_test;
-- Prisma Migrate needs to create a temporary "shadow" database during `migrate dev`,
-- so the dev user needs global CREATE/DROP. This is a local-development-only grant.
GRANT ALL PRIVILEGES ON *.* TO 'auctra'@'%';
FLUSH PRIVILEGES;
