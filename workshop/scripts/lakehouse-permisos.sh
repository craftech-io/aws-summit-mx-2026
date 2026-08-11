#!/usr/bin/env bash
# Habilita la integración S3 Tables ↔ Glue/Lake Formation (si hace falta) y
# da los permisos de Lake Formation que necesitan el rol del agente y quien
# corre el seed.
#
#   AWS_PROFILE=... ./scripts/lakehouse-permisos.sh
#
# Es idempotente: cada paso primero mira si ya está hecho. Es el único paso
# del lab que no vive en CDK, porque tocar la configuración de Lake Formation
# de la cuenta (administradores, catálogo federado) es una operación a nivel
# cuenta con estado previo desconocido: acá se resuelve mirando antes de tocar.
set -euo pipefail

PREFIJO="${PREFIJO:-summit}"
REGION="${AWS_REGION:-us-east-1}"
CUENTA=$(aws sts get-caller-identity --query Account --output text)
BUCKET_TABLAS="${PREFIJO}-lakehouse"
CATALOGO_FED="s3tablescatalog"
BASE="craftech_store"

echo "Cuenta: $CUENTA · región: $REGION"

# ── 1. ¿Quién soy? El principal para LF es el rol IAM, no el ARN asumido ──
ARN_ASUMIDO=$(aws sts get-caller-identity --query Arn --output text)
if [[ "$ARN_ASUMIDO" == *:assumed-role/* ]]; then
  NOMBRE_ROL=$(echo "$ARN_ASUMIDO" | cut -d/ -f2)
  ARN_YO=$(aws iam list-roles --path-prefix /aws-reserved/ \
    --query "Roles[?RoleName=='$NOMBRE_ROL'].Arn" --output text)
  [ -z "$ARN_YO" ] && ARN_YO=$(aws iam get-role --role-name "$NOMBRE_ROL" --query Role.Arn --output text)
else
  ARN_YO="$ARN_ASUMIDO"
fi
echo "Principal propio: $ARN_YO"

ARN_AGENTE=$(aws cloudformation describe-stacks --stack-name "${PREFIJO}-agente" \
  --query "Stacks[0].Outputs[?OutputKey=='RolAgente'].OutputValue" --output text)
echo "Rol del agente:  $ARN_AGENTE"

# ── 2. Administrador de Lake Formation ────────────────────────────────
# Sin ser admin no se pueden dar grants. Se agrega el rol propio a la lista
# SIN tocar a los administradores que ya existan.
ADMINS=$(aws lakeformation get-data-lake-settings --region "$REGION" \
  --query 'DataLakeSettings.DataLakeAdmins[].DataLakePrincipalIdentifier' --output text)
if [[ "$ADMINS" != *"$ARN_YO"* ]]; then
  echo "Agregándome como administrador de Lake Formation…"
  NUEVOS=$(aws lakeformation get-data-lake-settings --region "$REGION" --output json |
    /usr/bin/env python3 -c "
import json, sys
d = json.load(sys.stdin)['DataLakeSettings']
admins = d.get('DataLakeAdmins', [])
admins.append({'DataLakePrincipalIdentifier': '$ARN_YO'})
d['DataLakeAdmins'] = admins
print(json.dumps(d))")
  aws lakeformation put-data-lake-settings --region "$REGION" --data-lake-settings "$NUEVOS"
else
  echo "Ya soy administrador de Lake Formation."
fi

# ── 3. Integración S3 Tables ↔ Glue (catálogo federado) ───────────────
if aws glue get-catalog --catalog-id "$CATALOGO_FED" --region "$REGION" >/dev/null 2>&1; then
  echo "El catálogo federado $CATALOGO_FED ya existe."
else
  echo "Creando la integración con el catálogo federado…"

  ROL_LF="S3TablesRoleForLakeFormation"
  if ! aws iam get-role --role-name "$ROL_LF" >/dev/null 2>&1; then
    aws iam create-role --role-name "$ROL_LF" --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "lakeformation.amazonaws.com" },
        "Action": ["sts:AssumeRole", "sts:SetContext", "sts:SetSourceIdentity"]
      }]
    }' >/dev/null
    aws iam put-role-policy --role-name "$ROL_LF" --policy-name "AccesoS3Tables" --policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Action": ["s3tables:*"],
        "Resource": "*"
      }]
    }'
    echo "  rol $ROL_LF creado; esperando propagación de IAM…"
    sleep 12
  fi

  ARN_RECURSO="arn:aws:s3tables:${REGION}:${CUENTA}:bucket/*"
  aws lakeformation register-resource --region "$REGION" \
    --resource-arn "$ARN_RECURSO" \
    --role-arn "arn:aws:iam::${CUENTA}:role/${ROL_LF}" \
    --with-federation 2>/dev/null || echo "  (el recurso ya estaba registrado)"

  aws glue create-catalog --region "$REGION" --name "$CATALOGO_FED" --catalog-input "{
    \"FederatedCatalog\": {
      \"Identifier\": \"$ARN_RECURSO\",
      \"ConnectionName\": \"aws:s3tables\"
    },
    \"CreateDatabaseDefaultPermissions\": [],
    \"CreateTableDefaultPermissions\": []
  }"
  echo "  catálogo federado creado."
fi

# ── 4. Grants sobre las tablas del lab ────────────────────────────────
CATALOGO_BUCKET="${CUENTA}:${CATALOGO_FED}/${BUCKET_TABLAS}"

conceder() {
  local principal="$1"; shift
  local permisos="$1"; shift
  echo "Grant [$permisos] a $principal"
  aws lakeformation grant-permissions --region "$REGION" \
    --principal "DataLakePrincipalIdentifier=$principal" \
    --permissions $permisos \
    --resource "{\"Table\": {\"CatalogId\": \"$CATALOGO_BUCKET\", \"DatabaseName\": \"$BASE\", \"TableWildcard\": {}}}"
}

# El agente solo lee. Quien corre el seed también escribe.
conceder "$ARN_AGENTE" "SELECT DESCRIBE"
conceder "$ARN_YO" "ALL"

# DESCRIBE sobre la base para que aparezca al navegar el catálogo.
aws lakeformation grant-permissions --region "$REGION" \
  --principal "DataLakePrincipalIdentifier=$ARN_AGENTE" \
  --permissions DESCRIBE \
  --resource "{\"Database\": {\"CatalogId\": \"$CATALOGO_BUCKET\", \"Name\": \"$BASE\"}}" 2>/dev/null ||
  echo "  (DESCRIBE de base ya otorgado o no aplicable)"

echo
echo "Listo. El agente puede leer ${BASE}.* y este rol puede sembrar."
