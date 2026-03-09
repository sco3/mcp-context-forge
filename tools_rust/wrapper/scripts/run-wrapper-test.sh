#!/usr/bin/env -S bash

set -ueo pipefail

docker login
# -r reuse 
act --pull=false -W .github/workflows/wrapper.yml
