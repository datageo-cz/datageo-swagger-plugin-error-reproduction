# @nestjs/swagger plugin — deep relative `require()` in monorepos

Minimal reproduction showing that the `@nestjs/swagger` CLI plugin emits
**filesystem-relative `require()` calls** in `_OPENAPI_METADATA_FACTORY` when a
DTO references a type defined in a sibling workspace package, *even when the
source imports the package via its public subpath*.

## Versions

| Tool             | Version  |
|------------------|----------|
| pnpm             | 11.1.0   |
| turbo            | 2.9.x    |
| TypeScript       | 5.9.x    |
| NestJS           | 11.1.x   |
| `@nestjs/swagger`| 11.2.6   |
| Node             | 22       |

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
