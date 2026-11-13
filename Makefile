URL ?= http://localhost:8000

.PHONY: test smoke fixtures

test:
	python -m pytest -q

smoke:
	python tests/smoke.py $(URL)

fixtures:
	python synth/fixture_gen.py
