import { ExecutableTarget } from '@cmt/api';
import { CMakeCache } from '@cmt/cache';
import * as proc from '@cmt/proc';
import { createLogger } from './logging';
import * as nls from 'vscode-nls';
import * as path from 'path';
import * as vscode from 'vscode';
import { fs } from './pr';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

const log = createLogger('debugger');

/**
 * Basically the same interface as vscode.DebugConfiguration, but we want
 * strong typing on the optional properties so we need to redefine it so
 * it can inherit those properties.
 */
export interface VSCodeDebugConfiguration extends CppDebugConfiguration {
    type: string;
    name: string;
    request: string;
    program: string;
    [key: string]: any;
}

/**
 * interface that maps to cmake.debugConfig.
 */
export interface CppDebugConfiguration {
    symbolSearchPath?: string;
    additionalSOLibSearchPath?: string;
    externalConsole?: boolean;
    logging?: DebuggerLogging;
    visualizerFile?: string;
    args?: string[];
    cwd?: string;
    environment?: proc.DebuggerEnvironmentVariable[];
    MIMode?: MIModes;
    miDebuggerPath?: string;
    stopAtEntry?: boolean;
    setupCommands?: SetupCommand[];
    customLaunchSetupCommands?: SetupCommand[];
    launchCompleteCommand?: string;
    dumpPath?: string;
    coreDumpPath?: string;
}

export interface DebuggerLogging {
    exceptions?: boolean;
    moduleLoad?: boolean;
    programOutput?: boolean;
    engineLogging?: boolean;
    trace?: boolean;
    traceResponse?: boolean;
}

export interface SetupCommand {
    text?: string;
    description?: string;
    ignoreFailures?: boolean;
}

async function createGDBDebugConfiguration(debuggerPath: string, target: ExecutableTarget): Promise<VSCodeDebugConfiguration> {
    if (!await checkDebugger(debuggerPath)) {
        debuggerPath = 'gdb';
        if (!await checkDebugger(debuggerPath)) {
            throw new Error(localize('gdb.not.found', 'Unable to find GDB in default search path and {0}.', debuggerPath));
        }
    }

    return {
        type: 'cppdbg',
        name: `Debug ${target.name}`,
        request: 'launch',
        cwd: path.dirname(target.path),
        args: [],
        MIMode: MIModes.gdb,
        miDebuggerPath: debuggerPath,
        setupCommands: [
            {
                description: localize('enable.pretty.printing', 'Enable pretty-printing for gdb'),
                text: '-enable-pretty-printing',
                ignoreFailures: true
            }
        ],
        program: target.path
    };
}

async function createLLDBDebugConfiguration(debuggerPath: string, target: ExecutableTarget): Promise<VSCodeDebugConfiguration> {
    if (!await checkDebugger(debuggerPath)) {
        throw new Error(localize('gdb.not.found', 'Unable to find GDB in default search path and {0}.', debuggerPath));
    }

    return {
        type: 'cppdbg',
        name: `Debug ${target.name}`,
        request: 'launch',
        cwd: path.dirname(target.path),
        args: [],
        MIMode: MIModes.lldb,
        miDebuggerPath: debuggerPath,
        program: target.path
    };
}

function createMSVCDebugConfiguration(target: ExecutableTarget): VSCodeDebugConfiguration {
    return {
        type: 'cppvsdbg',
        name: `Debug ${target.name}`,
        request: 'launch',
        cwd: path.dirname(target.path),
        args: [],
        program: target.path
    };
}

type DebuggerMIMode = 'gdb' | 'lldb';

type DebuggerGenerators = {
    [MIMode in DebuggerMIMode]: {
        miMode: MIMode;
        createConfig(debuggerPath: string, target: ExecutableTarget): Promise<VSCodeDebugConfiguration>;
    };
};

const DEBUG_GEN: DebuggerGenerators = {
    gdb: {
        miMode: 'gdb',
        createConfig: createGDBDebugConfiguration
    },
    lldb: {
        miMode: 'lldb',
        createConfig: createLLDBDebugConfiguration
    }
};

function searchForCompilerPathInCache(cache: CMakeCache): string | null {
    const languages = ['CXX', 'C', 'CUDA'];
    for (const lang of languages) {
        const entry = cache.get(`CMAKE_${lang}_COMPILER`);
        if (!entry) {
            continue;
        }
        return entry.value as string;
    }
    return null;
}

