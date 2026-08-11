#!/usr/bin/env bash
# El lab entero en un solo comando: deploy, permisos del lakehouse, ingesta
# de la Knowledge Base y los dos seeds. La guía recorre estos pasos de a uno
# (y esa sigue siendo la mejor forma de entenderlos); este atajo existe para
# cuando ya hiciste el lab y querés levantarlo de nuevo en tu cuenta.
#
#   npm run todo                      # deploy + permisos + ingesta (aún sin login)
#   npm run todo -- <clienteId>       # todo, incluidos los seeds con tus datos
#
# El clienteId es el «sub» de Cognito y recién existe después del primer
# login (paso 4). Todos los pasos son idempotentes: correrlo de nuevo con el
# clienteId completa lo que faltaba sin duplicar nada.
set -euo pipefail

CLIENTE="${1:-${CLIENTE_ID:-}}"
TOTAL=$([ -n "$CLIENTE" ] && echo 6 || echo 4)

paso() { printf '\n\033[1m── Paso %s de %s · %s ──\033[0m\n\n' "$1" "$TOTAL" "$2"; }

paso 1 "Build del front (webapp compartida)"
(cd ../webapp && npm install --no-audit --no-fund && npm run build)

paso 2 "Deploy de los cinco stacks"
npm run deploy

paso 3 "Integración y permisos de Lake Formation"
npm run lakehouse:permisos

paso 4 "Ingesta de la Knowledge Base"
npm run kb:ingesta

if [ -n "$CLIENTE" ]; then
  paso 5 "Seed del lakehouse (ventas gold y detalle)"
  CLIENTE_ID="$CLIENTE" npm run seed:lakehouse

  paso 6 "Seed de pedidos y documentos"
  npm run seed -- "$CLIENTE"

  printf '\nListo: infraestructura, conocimiento y datos. La URL del sitio está en las salidas de summit-web.\n'
else
  printf '\nInfraestructura y conocimiento listos. Faltan los seeds, que necesitan tu clienteId\n'
  printf '(el «sub» de Cognito: aparece en la app después del primer login — paso 4 de la guía).\n\n'
  printf 'Cuando lo tengas:  npm run todo -- <clienteId>\n'
fi
