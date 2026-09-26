#!/bin/bash

set -eu

case "${1:-}" in
  --version)
    printf 'sqd fake 0.0.0\n'
    exit 0
    ;;
  ls)
    printf 'temporary service failure\n' >&2
    exit 42
    ;;
  logs)
    if [ "${SQD_PERF_FAKE_SHORT:-0}" -eq 1 ]; then
      printf 'api 2026-01-01T00:00:00.000Z INFO sqd:processor 1 / 10\n'
      exit "${SQD_PERF_FAKE_LOGS_EXIT:-42}"
    fi
    if [ "${SQD_PERF_FAKE_ANSI:-0}" -eq 1 ]; then
      printf 'api 2026-01-01T00:00:00.000Z \033[32mINFO\033[0m sqd:processor 1 / 10\n'
      printf 'api 2026-01-01T00:00:01.000Z \033[36mNOTICE\033[0m app queued 1 items\n'
      printf 'api 2026-01-01T00:00:02.000Z \033[32mINFO\033[0m sqd:processor 2 / 10\n'
      printf 'api 2026-01-01T00:00:03.000Z \033[32mINFO\033[0m sqd:processor 3 / 10\n'
      printf 'api 2026-01-01T00:00:04.000Z \033[32mINFO\033[0m sqd:processor 4 / 10\n'
      printf 'api 2026-01-01T00:00:05.000Z \033[32mINFO\033[0m sqd:processor 5 / 10\n'
    else
      printf 'api 2026-01-01T00:00:00.000Z INFO sqd:processor 1 / 10\n'
      printf 'api 2026-01-01T00:00:01.000Z NOTICE app queued 1 items\n'
      printf 'api 2026-01-01T00:00:02.000Z INFO sqd:processor 2 / 10\n'
      printf 'api 2026-01-01T00:00:03.000Z INFO sqd:processor 3 / 10\n'
      printf 'api 2026-01-01T00:00:04.000Z INFO sqd:processor 4 / 10\n'
      printf 'api 2026-01-01T00:00:05.000Z INFO sqd:processor 5 / 10\n'
    fi
    exit "${SQD_PERF_FAKE_LOGS_EXIT:-42}"
    ;;
esac

exit 42
