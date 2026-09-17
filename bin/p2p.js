#!/usr/bin/env node
// Node strips the types itself (>=22.18), so there is no loader to install and
// nothing here depends on a devDependency being present at runtime.
import '../src/cli.ts';
