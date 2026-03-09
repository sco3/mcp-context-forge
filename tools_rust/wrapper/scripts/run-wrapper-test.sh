#!/usr/bin/env -S bash

set -ueo pipefail

# Make sure you are logged in to Docker before running this script, e.g. by running 'docker login'.
act --pull=false -W .github/workflows/wrapper.yml
