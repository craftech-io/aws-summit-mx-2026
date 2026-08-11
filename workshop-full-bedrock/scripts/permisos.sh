#!/usr/bin/env bash
# Grant de Lake Formation para la Lambda de herramientas de esta versión.
# El workshop principal ya dejó configurada la integración S3 Tables ↔ Glue
# (scripts/lakehouse-permisos.sh); acá solo falta autorizar al rol nuevo a
# leer la capa gold. Idempotente.
#
#   AWS_PROFILE=... npm run permisos
set -euo pipefail

PREFIJO="${PREFIJO:-summit}"
REGION="${AWS_REGION:-us-east-1}"
CUENTA=$(aws sts get-caller-identity --query Account --output text)
CATALOGO="${CUENTA}:s3tablescatalog/${PREFIJO}-lakehouse"
BASE="craftech_store"

ROL=$(aws cloudformation describe-stacks --stack-name "${PREFIJO}-full" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='RolHerramientas'].OutputValue" --output text)
[ -z "$ROL" ] && { echo "No encontré el rol: ¿está desplegado ${PREFIJO}-full?"; exit 1; }

echo "Rol de herramientas: $ROL"

grant() {
  local recurso="$1"
  aws lakeformation grant-permissions --region "$REGION" \
    --principal "DataLakePrincipalIdentifier=$ROL" \
    --permissions SELECT DESCRIBE \
    --resource "$recurso" >/dev/null \
    && echo "  grant OK → $recurso" \
    || echo "  (ya estaba) → $recurso"
}

grant "{\"Table\":{\"CatalogId\":\"$CATALOGO\",\"DatabaseName\":\"$BASE\",\"Name\":\"ventas_gold\"}}"

echo "Listo: la Lambda de herramientas puede leer ventas_gold vía Athena."
