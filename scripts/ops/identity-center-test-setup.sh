#!/usr/bin/env bash
# Test Identity Center setup for Device Code verification (personal/test account only, explicit owner approval).
# Prerequisite: the organization instance is already enabled in the console (the API cannot enable it in a
# management account). Idempotent: existing user/permission set/assignment are reused.
#   bash scripts/identity-center-test-setup.sh <email> [region]
# Writes the connection values to .data/identity-center-test.json (Git-ignored). Prints no credentials.
set -euo pipefail
EMAIL="${1:?usage: $0 <email> [region]}"
REGION="${2:-us-east-1}"
PERMISSION_SET="CloudOpsReadOnly"
aws_() { aws --region "$REGION" --output text "$@"; }

INSTANCE_ARN="$(aws_ sso-admin list-instances --query 'Instances[0].InstanceArn')"
STORE_ID="$(aws_ sso-admin list-instances --query 'Instances[0].IdentityStoreId')"
if [ "$INSTANCE_ARN" = "None" ] || [ -z "$INSTANCE_ARN" ]; then echo "Identity Center is not enabled in $REGION. Enable the organization instance in the console first." >&2; exit 1; fi
ACCOUNT="$(aws_ sts get-caller-identity --query Account)"

USER_ID="$(aws_ identitystore list-users --identity-store-id "$STORE_ID" --filters "AttributePath=UserName,AttributeValue=$EMAIL" --query 'Users[0].UserId')"
if [ "$USER_ID" = "None" ] || [ -z "$USER_ID" ]; then
  USER_ID="$(aws_ identitystore create-user --identity-store-id "$STORE_ID" --user-name "$EMAIL" --display-name "CloudOps Test" \
    --name "GivenName=CloudOps,FamilyName=Test" --emails "Value=$EMAIL,Type=work,Primary=true" --query UserId)"
  echo "created Identity Center user"
else echo "reusing Identity Center user"; fi

PS_ARN=""
for arn in $(aws_ sso-admin list-permission-sets --instance-arn "$INSTANCE_ARN" --query 'PermissionSets[]'); do
  if [ "$(aws_ sso-admin describe-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$arn" --query 'PermissionSet.Name')" = "$PERMISSION_SET" ]; then PS_ARN="$arn"; fi
done
if [ -z "$PS_ARN" ]; then
  PS_ARN="$(aws_ sso-admin create-permission-set --instance-arn "$INSTANCE_ARN" --name "$PERMISSION_SET" --session-duration PT1H \
    --description "CloudOps Auto read-only test" --query 'PermissionSet.PermissionSetArn')"
  aws_ sso-admin attach-managed-policy-to-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$PS_ARN" \
    --managed-policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess >/dev/null
  echo "created permission set $PERMISSION_SET (ReadOnlyAccess)"
else echo "reusing permission set $PERMISSION_SET"; fi

ASSIGNED="$(aws_ sso-admin list-account-assignments --instance-arn "$INSTANCE_ARN" --account-id "$ACCOUNT" --permission-set-arn "$PS_ARN" \
  --query "AccountAssignments[?PrincipalId=='$USER_ID'] | length(@)")"
if [ "$ASSIGNED" = "0" ]; then
  REQUEST="$(aws_ sso-admin create-account-assignment --instance-arn "$INSTANCE_ARN" --target-id "$ACCOUNT" --target-type AWS_ACCOUNT \
    --permission-set-arn "$PS_ARN" --principal-type USER --principal-id "$USER_ID" --query 'AccountAssignmentCreationStatus.RequestId')"
  for _ in $(seq 1 30); do
    STATUS="$(aws_ sso-admin describe-account-assignment-creation-status --instance-arn "$INSTANCE_ARN" --account-assignment-creation-request-id "$REQUEST" --query 'AccountAssignmentCreationStatus.Status')"
    [ "$STATUS" = "IN_PROGRESS" ] || break; sleep 2
  done
  [ "$STATUS" = "SUCCEEDED" ] || { echo "account assignment status: $STATUS" >&2; exit 1; }
  echo "assigned $PERMISSION_SET to the user on this account"
else echo "reusing account assignment"; fi

mkdir -p .data && chmod 700 .data
cat > .data/identity-center-test.json <<JSON
{
  "configurationId": "aws-read",
  "label": "Test read-only access",
  "startUrl": "https://${STORE_ID}.awsapps.com/start",
  "ssoRegion": "${REGION}",
  "accountId": "${ACCOUNT}",
  "roleName": "${PERMISSION_SET}",
  "region": "${REGION}"
}
JSON
chmod 600 .data/identity-center-test.json
echo "wrote .data/identity-center-test.json (Git-ignored)."
echo "Next: in the console, Users -> this user -> Reset password -> send an email, then set the password and MFA yourself."
