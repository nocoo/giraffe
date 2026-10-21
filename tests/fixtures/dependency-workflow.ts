export const dependencyWorkflow = `name: CI
jobs:
  api:
    uses: nocoo/base-ci/.github/workflows/test-job.yml@main
  browser:
    uses: nocoo/base-ci/.github/workflows/test-job.yml@main
  checks:
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
`;
