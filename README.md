# gta6-twitch-ccu-forecast-01 v3

A make.fun GTA VI launch-day Twitch viewers forecast: pooled kernel-weighted log-ratio curves over past big launches, with console-first and simultaneous-global launch weightings. Deterministic, Node 22 stdlib only, no network.

## Run

`node main.ts` — reads cases from `$MAKEFUN_INPUT_DIR` (default `/input`), writes forecasts to `$MAKEFUN_OUTPUT_DIR` (default `/output`).
