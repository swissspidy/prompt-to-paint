#!/usr/bin/env node
// Node strips the types itself (see the engines floor in package.json), so there
// is no loader to install and nothing here depends on a devDependency being
// present at runtime.
import '../src/cli.ts';
