.PHONY: up down logs test reset

up:
	docker compose up -d --wait

down:
	docker compose down

logs:
	docker compose logs -f keycloak

test:
	./scripts/smoke-test.sh

# Deletes this project's local PostgreSQL volume so the realm can be re-imported.
reset:
	docker compose down --volumes
	docker compose up -d --wait