export enum MIModes {
    lldb = 'lldb',
    gdb = 'gdb',
}
export async function getDebugConfigurationFromCache(cache: CMakeCache, target: ExecutableTarget, platform: string,
    modeOverride?: MIModes, debuggerPathOverride?: string):
    Promise<VSCodeDebugConfiguration | null> {
    const entry = cache.get('CMAKE_LINKER');
    if (entry !== null) {
        const linker = entry.value as string;
        const is_msvc_linker = linker.endsWith('link.exe') || linker.endsWith('ld.lld.exe');
        if (is_msvc_linker) {
            return createMSVCDebugConfiguration(target);
        }
    }

    const debugger_name = modeOverride || (platform === 'darwin' ? 'lldb' : 'gdb');
    const description = DEBUG_GEN[debugger_name];

    if (debuggerPathOverride) {
        if (path.isAbsolute(debuggerPathOverride) && await fs.exists(debuggerPathOverride)) {
            return description.createConfig(debuggerPathOverride, target);
        }
        log.warning(localize('invalid.miDebuggerPath.override',
            "'{0}' in '{1}' must be an absolute path to a debugger (variable expansion is not currently supported). Got: '{2}'",
            "miDebuggerPath", "cmake.debugConfig", debuggerPathOverride));
    }

    const compiler_path = searchForCompilerPathInCache(cache);
    if (compiler_path === null) {
        throw Error(localize('no.compiler.found.in.cache', 'No compiler found in cache file.'));  // MSVC should be already found by CMAKE_LINKER
    }

    if (compiler_path.endsWith('cl.exe')) {
        return createMSVCDebugConfiguration(target);
    }

    // Look for a debugger, in the following order:
    // 1. LLDB-MI
    const clang_compiler_regex = /(clang[\+]{0,2})+(?!-cl)/gi;
    let mi_debugger_path = compiler_path.replace(clang_compiler_regex, 'lldb-mi');
    if (modeOverride !== "gdb" && (mi_debugger_path.search(new RegExp('lldb-mi')) !== -1)) {
        const cpptoolsExtension = vscode.extensions.getExtension('ms-vscode.cpptools');
        const cpptoolsDebuggerPath = cpptoolsExtension ? path.join(cpptoolsExtension.extensionPath, "debugAdapters", "lldb-mi", "bin", "lldb-mi") : undefined;
        // 1a. lldb-mi in the compiler path
        if (await checkDebugger(mi_debugger_path)) {
            return createLLDBDebugConfiguration(mi_debugger_path, target);
        }

        // 1b. lldb-mi installed by CppTools
        if (cpptoolsDebuggerPath && await checkDebugger(cpptoolsDebuggerPath)) {
            return createLLDBDebugConfiguration(cpptoolsDebuggerPath, target);
        }
    }

    // 2. gdb in the compiler path
    mi_debugger_path = compiler_path.replace(clang_compiler_regex, 'gdb');
    if (modeOverride !== "lldb" && (mi_debugger_path.search(new RegExp('gdb')) !== -1) && await checkDebugger(mi_debugger_path)) {
        return createGDBDebugConfiguration(mi_debugger_path, target);
    }

    // 3. lldb in the compiler path
    mi_debugger_path = compiler_path.replace(clang_compiler_regex, 'lldb');
    if (modeOverride !== "gdb" && (mi_debugger_path.search(new RegExp('lldb')) !== -1) && await checkDebugger(mi_debugger_path)) {
        return createLLDBDebugConfiguration(mi_debugger_path, target);
    }

    const gcc_compiler_regex = /([cg]\+\+|g?cc)(?=[^\/\\]*$)/gi;
    let gdb_debugger_path = compiler_path.replace(gcc_compiler_regex, description.miMode);
    if (path.isAbsolute(gdb_debugger_path) && !await fs.exists(gdb_debugger_path)) {
        gdb_debugger_path = path.join(path.dirname(compiler_path), description.miMode);
        if (process.platform === 'win32') {
            gdb_debugger_path = gdb_debugger_path + '.exe';
        }
    }
    if (gdb_debugger_path.search(new RegExp(description.miMode)) !== -1) {
        return description.createConfig(gdb_debugger_path, target);
    }

    log.warning(localize('unable.to.determine.debugger.for.compiler',
        'Unable to automatically determine debugger corresponding to compiler: {0}', compiler_path));
    return null;
}

export async function checkDebugger(debuggerPath: string): Promise<boolean> {
    const res = await proc.execute(debuggerPath, ['--version'], null, { shell: true }).result;
    return res.retc === 0;
}
