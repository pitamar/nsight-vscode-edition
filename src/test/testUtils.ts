/* ---------------------------------------------------------------------------------- *\
|                                                                                      |
|  Copyright (c) 2021, NVIDIA CORPORATION. All rights reserved.                        |
|                                                                                      |
|  The contents of this file are licensed under the Eclipse Public License 2.0.        |
|  The full terms of the license are available at https://eclipse.org/legal/epl-2.0/   |
|                                                                                      |
|  SPDX-License-Identifier: EPL-2.0                                                    |
|                                                                                      |
\* ---------------------------------------------------------------------------------- */

import * as path from 'path';
import * as fs from 'fs';
import { DebugProtocol } from '@vscode/debugprotocol';
import { expect } from 'chai';
import { DebugClient } from '@vscode/debugadapter-testsupport';
import { CudaDebugClient } from './cudaDebugClient';
import { CudaLaunchRequestArguments } from '../debugger/cudaGdbSession';

export interface StopLocationInfo {
    threadId: number;
    frameId: number;
}

export interface StoppedContext {
    threadId: number;
    frameId: number;
    actLocals: Map<string, DebugProtocol.Variable>;
}

export class TestUtils {
    private static readonly debuggerScriptsDirName = 'debugger';

    private static readonly cudaGdbAdapterScriptName = 'cudaGdbAdapter.js';

    private static readonly cudaGdbAdapterWebpackName = 'cudaGdbAdapter.webpack.js';

    static readonly localScopeName = 'Local';

    private static getDebuggerScriptsDir(): string {
        return path.resolve(__dirname, '..', this.debuggerScriptsDirName);
    }

    static getDebugAdapterPath(): string {
        let debugAdapterPath = path.resolve(this.getDebuggerScriptsDir(), this.cudaGdbAdapterScriptName);

        if (fs.existsSync(debugAdapterPath)) {
            return debugAdapterPath;
        }

        debugAdapterPath = path.resolve(__dirname, this.cudaGdbAdapterWebpackName);
        expect(fs.existsSync(debugAdapterPath)).eq(true);
        return debugAdapterPath;
    }

    public static resolveTestPath(testPath: string): string {
        const searchPaths = ['../../src/test/testPrograms', '../src/test/testPrograms'];

        const testProgDirEnvVar = process.env.TEST_PROG_DIR;
        if (testProgDirEnvVar) {
            searchPaths.push(testProgDirEnvVar);
        }

        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < searchPaths.length; i += 1) {
            const testProgramsDir = path.resolve(__dirname, searchPaths[i]);
            const resolvedTestPath = path.resolve(testProgramsDir, testPath);

            if (fs.existsSync(resolvedTestPath)) {
                return resolvedTestPath;
            }
        }

        throw new Error(`Unable to resolve test path "${testPath}"`);
    }

    static getTestProgram(programName: string): string {
        return this.resolveTestPath(programName);
    }

    static getTestSource(fileName: string): DebugProtocol.Source {
        return {
            name: fileName,
            path: TestUtils.getTestProgram(fileName)
        };
    }

    static ensure(capability: boolean | undefined): void {
        expect(capability).eq(true);
    }

    static async createDebugClient(): Promise<CudaDebugClient> {
        const debugAdapterPath = TestUtils.getDebugAdapterPath();

        const dc = new CudaDebugClient(debugAdapterPath);

        await dc.start();
        const initResp = await dc.initializeRequest();

        expect(initResp.success).eq(true);

        // Disable the eslint rule as it contradicts the recommended usage of exist.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(initResp.body).exist;

        // Disable the eslint rule per the assertion in the previous statement.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        dc.capabilities = initResp.body!;

        return dc;
    }

    static async getLaunchArguments(testProgram: string, args?: string): Promise<CudaLaunchRequestArguments> {
        const testProgramPath = TestUtils.getTestProgram(testProgram);
        const logFilePath = path.resolve(path.dirname(testProgramPath), '.rubicon_log');

        return {
            program: testProgramPath,
            args,
            verboseLogging: true,
            logFile: logFilePath,
            onAPIError: 'stop'
        };
    }

    static async launchDebugger(testProgram: string, args?: string): Promise<CudaDebugClient> {
        const dc = await this.createDebugClient();
        const launchArguments = await this.getLaunchArguments(testProgram, args);

        await dc.launchRequest(launchArguments);

        return dc;
    }

    static async assertStoppedLocation(dc: DebugClient, stoppedReason: string, file: string, line: number, timeout?: number): Promise<StopLocationInfo> {
        // The following code has been borrowed from debugClient.ts (with modifications)
        const stoppedEvent = await dc.waitForEvent('stopped', timeout ?? 10000);
        expect(stoppedEvent.body.reason).eq(stoppedReason);

        const { threadId } = stoppedEvent.body;

        const stackTraceResp = await dc.stackTraceRequest({
            threadId
        });

        expect(stackTraceResp.body.stackFrames.length).gt(0);

        const topStackFrame = stackTraceResp.body.stackFrames[0];
        expect(topStackFrame.line).eq(line);
        expect(topStackFrame.source?.path?.endsWith(file)).eq(true);

        return { threadId, frameId: topStackFrame.id };
    }

    static async getLocals(dc: DebugClient, frameId: number): Promise<Map<string, DebugProtocol.Variable>> {
        const localsScopeReference = await this.getLocalsScopeReference(dc, frameId);
        const locals = await this.getChildren(dc, localsScopeReference);
        return locals;
    }

    static async getLocalsScopeReference(dc: DebugClient, frameId: number): Promise<number> {
        const scopesResp = await dc.scopesRequest({ frameId });
        const { scopes } = scopesResp.body;

        const localScope = scopes.filter((s) => s.name === TestUtils.localScopeName)[0];

        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(localScope).exist;

        return localScope.variablesReference;
    }

    static async getChildren(dc: DebugClient, variablesReference: number): Promise<Map<string, DebugProtocol.Variable>> {
        const vars = new Map<string, DebugProtocol.Variable>();

        const variablesResp = await dc.variablesRequest({
            variablesReference
        });

        variablesResp.body.variables.forEach((v) => vars.set(v.name, v));

        return vars;
    }

    static readonly defaultVerifyLocalsTimeout = 120000;

    static async verifyLocalsOnStop(
        dc: DebugClient,
        source: string,
        line: number,
        stopReason: string,
        expLocals: {
            name: string;
            value?: string;
        }[],
        allowOthers?: boolean | undefined,
        stopTimeout?: number
    ): Promise<StoppedContext> {
        const { threadId, frameId } = await TestUtils.assertStoppedLocation(dc, stopReason, source, line, stopTimeout ?? TestUtils.defaultVerifyLocalsTimeout);

        const actual = await TestUtils.getLocals(dc, frameId);

        if (allowOthers === false) {
            expect(actual.size).eq(expLocals.length);
        }

        expLocals.forEach((v) => {
            const local = actual.get(v.name);
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            expect(local).exist;
            if (v.value) {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                expect(local!.value).eq(v.value);
            }
        });

        return { threadId, frameId, actLocals: actual };
    }
}
