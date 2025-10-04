import * as path from "node:path";
import type { PluginImpl, Plugin } from "rollup";
import ts from "typescript";
import { type Options, resolveDefaultOptions, type ResolvedOptions } from "./options.js";
import { createProgram, createPrograms, formatHost, getCompilerOptions } from "./program.js";
import { transform } from "./transform/index.js";
import { trimExtension, DTS_EXTENSIONS, JSON_EXTENSIONS, getDeclarationId } from "./helpers.js";

export type { Options };

const TS_EXTENSIONS = /\.([cm]ts|[tj]sx?)$/;

interface DtsPluginContext {
  /**
   * The entry points of the bundle.
   */
  entries: string[];
  /**
   * There exists one Program object per entry point, except when all entry points are ".d.ts" modules.
   */
  programs: ts.Program[];
  resolvedOptions: ResolvedOptions;
}

interface ResolvedModule {
  code: string;
  source?: ts.SourceFile;
  program?: ts.Program;
}

function logMemory(label: string) {
  const mem = process.memoryUsage();
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${label}] Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(2)}MB, RSS: ${(mem.rss / 1024 / 1024).toFixed(2)}MB`);
}

// Track module resolution to detect cycles
const moduleResolutionStack: string[] = [];
const moduleResolutionCount = new Map<string, number>();
const filesProcessed = new Set<string>();
let totalGetModuleCalls = 0;

function getModule(
  { entries, programs, resolvedOptions: { compilerOptions, tsconfig } }: DtsPluginContext,
  fileName: string,
  code: string,
): ResolvedModule | null {
  totalGetModuleCalls++;

  // Track cycles and repeated calls
  const count = (moduleResolutionCount.get(fileName) || 0) + 1;
  moduleResolutionCount.set(fileName, count);

  const isNewFile = !filesProcessed.has(fileName);
  if (isNewFile) {
    filesProcessed.add(fileName);
  }

  if (process.env.DTS_DEBUG) {
    const shortPath = fileName.split('/').slice(-3).join('/');

    // Check if this file is already in the stack (cycle detection)
    const cycleIndex = moduleResolutionStack.indexOf(fileName);
    if (cycleIndex >= 0) {
      console.log(`\n🔄 [CYCLE DETECTED] ${shortPath} (call #${count})`);
      console.log(`   Cycle path: ${moduleResolutionStack.slice(cycleIndex).map(f => f.split('/').slice(-2).join('/')).join(' -> ')} -> ${shortPath}`);
    } else if (count > 1) {
      console.log(`\n⚠️  [REPEATED] ${shortPath} (call #${count})`);
    }

    console.log(`[getModule #${totalGetModuleCalls}] ${isNewFile ? 'NEW' : 'SEEN'} file: ${shortPath}, unique files: ${filesProcessed.size}, programs: ${programs.length}, isDTS: ${DTS_EXTENSIONS.test(fileName)}, depth: ${moduleResolutionStack.length}`);
    logMemory(`getModule start`);
  }

  moduleResolutionStack.push(fileName);

  // Create any `ts.SourceFile` objects on-demand for ".d.ts" modules,
  // but only when there are zero ".ts" entry points.
  if (!programs.length && DTS_EXTENSIONS.test(fileName)) {
    if (process.env.DTS_DEBUG) {
      console.log('[getModule] Fast path: no programs, returning code only');
    }
    moduleResolutionStack.pop();
    return { code };
  }

  const isEntry = entries.includes(fileName);
  if (process.env.DTS_DEBUG) {
    console.log(`[getModule] isEntry: ${isEntry}, entries: ${entries.length}`);
  }

  // Rollup doesn't tell you the entry point of each module in the bundle,
  // so we need to ask every TypeScript program for the given filename.
  const existingProgram = programs.find((p) => {
    // Entry points may be in the other entry source files, but it can't emit from them.
    // So we should find the program about the entry point which is the root files.
    if (isEntry) {
      return p.getRootFileNames().includes(fileName);
    } else {
      const sourceFile = p.getSourceFile(fileName);
      if (sourceFile && p.isSourceFileFromExternalLibrary(sourceFile)) {
        if (process.env.DTS_DEBUG) {
          console.log(`[getModule] Found in program but is external library, skipping`);
        }
        return false;
      }
      return !!sourceFile;
    }
  });
  if (existingProgram) {
    if (process.env.DTS_DEBUG) {
      console.log('[getModule] Found existing program');
      logMemory('getModule existing program');
    }
    // we know this exists b/c of the .filter above, so this non-null assertion is safe
    const source = existingProgram.getSourceFile(fileName)!;
    moduleResolutionStack.pop();
    return {
      code: source?.getFullText(),
      source,
      program: existingProgram,
    };
  } else if (ts.sys.fileExists(fileName)) {
    // For .d.ts files from external libraries (when programs exist), just return the code
    // without creating a new program. This avoids creating hundreds of programs for
    // large external packages like type-fest.
    if (programs.length > 0 && DTS_EXTENSIONS.test(fileName)) {
      // Check if this file would be treated as an external library by any existing program
      const isExternalLibrary = programs.some((p) => {
        const sourceFile = p.getSourceFile(fileName);
        return sourceFile && p.isSourceFileFromExternalLibrary(sourceFile);
      });

      if (isExternalLibrary) {
        if (process.env.DTS_DEBUG) {
          console.log('[getModule] External library .d.ts file, returning code only');
          logMemory('getModule external library fast path');
        }
        moduleResolutionStack.pop();
        return { code };
      }
    }
    if (process.env.DTS_DEBUG) {
      console.log('[getModule] Creating new program for:', fileName.split('/').slice(-3).join('/'));
      logMemory('getModule before createProgram');
    }
    const newProgram = createProgram(fileName, compilerOptions, tsconfig);
    programs.push(newProgram);
    if (process.env.DTS_DEBUG) {
      console.log(`[getModule] Created new program #${programs.length} for: ${fileName.split('/').slice(-3).join('/')}`);
      console.log(`           📊 Stats: ${totalGetModuleCalls} total calls, ${filesProcessed.size} unique files, ${programs.length} programs created`);
      logMemory('getModule after createProgram');
    }
    // we created hte program from this fileName, so the source file must exist :P
    const source = newProgram.getSourceFile(fileName)!;
    moduleResolutionStack.pop();
    return {
      code: source?.getFullText(),
      source,
      program: newProgram,
    };
  } else {
    if (process.env.DTS_DEBUG) {
      console.log('[getModule] File does not exist, returning null');
    }
    // the file isn't part of an existing program and doesn't exist on disk
    moduleResolutionStack.pop();
    return null;
  }
}

