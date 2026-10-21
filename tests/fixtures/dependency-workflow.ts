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

export const unsupportedWorkflowJobs = [
	"",
	"# no jobs saved",
	"name: CI",
	"jobs: { build: { uses: actions/checkout@v4 } }",
	"jobs:\n  build: *shared",
	"jobs:\n  build: { uses: actions/checkout@v4 }",
	"jobs:\n  build:\n    steps: *shared",
	"jobs:\n  build:\n    steps: [{ uses: actions/checkout@v4 }]",
	`jobs:\n  build:\n    uses: \${{ inputs.workflow }}`,
	"jobs:\n  build:\n    <<: *shared",
	"jobs:\n  build:\n    steps:\n      - *shared",
	"jobs:\n  build:\n    steps:\n      - { uses: actions/checkout@v4 }",
	"jobs:\n  # no job mapping",
	"jobs:\n  build:\n    steps: []\njobs:\n  another:\n    steps: []",
	"jobs: *shared",
	"jobs:\n  build:\n    { uses: nocoo/base-ci/.github/workflows/test-job.yml@main }",
	"jobs:\n  build:\n    steps:\n      [{ uses: actions/checkout@v4 }]",
	"jobs:\n  build:\n    steps:\n      - ? uses\n        : actions/checkout@v4",
	"jobs:\n  build:\n    *shared",
	"jobs:\n  build:",
	"jobs:\n  build: # empty job\n  next:\n    steps: []",
	"jobs:\n  build:\n    - run: echo hello",
	"jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:",
	"jobs:\n  build:\n    steps: # empty steps\n    name: Build",
	"jobs:\n  build:\n    steps:\n      run: echo hello",
	'jobs:\n  build:\n    steps:\n      - run: "echo hello\n          uses: fake/script@v1"',
	"jobs:\n  build:\n    steps:\n      - run: 'echo hello\n          uses: fake/script@v1'",
	"jobs:\n  build:\n    steps:\n      - run: !!str |\n          uses: fake/script@v1",
	"jobs:\n  build:\n    steps:\n      - run: &script |\n          uses: fake/script@v1",
	"jobs:\n  build:\n    steps:\n      - run: echo hello\n          uses:fake/script@v1",
	"jobs:\n  build:\n    env:\n      uses: fake/environment@v1\n    steps:\n      - run: echo hello",
	"jobs:\n  build:\n    steps:\n      - run: echo hello\n        env:\n          uses: fake/environment@v1",
	"jobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          uses: actions/checkout@v3",
];
