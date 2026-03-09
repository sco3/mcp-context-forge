#!/usr/bin/env -S bash

set -ueo pipefail

docker login
# -r reuse 
act -r --pull=false -W .github/workflows/wrapper.yml
