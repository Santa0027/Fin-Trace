#!/bin/bash
set -a
source .env.integration
set +a
.venv/bin/python -m pytest -m integration -v
