# GitHub Unavailability Fixtures

The REST alerts contract documents 403 and 404, and requires Dependabot alerts
read permission: https://docs.github.com/en/rest/dependabot/alerts#list-dependabot-alerts-for-a-repository

Permission messages and intentionally ambiguous 404s are documented in REST
troubleshooting: https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api

`github-unavailable.ts` uses minimal response bodies for explicit feature-disabled
wording, documented permission wording, generic `Not Found`, and an unknown
message. Disabled wording is matched only when present: neither HTTP 404 nor the
Dependabot endpoint alone proves the feature is disabled. An explicit disabled
message is recognized with either 403 or 404. Extra diagnostics are never retained.
