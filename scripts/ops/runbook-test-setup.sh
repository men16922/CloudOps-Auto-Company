#!/usr/bin/env bash
# Runbook verification setup for a personal/test account (explicit owner approval). Idempotent.
#   AWS_PROFILE=<admin profile> bash scripts/ops/runbook-test-setup.sh [region]
# Creates (or reuses):
#   - SSM Automation document CloudOps-ConnectivityCheck (a 2-second sleep; changes no resources) in <region>
#   - permission set CloudOpsRunbookOperator: start only the catalog runbooks, read their executions, and the EC2
#     start/stop/reboot calls the AWS EC2 runbooks make when run with the caller's permissions
#   - an assignment of that permission set to the user who already holds CloudOpsReadOnly on this account
# Prints no credentials or identifiers beyond what the AWS CLI echoes for names.
set -euo pipefail
REGION="${1:-us-east-1}"
READ_SET="CloudOpsReadOnly"; RUNBOOK_SET="CloudOpsRunbookOperator"; DOCUMENT="CloudOps-ConnectivityCheck"
aws_() { aws --region "$REGION" --output text "$@"; }

INSTANCE_ARN="$(aws_ sso-admin list-instances --query 'Instances[0].InstanceArn')"
if [ "$INSTANCE_ARN" = "None" ] || [ -z "$INSTANCE_ARN" ]; then echo "Identity Center is not enabled in $REGION." >&2; exit 1; fi
ACCOUNT="$(aws_ sts get-caller-identity --query Account)"
permission_set() { for arn in $(aws_ sso-admin list-permission-sets --instance-arn "$INSTANCE_ARN" --query 'PermissionSets[]'); do
  [ "$(aws_ sso-admin describe-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$arn" --query 'PermissionSet.Name')" = "$1" ] && echo "$arn"; done; return 0; }

READ_ARN="$(permission_set "$READ_SET")"
[ -n "$READ_ARN" ] || { echo "Run scripts/ops/identity-center-test-setup.sh first ($READ_SET is missing)." >&2; exit 1; }
USER_ID="$(aws_ sso-admin list-account-assignments --instance-arn "$INSTANCE_ARN" --account-id "$ACCOUNT" --permission-set-arn "$READ_ARN" \
  --query "AccountAssignments[?PrincipalType=='USER'] | [0].PrincipalId")"
[ "$USER_ID" != "None" ] && [ -n "$USER_ID" ] || { echo "No user holds $READ_SET on this account." >&2; exit 1; }

if aws_ ssm describe-document --name "$DOCUMENT" --query 'Document.Name' >/dev/null 2>&1; then echo "reusing document $DOCUMENT"; else
  aws_ ssm create-document --name "$DOCUMENT" --document-type Automation --document-format JSON --content \
    '{"schemaVersion":"0.3","description":"CloudOps Auto connectivity check: waits two seconds and changes nothing.","mainSteps":[{"name":"wait","action":"aws:sleep","inputs":{"Duration":"PT2S"}}]}' >/dev/null
  echo "created document $DOCUMENT"
fi

POLICY=$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Sid":"StartCatalogRunbooks","Effect":"Allow","Action":"ssm:StartAutomationExecution","Resource":[
  "arn:aws:ssm:*:*:automation-definition/AWS-StartEC2Instance:*","arn:aws:ssm:*:*:automation-definition/AWS-StopEC2Instance:*",
  "arn:aws:ssm:*:*:automation-definition/AWS-RestartEC2Instance:*","arn:aws:ssm:*:${ACCOUNT}:automation-definition/${DOCUMENT}:*"]},
 {"Sid":"ReadExecutions","Effect":"Allow","Action":["ssm:GetAutomationExecution","ssm:DescribeAutomationStepExecutions"],"Resource":"*"},
 {"Sid":"Ec2CallsMadeByTheCatalogRunbooks","Effect":"Allow","Action":["ec2:StartInstances","ec2:StopInstances","ec2:RebootInstances","ec2:DescribeInstances","ec2:DescribeInstanceStatus"],"Resource":"*"}]}
JSON
)
RUNBOOK_ARN="$(permission_set "$RUNBOOK_SET")"
if [ -z "$RUNBOOK_ARN" ]; then
  RUNBOOK_ARN="$(aws_ sso-admin create-permission-set --instance-arn "$INSTANCE_ARN" --name "$RUNBOOK_SET" --session-duration PT1H \
    --description "CloudOps Auto catalog runbooks (test)" --query 'PermissionSet.PermissionSetArn')"
  echo "created permission set $RUNBOOK_SET"
else echo "reusing permission set $RUNBOOK_SET"; fi
aws_ sso-admin put-inline-policy-to-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$RUNBOOK_ARN" --inline-policy "$POLICY" >/dev/null

wait_for() { for _ in $(seq 1 40); do STATUS="$(aws_ sso-admin "$1" --instance-arn "$INSTANCE_ARN" "$2" "$3" --query "$4")"; [ "$STATUS" = "IN_PROGRESS" ] || break; sleep 3; done
  [ "$STATUS" = "SUCCEEDED" ] || { echo "$1: $STATUS" >&2; exit 1; }; }
ASSIGNED="$(aws_ sso-admin list-account-assignments --instance-arn "$INSTANCE_ARN" --account-id "$ACCOUNT" --permission-set-arn "$RUNBOOK_ARN" \
  --query "AccountAssignments[?PrincipalId=='$USER_ID'] | length(@)")"
if [ "$ASSIGNED" = "0" ]; then
  REQUEST="$(aws_ sso-admin create-account-assignment --instance-arn "$INSTANCE_ARN" --target-id "$ACCOUNT" --target-type AWS_ACCOUNT \
    --permission-set-arn "$RUNBOOK_ARN" --principal-type USER --principal-id "$USER_ID" --query 'AccountAssignmentCreationStatus.RequestId')"
  wait_for describe-account-assignment-creation-status --account-assignment-creation-request-id "$REQUEST" 'AccountAssignmentCreationStatus.Status'
  echo "assigned $RUNBOOK_SET to the $READ_SET user on this account"
else
  # Re-provision so an updated inline policy reaches the account.
  REQUEST="$(aws_ sso-admin provision-permission-set --instance-arn "$INSTANCE_ARN" --permission-set-arn "$RUNBOOK_ARN" --target-type AWS_ACCOUNT --target-id "$ACCOUNT" \
    --query 'PermissionSetProvisioningStatus.RequestId')"
  wait_for describe-permission-set-provisioning-status --provision-permission-set-request-id "$REQUEST" 'PermissionSetProvisioningStatus.Status'
  echo "reusing assignment; policy re-provisioned"
fi
echo "Next: add to the connection in the deployment JSON: \"runbooks\": {\"roleName\": \"$RUNBOOK_SET\", \"allowed\": [...]}, give members operator/reviewer roles, restart the host."
