# @nestjs/swagger plugin — deep relative `require()` in monorepos

Minimal reproduction showing that the `@nestjs/swagger` CLI plugin emits
**filesystem-relative `require()` calls** in `_OPENAPI_METADATA_FACTORY` when a
DTO references a type defined in a sibling workspace package, *even when the
source imports the package via its public subpath*.

## Versions

| Tool             | Version  |
|------------------|----------|
| pnpm             | 11.23.0  |
| turbo            | 2.10.x   |
| TypeScript       | 5.9.x    |
| NestJS           | 11.2.1   |
| `@nestjs/swagger`| 11.4.7   |
| Node             | 22       |

Last verified: 2026-08-24. See [Status on current versions](#status-on-current-versions)
for results on `@nestjs/swagger` v12 (git `master`) as well.

## Layout

```
apps/api/                       NestJS app, swagger plugin enabled
  src/items/item.dto.ts         imports ItemStatus from @repro/shared/messages
packages/shared/                Library workspace package
  src/messages/item.ts          defines ItemStatus
  package.json                  exposes "." and "./messages" via exports map
```

## How the consumer imports the type

`apps/api/src/items/item.dto.ts`:

```ts
import { ItemStatus } from "@repro/shared/messages";

export class ItemDto {
  id!: string;
  status!: ItemStatus;
}
```

The import path is the **public subpath** declared in `@repro/shared`'s
`exports` map. It does not, in any form, reference the internal file
`packages/shared/src/messages/item.ts`.

## What gets compiled

After `pnpm install && pnpm turbo build --filter @repro/api`, inspect
`apps/api/dist/items/item.dto.js`:

```js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ItemDto = void 0;
const openapi = require("@nestjs/swagger");
class ItemDto {
    id;
    status;
    static _OPENAPI_METADATA_FACTORY() {
        return {
            id:     { required: true, type: () => String },
            status: { required: true, enum: require("../../../../packages/shared/dist/messages/item").ItemStatus }
        };
    }
}
exports.ItemDto = ItemDto;
```

The metadata factory contains:

```js
require("../../../../packages/shared/dist/messages/item")
```

— a four-levels-up filesystem path into the sibling workspace package,
bypassing the `exports` map and pointing at the specific source file
that *defines* the type rather than the file the source *imports from*.

## Why this matters

1. The relative path only resolves while the dist file sits at its original
   location inside the monorepo. Any deployment workflow that produces a
   self-contained bundle of just the app (and not its sibling workspace
   packages at their original relative offsets) breaks with
   `MODULE_NOT_FOUND` the moment `SwaggerModule.createDocument` introspects
   the affected DTO.

2. It defeats the purpose of the package's `exports` map, which exists
   precisely to draw a stable public-surface boundary that consumers can
   couple to without depending on internal file structure.

3. The behavior is invisible at build time — TypeScript checks pass, the
   compiled JS is syntactically valid, and the failure only surfaces at
   runtime when swagger walks the schema.

## Reproduction steps

```bash
pnpm install
pnpm turbo build --filter @repro/api

# Inspect the compiled output:
cat apps/api/dist/items/item.dto.js
# Note the require("../../../../packages/shared/dist/messages/item") inside
# the _OPENAPI_METADATA_FACTORY body.
```

To demonstrate the **runtime failure** in a realistic deployment, the included
`Dockerfile` runs `pnpm deploy --filter @repro/api --prod` (the standard way
to produce a self-contained app bundle from a pnpm monorepo) and starts the
app:

```bash
docker build -t repro .
docker run --rm -p 3000:3000 repro
```

Expected output (truncated):

```
Error: Cannot find module '../../../../packages/shared/dist/messages/item'
Require stack:
- /app/dist/items/item.dto.js
- /app/dist/items/items.controller.js
- ...
    at Function._resolveFilename (node:internal/modules/cjs/loader:...)
    at ItemDto._OPENAPI_METADATA_FACTORY (/app/dist/items/item.dto.js:...)
    at ModelPropertiesAccessor.applyMetadataFactory ...
    at SchemaObjectFactory.extractPropertiesFromType ...
```

## Status on current versions

### `@nestjs/swagger` 11.4.7 + NestJS 11.2.1 — still reproduces

Unchanged. `apps/api/dist/items/item.dto.js` still contains:

```js
status: { required: true, enum: require("../../../../packages/shared/dist/messages/item").ItemStatus }
```

and `pnpm deploy --filter @repro/api --prod` + `node dist/main` still fails:

```
Error: Cannot find module '../../../../packages/shared/dist/messages/item'
Require stack:
- /app/dist/items/item.dto.js
...
    at ItemDto._OPENAPI_METADATA_FACTORY (/app/dist/items/item.dto.js:9:94)
    at ModelPropertiesAccessor.applyMetadataFactory (.../@nestjs/swagger/dist/services/model-properties-accessor.js:27:93)
```

### `@nestjs/swagger` 12.0.0-alpha (git `master`) — still reproduces, plus a new blocker

Tested against `nestjs/swagger` `master` at commit `de89f82`, built from source and
installed as a tarball. v12 is **ESM-only** (`"type": "module"`), so a CommonJS
consumer no longer compiles at all:

```
src/main.ts:2:48 - error TS1479: The current file is a CommonJS module whose imports
will produce 'require' calls; however, the referenced file is an ECMAScript module
and cannot be imported with 'require'.
```

Converting the app to ESM (`"type": "module"`, `module`/`moduleResolution: nodenext`,
`.js` extensions on relative imports) gets it compiling. The plugin then emits:

```js
static _OPENAPI_METADATA_FACTORY() {
    return {
        id:     { required: true, type: () => String },
        status: { required: true, enum: (await import("../../../../packages/shared/dist/messages/item.js")).ItemStatus }
    };
}
```

Two problems:

1. **The original issue is unchanged.** The specifier is still the same
   four-levels-up filesystem path into the sibling package's internal file
   layout, now as a dynamic `import()` instead of a `require()`. It breaks in a
   deployed bundle for exactly the same reason.

2. **The emitted code is not valid JavaScript.** `await` is emitted inside
   `_OPENAPI_METADATA_FACTORY()`, which is not an `async` method, so the module
   fails to parse:

   ```
   $ node --check dist/items/item.dto.js
   return { ..., enum: (await import("../../../../packages/shared/dist/messages/item.js")).ItemStatus } };
                         ^^^^^
   SyntaxError: Unexpected reserved word
   ```

   This is not specific to cross-package imports — a plain same-directory enum
   produces the same broken output:

   ```js
   local: { required: true, enum: (await import("./local.enum.js")).LocalStatus }
   ```

   So under v12 + ESM the app does not start at all, regardless of deployment
   layout. This looks like a separate bug from the one this repo is about, and
   it currently makes the v12 plugin unusable for any DTO that references an
   enum.

## Expected behavior

The plugin should honor the source import path (or at minimum, the package's
declared `exports` surface) and emit:

```js
require("@repro/shared/messages").ItemStatus
```

…or equivalently use a module specifier that survives a normal deployment
workflow. The current behavior couples every consumer's deployed image to
the producer's internal source layout, which is precisely the coupling the
`exports` map is meant to prevent.

## Workarounds we've tried

- **Deploy the producer package at the expected relative offset.** Works,
  but doubles the package in the deployed image and re-introduces a
  filesystem-layout coupling that the `exports` map was supposed to remove.
- **Post-process the compiled JS** (sed-replace the relative path with the
  public subpath). Works for some shapes but is brittle: it depends on each
  re-export chain being complete, and silently breaks when a future
  submodule is added without an `export *` in the parent index.
