-include .env
export

URL ?= http://localhost
VPS ?= root@179.67.199.112
REMOTE_DIR ?= live-truth-radar
COMPOSE = docker compose -f infra/docker-compose.yml --env-file .env

.PHONY: setup test smoke fixtures eval deploy

setup:  ## local dev env (Python >= 3.11)
	pip install -r requirements.txt -r requirements-dev.txt

test:  ## offline, < 5 s; run before every commit
	python -m pytest -q

smoke:  ## after every deploy: make smoke URL=https://<domain>
	python tests/smoke.py $(URL)

fixtures:  ## regenerate fixtures/items.json + findings.json (never hand-edit them)
	python synth/fixture_gen.py

eval:  ## P2 (or P1 after T14): Gemini embedder + cache, writes eval/report.json; commit it, then make deploy
	LTR_EMBEDDER=gemini python -m eval.run

deploy:  ## P1: pull main on the VPS and rebuild (eval/ is mounted read-only, no rebuild needed for report.json)
	ssh $(VPS) 'cd $(REMOTE_DIR) && git pull --ff-only && $(COMPOSE) up -d --build'
