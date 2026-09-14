/** Enforces the one-way dependency rule from docs/plan/01-architecture.md. */
module.exports = {
  forbidden: [
    {
      name: 'plugins-must-not-import-core',
      severity: 'error',
      comment: 'Plugins depend on @scheduler/plugin-sdk only. Importing core makes them unswappable.',
      from: { path: '^packages/plugin-(?!sdk)' },
      to: { path: '^packages/core' },
    },
    {
      name: 'core-must-not-import-a-plugin',
      severity: 'error',
      comment: 'Core discovers plugins through the registry; naming one directly breaks extensibility.',
      from: { path: '^packages/core' },
      to: { path: '^packages/plugin-(?!sdk)' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node'] },
  },
}
