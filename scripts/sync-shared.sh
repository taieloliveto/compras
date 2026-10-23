#!/bin/sh
# Copia shared/merge.js a la app (script clásico) y al servidor (módulo ES).
set -e
cd "$(dirname "$0")/.."
cp shared/merge.js web/merge.js
{ cat shared/merge.js; printf '\nexport { mergeState, sanitizeState, emptyState, norm };\n'; } > server/src/merge.js
echo "merge.js sincronizado en web/ y server/src/"
