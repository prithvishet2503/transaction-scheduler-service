SHELL := /bin/bash

.PHONY: install build typecheck test test-watch run run-api run-worker run-reaper local-up local-down clean lint format

## Install dependencies
install:
	npm install

## Compile TypeScript to dist/
build:
	npm run build

## Typecheck without emitting
typecheck:
	npm run typecheck

## Run the unit/integration test suite (vitest)
test:
	npm test

test-watch:
	npm run test:watch

## Lint / format
lint:
	npm run lint

format:
	npm run format

## Run the API server
run:
	npm start

## Run the API server in dev (tsx watch)
run-api:
	npm run dev

## Run the cron worker (executes due schedules)
run-worker:
	node dist/workers/cronWorker.js

## Run the reaper (re-arms stuck claims)
run-reaper:
	node dist/workers/reaper.js

## Local stack (MongoDB) via docker-compose
local-up:
	@docker compose -f local-stack/docker-compose.local.yml up -d

local-down:
	@docker compose -f local-stack/docker-compose.local.yml down

clean:
	rm -rf dist coverage