const plugin: PluginImpl<Options> = (options = {}) => {
  const transformPlugin = transform();
  const ctx: DtsPluginContext = { entries: [], programs: [], resolvedOptions: resolveDefaultOptions(options) };

  return {
    name: "dts",

    // pass outputOptions & renderChunk hooks to the inner transform plugin
    outputOptions: transformPlugin.outputOptions,
    renderChunk: transformPlugin.renderChunk,

    options(options) {
      let { input = [] } = options;
      if (!Array.isArray(input)) {
        input = typeof input === "string" ? [input] : Object.values(input);
      } else if (input.length > 1) {
        // when dealing with multiple unnamed inputs, transform the inputs into
        // an explicit object, which strips the file extension
        options.input = {};
        for (const filename of input) {
          let name = trimExtension(filename)
          if (path.isAbsolute(filename)) {
            name = path.basename(name);
          } else {
            name = path.normalize(name);
          }
          options.input[name] = filename;
        }
      }

      ctx.programs = createPrograms(
        Object.values(input),
        ctx.resolvedOptions.compilerOptions,
        ctx.resolvedOptions.tsconfig,
      );

      return transformPlugin.options.call(this, options);
    },

    transform(code, id) {
      if (process.env.DTS_DEBUG) {
        const shortId = id.split('/').slice(-3).join('/');
        console.log(`\n[transform] Starting transform for: ${shortId}`);
        logMemory('transform start');
      }

      if (!TS_EXTENSIONS.test(id) && !JSON_EXTENSIONS.test(id)) {
        if (process.env.DTS_DEBUG) {
          console.log('[transform] Skipping non-TS/JSON file');
        }
        return null;
      }

      const watchFiles = (module: ResolvedModule) => {
        if (module.program) {
          const sourceDirectory = path.dirname(id);
          const sourceFilesInProgram = module.program
            .getSourceFiles()
            .map((sourceFile) => sourceFile.fileName)
            .filter((fileName) => fileName.startsWith(sourceDirectory));
          sourceFilesInProgram.forEach(this.addWatchFile);
        }
      };

      const handleDtsFile = () => {
        const module = getModule(ctx, id, code);
        if (module) {
          watchFiles(module);
          return transformPlugin.transform.call(this, module.code, id);
        }
        return null;
      };

      const treatTsAsDts = () => {
        const declarationId = getDeclarationId(id);
        const module = getModule(ctx, declarationId, code);
        if (module) {
          watchFiles(module);
          return transformPlugin.transform.call(this, module.code, declarationId);
        }
        return null;
      };

      const generateDts = () => {
        const module = getModule(ctx, id, code);
        if (!module || !module.source || !module.program) return null;
        watchFiles(module);

        const declarationId = getDeclarationId(id);

        let generated!: ReturnType<typeof transformPlugin.transform>;
        const { emitSkipped, diagnostics } = module.program.emit(
          module.source,
          (_, declarationText) => {
            generated = transformPlugin.transform.call(this, declarationText, declarationId);
          },
          undefined, // cancellationToken
          true, // emitOnlyDtsFiles
          undefined, // customTransformers
          // @ts-ignore This is a private API for workers, should be safe to use as TypeScript Playground has used it for a long time.
          true, // forceDtsEmit
        );
        if (emitSkipped) {
          const errors = diagnostics.filter((diag) => diag.category === ts.DiagnosticCategory.Error);
          if (errors.length) {
            console.error(ts.formatDiagnostics(errors, formatHost));
            this.error("Failed to compile. Check the logs above.");
          }
        }
        return generated;
      };

      // if it's a .d.ts file, handle it as-is
      if (DTS_EXTENSIONS.test(id)) {
        if (process.env.DTS_DEBUG) {
          console.log('[transform] Handling as .d.ts file');
        }
        const result = handleDtsFile();
        if (process.env.DTS_DEBUG) {
          logMemory('transform after handleDtsFile');
        }
        return result;
      }

      // if it's a json file, use the typescript compiler to generate the declarations,
      // requires `compilerOptions.resolveJsonModule: true`.
      // This is also commonly used with `@rollup/plugin-json` to import JSON files.
      if (JSON_EXTENSIONS.test(id)) {
        if (process.env.DTS_DEBUG) {
          console.log('[transform] Handling as JSON file');
        }
        const result = generateDts();
        if (process.env.DTS_DEBUG) {
          logMemory('transform after generateDts (JSON)');
        }
        return result;
      }

      // first attempt to treat .ts files as .d.ts files, and otherwise use the typescript compiler to generate the declarations
      if (process.env.DTS_DEBUG) {
        console.log('[transform] Treating .ts as .d.ts or generating');
      }
      const treated = treatTsAsDts();
      if (process.env.DTS_DEBUG) {
        logMemory('transform after treatTsAsDts');
        if (!treated) {
          console.log('[transform] treatTsAsDts returned null, calling generateDts');
        }
      }
      const result = treated ?? generateDts();
      if (process.env.DTS_DEBUG) {
        logMemory('transform end');
      }
      return result;
    },

    resolveId(source, importer) {
      if (!importer) {
        // store the entry point, because we need to know which program to add the file
        ctx.entries.push(path.resolve(source));
        return;
      }

      // normalize directory separators to forward slashes, as apparently typescript expects that?
      importer = importer.split("\\").join("/");

      let resolvedCompilerOptions = ctx.resolvedOptions.compilerOptions;
      if (ctx.resolvedOptions.tsconfig) {
        // Here we have a chicken and egg problem.
        // `source` would be resolved by `ts.nodeModuleNameResolver` a few lines below, but
        // `ts.nodeModuleNameResolver` requires `compilerOptions` which we have to resolve here,
        // since we have a custom `tsconfig.json`.
        // So, we use Node's resolver algorithm so we can see where the request is coming from so we
        // can load the custom `tsconfig.json` from the correct path.
        const resolvedSource = source.startsWith(".") ? path.resolve(path.dirname(importer), source) : source;
        resolvedCompilerOptions = getCompilerOptions(
          resolvedSource,
          ctx.resolvedOptions.compilerOptions,
          ctx.resolvedOptions.tsconfig,
        ).compilerOptions;
      }

      // resolve this via typescript
      const { resolvedModule } = ts.resolveModuleName(source, importer, resolvedCompilerOptions, ts.sys);
      if (!resolvedModule) {
        return;
      }

      if (resolvedModule.isExternalLibraryImport && resolvedModule.packageId && ctx.resolvedOptions.includeExternal.includes(resolvedModule.packageId.name)) {
        // include types from specified external modules
        return { id: path.resolve(resolvedModule.resolvedFileName) };
      }
      else if (!ctx.resolvedOptions.respectExternal && resolvedModule.isExternalLibraryImport) {
        // here, we define everything else that comes from `node_modules` as `external`.
        return { id: source, external: true };
      } else {
        // using `path.resolve` here converts paths back to the system specific separators
        return { id: path.resolve(resolvedModule.resolvedFileName) };
      }
    },
  } satisfies Plugin;
};

export { plugin as dts, plugin as default };
