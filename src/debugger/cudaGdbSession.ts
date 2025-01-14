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

/* eslint-disable max-classes-per-file */
/* eslint-disable no-param-reassign */

import * as vscode from 'vscode';
import {
    AttachRequestArguments,
    CDTDisassembleArguments,
    FrameReference,
    FrameVariableReference,
    GDBBackend,
    GDBDebugSession,
    LaunchRequestArguments,
    MIBreakpointInfo,
    MIDataDisassembleResponse,
    MIStackListVariablesResponse,
    MIVarChild,
    MIVarCreateResponse,
    MIVariableInfo,
    MIVarPrintValues,
    ObjectVariableReference,
    sendDataDisassemble,
    sendExecContinue,
    sendExecFinish,
    sendExecRun,
    sendStackListFramesRequest,
    sendVarAssign,
    sendVarCreate,
    sendVarListChildren,
    sendVarUpdate
} from 'cdt-gdb-adapter';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import { BreakpointEvent, ErrorDestination, Event, InvalidatedEvent, logger, OutputEvent, Scope, TerminatedEvent, Thread, Variable } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';

import * as fs from 'fs';
import * as util from 'util';
import * as which from 'which';
import { CudaDebugProtocol } from './cudaDebugProtocol';
import { deviceRegisterGroups } from './deviceRegisterGroups.json';
import * as types from './types';
import * as utils from './utils';

console.log(vscode);
const exec = util.promisify(require('child_process').exec);

abstract class Adapter {
    static readonly cudaThreadId: number = 99999;

    static readonly cudaThreadName: string = '(CUDA)';
}

class ChangedCudaFocusEvent extends Event implements CudaDebugProtocol.ChangedCudaFocusEvent {
    body: {
        focus?: types.CudaFocus;
    };

    public constructor(focus?: types.CudaFocus) {
        super(CudaDebugProtocol.Event.changedCudaFocus);

        this.body = {
            focus
        };
    }
}

class SystemInfoEvent extends Event implements CudaDebugProtocol.SystemInfoEvent {
    body: {
        systemInfo?: types.SystemInfo;
    };

    public constructor(systemInfo?: types.SystemInfo) {
        super(CudaDebugProtocol.Event.systemInfo);

        this.body = {
            systemInfo
        };
    }
}

class CudaThread extends Thread {
    // cuda-gdb does not return a thread or thread-id for CUDA kernels, so we create a
    // "dummy" thread for CUDA. When we see this sentinel value we will handle the requests
    // specially for CUDA.

    focus?: types.CudaFocus;

    constructor() {
        super(Adapter.cudaThreadId, Adapter.cudaThreadName);
    }

    setFocus(focus: types.CudaFocus): void {
        this.focus = focus;
    }

    clearFocus(): void {
        this.focus = undefined;
    }

    // eslint-disable-next-line class-methods-use-this
    get hasFocus(): boolean {
        return false;
        // return utils.isCudaFocusValid(this.focus);
    }
}

export type APIErrorOption = 'stop' | 'hide' | 'ignore';

type Environment = {
    name: string;
    value: string;
};

type CudaGdbPathResult = {
    kind: 'exists';
    path: string;
};

type NoCudaGdbResult = {
    kind: 'doesNotExist';
};

type CudaGdbExists = CudaGdbPathResult | NoCudaGdbResult;

export class RegisterData {
    registerGroups: RegisterGroup[];

    constructor(registerGroups: RegisterGroup[]) {
        this.registerGroups = registerGroups;
    }
}

export interface RegistersVariableReference extends FrameVariableReference {
    scope: 'registers';
    isCUDA: boolean;
    registerData?: RegisterData | undefined;
    registerGroup?: RegisterGroup | undefined;
    register?: Register | undefined;
}

export interface ContainerObjectReference extends ObjectVariableReference {
    children?:
        | {
              name: string;
              reference: string | number;
              value: string;
              type: string;
          }[]
        | undefined;
}

export interface CudaLaunchOrAttachCommonRequestArguments {
    debuggerPath?: string;
    miDebuggerPath?: string;
    program: string;
    args?: string | string[];
    miDebuggerArgs?: string | string[];
    verboseLogging?: boolean;
    breakOnLaunch?: boolean;
    onAPIError?: APIErrorOption;
    sysroot?: string;
    additionalSOLibSearchPath?: string;
    environment?: Environment[];
    testMode?: boolean;
}

export interface CudaLaunchRequestArguments extends LaunchRequestArguments, CudaLaunchOrAttachCommonRequestArguments {
    envFile?: string;
    stopAtEntry?: boolean;
    cudaCoreDumpPath?: string;
}

export interface CudaAttachRequestArguments extends AttachRequestArguments, CudaLaunchOrAttachCommonRequestArguments {
    processId: string;
    port: number;
    address: string;
}

interface RegisterNameValuePair {
    number: string;
    value: string;
}

interface MICudaInfoDevicesResponse {
    InfoCudaDevicesTable: {
        body: Array<{
            current: string;
            name: string;
            description: string;
            sm_type: string;
        }>;
    };
}

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace ExecutionQueue {
    export type Fn<T = any> = () => T;
    export type ResolveFn<T = any> = (value: T) => void;
    export type RejectFn<T = any> = (error: any) => void;
    export type Item = { fn: ExecutionQueue.Fn; resolve: ExecutionQueue.ResolveFn; reject: ExecutionQueue.RejectFn };
}

// eslint-disable-next-line no-redeclare
export class ExecutionQueue {
    protected queue: Array<ExecutionQueue.Item> = [];

    protected async processQueue(): Promise<void> {
        // eslint-disable-next-line no-restricted-syntax,no-shadow
        for (const { fn, resolve, reject } of this.queue) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const result = await fn();
                resolve(result);
            } catch (error: any) {
                reject(error);
            }
        }
        this.queue = [];
    }

    public async execute<T>(fn: ExecutionQueue.Fn<T>): Promise<T> {
        // eslint-disable-next-line no-shadow
        const promise = new Promise<T>((resolve, reject) => {
            this.queue.push({ fn, resolve, reject });
            if (this.queue.length === 1) {
                this.processQueue();
            }
        });
        const result = await promise;
        return result;
    }
}

export class CudaGdbBackend extends GDBBackend {
    static readonly eventCudaGdbExit: string = 'cudaGdbExit';

    public sendCommand<T>(command: string, returnRaw?: false): Promise<T>;

    public sendCommand<T>(command: string, returnRaw: true): Promise<string>;

    public sendCommand<T>(command: string, returnRaw: boolean): Promise<T | string>;

    public sendCommand<T>(command: string, returnRaw = false): Promise<T | string> {
        const miPrefixBreakInsert = '-break-insert';
        if (command.startsWith(miPrefixBreakInsert)) {
            const breakInsert = command.slice(0, miPrefixBreakInsert.length);
            const flagF = '-f';
            const breakPointInfo = command.slice(miPrefixBreakInsert.length);
            command = `${breakInsert} ${flagF} ${breakPointInfo}`;
        }
        return super.sendCommand(command, returnRaw);
    }

    async spawn(requestArgs: CudaLaunchRequestArguments | CudaAttachRequestArguments): Promise<void> {
        await super.spawn(requestArgs);

        if (this.proc) {
            this.proc.on('exit', (code: number, signal: string) => {
                const emitter: EventEmitter = this as EventEmitter;
                emitter.emit(CudaGdbBackend.eventCudaGdbExit, code, signal);
            });
        }

        if (requestArgs.sysroot) {
            requestArgs.initCommands?.push(`set sysroot ${requestArgs.sysroot}`);
        }

        if (requestArgs.additionalSOLibSearchPath) {
            requestArgs.initCommands?.push(`set solib-search-path ${requestArgs.additionalSOLibSearchPath}`);
        }
    }
}

interface LaunchEnvVarSpec {
    type: 'set' | 'unset';
    name: string;
    value?: string;
}

class RegisterGroup {
    groupName: string;

    groupPattern: RegExp;

    isPredicate: boolean;

    isHidden: boolean;

    registers: Register[];

    constructor(groupName: string, groupPattern: string, isPredicate: boolean, isHidden: boolean) {
        this.groupName = groupName;
        this.groupPattern = new RegExp(groupPattern);
        this.isPredicate = isPredicate;
        this.isHidden = isHidden;
        this.registers = [];
    }
}

class Register {
    ordinal: number;

    name: string;

    group: RegisterGroup;

    constructor(ordinal: number, name: string, group: RegisterGroup) {
        this.ordinal = ordinal;
        this.name = name;
        this.group = group;
    }
}

export class SimplifiedVarObjType {
    varname: string;

    expression: string;

    numchild: string;

    value: string;

    type: string;

    kind: 'watch' | 'local';

    constructor(varname: string, expression: string, numchild: string, value: string, type: string, kind: 'watch' | 'local') {
        this.varname = varname;
        this.expression = expression;
        this.numchild = numchild;
        this.value = value;
        this.type = type;
        this.kind = kind;
    }
}

export interface VarUpdateChanges {
    name: string;
    value: string;
    in_scope: string;
    type_changed: string;
    has_more: string;
    new_type: string;
    new_num_children: string;
}

export class VariableObjectStore {
    execContext: {
        threadId?: number | types.CudaFocus | undefined;

        frameId?: number | undefined;

        resumed?: boolean | undefined;

        functionName?: string | undefined;
    } = {};

    protected byName = new Map<string, SimplifiedVarObjType>();

    protected localsValid = false;

    gdb: CudaGdbBackend | undefined;

    constructor(gdb: GDBBackend) {
        this.gdb = gdb;
    }

    async evaluate(expression: string): Promise<SimplifiedVarObjType | undefined> {
        if (!this.gdb) {
            // eslint-disable-next-line unicorn/no-useless-undefined
            return undefined;
        }
        try {
            const varCreateResp = await sendVarCreate(this.gdb, {
                frame: 'floating',
                expression
            });

            const varObj = new SimplifiedVarObjType(varCreateResp.name, expression, varCreateResp.numchild, varCreateResp.value, varCreateResp.type, 'watch');
            this.byName.set(varObj.varname, varObj);

            return varObj;
        } catch (error) {
            const errorMessage = (error as Error).message;
            if (errorMessage !== '-var-create: unable to create variable object') {
                logger.error(`Error while creating variable object for watch: ${errorMessage}`);
            }

            // eslint-disable-next-line unicorn/no-useless-undefined
            return undefined;
        }
    }

    async getLocals(focus: number | types.CudaFocus | undefined, frameId: number): Promise<SimplifiedVarObjType[]> {
        if (focus === undefined) {
            return [];
        }

        const funcName = await this.getCurrentFunction(focus);

        await this.validate(focus, frameId, funcName);

        return [...this.byName.values()].filter((vo) => vo.kind === 'local');
    }

    getLocalByName(localName: string): SimplifiedVarObjType | undefined {
        return [...this.byName.values()].filter((vo) => vo.expression === localName)[0];
    }

    updateLocal(varObjName: string, update: VarUpdateChanges): SimplifiedVarObjType | undefined {
        const varObj = this.byName.get(varObjName);

        if (varObj) {
            VariableObjectStore.updateVarObj(varObj, update);
        }

        return varObj;
    }

    protected static updateVarObj(varObj: SimplifiedVarObjType, update: VarUpdateChanges): void {
        varObj.value = update.value;

        if (update.type_changed === 'true') {
            varObj.type = update.new_type;
            varObj.numchild = update.new_num_children;
        }
    }

    protected async getCurrentFunction(threadId: number | types.CudaFocus): Promise<string | undefined> {
        const backendThreadId = VariableObjectStore.isCudaFocus(threadId) ? undefined : threadId;
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const resp = await sendStackListFramesRequest(this.gdb!, { lowFrame: 0, highFrame: 0, threadId: backendThreadId });
        const frameInfo = resp.stack[0];
        return frameInfo.func;
    }

    protected async validate(threadId: number | types.CudaFocus, frameId: number, funcName: string | undefined): Promise<void> {
        if (!this.gdb) {
            return;
        }

        let shouldInvalidate = false;
        if (this.threadIdChanged(threadId) || this.execContext.frameId !== frameId) {
            shouldInvalidate = true;
        } else {
            if (this.execContext.resumed === false) {
                await this.updateLocals();
                return;
            }

            if (!funcName || !this.execContext.functionName || funcName !== this.execContext.functionName) {
                shouldInvalidate = true;
            }
        }

        let getStackVarsCommand = '-stack-list-variables';
        if (!VariableObjectStore.isCudaFocus(threadId)) {
            // Here, we need to add the thread and frame IDs but a bug in cuda-gdb currently prevents this.
            getStackVarsCommand += ` --thread ${threadId} --frame ${frameId}`;
        }
        getStackVarsCommand += ' --simple-values';

        const stackLocalsResp: MIStackListVariablesResponse = await this.gdb.sendCommand(getStackVarsCommand);
        const stackLocalsList = stackLocalsResp.variables;

        if (!shouldInvalidate) {
            const oldLocals = new Map<string, SimplifiedVarObjType>();
            this.byName.forEach((vo) => {
                if (vo.kind === 'local') {
                    const stackLocalName = vo.expression;
                    oldLocals.set(stackLocalName, vo);
                }
            });

            if (oldLocals.size !== stackLocalsList.length) {
                shouldInvalidate = true;
            } else {
                shouldInvalidate = !stackLocalsList.every((sl) => {
                    const vo = oldLocals.get(sl.name);
                    return vo && vo.type === sl.type;
                });
            }
        }

        if (!shouldInvalidate) {
            await this.updateLocals();
        } else {
            await this.clear('local');

            await this.createLocals(stackLocalsList);

            this.execContext = {
                threadId,
                frameId,
                functionName: funcName,
                resumed: false
            };
        }
    }

    static isCudaFocus(threadId?: number | types.CudaFocus): threadId is types.CudaFocus {
        // Note that we are not calling type but rather
        // checking if the member exists on threadId i.e.
        // whether threadId is a CudaFocus object:
        return (threadId as types.CudaFocus)?.type !== undefined;
    }

    protected threadIdChanged(threadId: number | types.CudaFocus): boolean {
        if (this.execContext.threadId === undefined) {
            return true;
        }

        if (!VariableObjectStore.isCudaFocus(threadId)) {
            // We are in host code now. Return true iff:
            //  -- this.execContext.threadId is a CudaFocus (i.e. we
            //     were in device code before),
            //  or
            //  -- this.execContext.threadId is a host threadId but
            //     does not match the new threadId.
            return threadId !== this.execContext.threadId;
        }

        if (!VariableObjectStore.isCudaFocus(this.execContext.threadId)) {
            // We were in host code and now we're in device code.
            return true;
        }

        return !utils.equalsCudaFocus(threadId, this.execContext.threadId);
    }

    protected async createLocals(stackLocalsList: MIVariableInfo[]): Promise<void> {
        if (!this.gdb) {
            return;
        }

        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < stackLocalsList.length; i += 1) {
            const stackLocal = stackLocalsList[i];

            // eslint-disable-next-line no-await-in-loop
            const varCreateResp: MIVarCreateResponse = await sendVarCreate(this.gdb, {
                frame: 'floating',
                expression: stackLocal.name
            });

            const stackVarObj = new SimplifiedVarObjType(varCreateResp.name, stackLocal.name, varCreateResp.numchild, varCreateResp.value, varCreateResp.type, 'local');
            this.byName.set(stackVarObj.varname, stackVarObj);
        }
    }

    async update(): Promise<VarUpdateChanges[]> {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const varUpdateResp = await sendVarUpdate(this.gdb!, { name: '*' });
        const changes = varUpdateResp.changelist.map((ch) => ch as VarUpdateChanges);

        changes.forEach((ch) => {
            const varObj = this.byName.get(ch.name);

            if (!varObj || varObj.kind !== 'local') {
                return;
            }

            VariableObjectStore.updateVarObj(varObj, ch);
        });

        return changes;
    }

    // This method is purely an optimization for the common
    // case where we are doing step/next.
    protected async updateLocals(): Promise<void> {
        await this.update();
    }

    public clearWatches(): Promise<void> {
        return this.clear('watch');
    }

    protected async clear(kind: 'watch' | 'local'): Promise<void> {
        const stackVarObjects = [...this.byName.values()].filter((vo) => vo.kind === kind);
        await this.gdb?.sendCommands(stackVarObjects.map((vo) => `-var-delete ${vo.varname}`));
        stackVarObjects.forEach((vo) => this.byName.delete(vo.varname));
    }
}

export class InvalidationCompleteTrigger {
    private expectedRequests: Set<string>;

    private onceComplete: () => Promise<void> | void;

    public constructor(expectedRequests: Iterable<string>, onceComplete: () => Promise<void> | void) {
        this.expectedRequests = new Set(expectedRequests);
        this.onceComplete = onceComplete;
    }

    public async resolve(request: string): Promise<boolean> {
        const expected = this.expectedRequests.delete(request);
        if (expected && this.expectedRequests.size === 0) {
            await this.onceComplete();
            return true;
        }

        return false;
    }
}

export class CudaGdbSession extends GDBDebugSession {
    static readonly codeModuleNotFound: number = 127;

    private readonly cudaThread: CudaThread = new CudaThread();

    protected clientInitArgs: DebugProtocol.InitializeRequestArguments | undefined;

    protected stopAtEntry = false;

    protected cudaCoreDumpPath?: string;

    protected testMode = false;

    protected telemetryInfoSent = false;

    protected getCurrentFocus(): types.CudaFocus | undefined {
        return this.cudaThread.focus;
    }

    protected createBackend(): GDBBackend {
        const backend: CudaGdbBackend = new CudaGdbBackend();
        const emitter: EventEmitter = backend as EventEmitter;

        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        emitter.on(CudaGdbBackend.eventCudaGdbExit, (code: number, signal: string) => {
            if (code === CudaGdbSession.codeModuleNotFound) {
                this.sendEvent(new OutputEvent('Failed to find cuda-gdb or a dependent library.'));
                this.sendEvent(new TerminatedEvent());
            }
        });

        vscode.debug.onDidChangeActiveStackItem((e) => this.onDidChangeActiveStackItem(e));

        return backend;
    }

    protected executionQueue = new ExecutionQueue();

    protected uiFocusedFrame?: types.RealizedFrameReference;

    protected gdbFocusedFrame?: types.RealizedFrameReference;

    protected invalidationCompleteTrigger?: InvalidationCompleteTrigger;

    protected varStore = new VariableObjectStore(this.gdb);

    protected realizeFrameReference(): undefined;

    protected realizeFrameReference(frame: undefined): undefined;

    protected realizeFrameReference(frame: FrameReference): types.RealizedFrameReference;

    protected realizeFrameReference(frame?: FrameReference): types.RealizedFrameReference | undefined {
        if (frame === undefined) {
            return frame;
        }

        const result: types.RealizedFrameReference = {
            frameId: frame.frameId,
            focus: frame.threadId === undefined ? this.cudaThread.focus : frame.threadId
        };

        return result;
    }

    // eslint-disable-next-line class-methods-use-this
    protected async onDidChangeActiveStackItem(e?: vscode.DebugThread | vscode.DebugStackFrame): Promise<void> {
        await this.executionQueue.execute(async () => {
            if (e === undefined || e.threadId === undefined || !('frameId' in e) || e.frameId === undefined) {
                return;
            }

            const frame = this.frameHandles.get(e.frameId);
            const realizedFrame = this.realizeFrameReference(frame);
            this.uiFocusedFrame = realizedFrame;

            if (realizedFrame === undefined) {
                return;
            }

            const explicitThreadSwitch = vscode.workspace.getConfiguration('nsight-vscode-edition').get('cuda-gdb.explicit-thread-switch', false);
            if (explicitThreadSwitch) {
                await this.focusOnFrame(realizedFrame);
            }

            await this.invalidateAreas(['variables']);
        });
    }

    protected async focusOnThread(focus?: number | types.CudaFocus): Promise<void> {
        await this.focusOnFrame({ focus, frameId: 0 });
    }

    protected async focusOnFrame(frame?: types.RealizedFrameReference): Promise<void> {
        if (frame === undefined) {
            return;
        }

        if (utils.deepEqual(frame, this.gdbFocusedFrame)) {
            return;
        }

        const { frameId } = frame;
        const focus = frame.focus ?? this.cudaThread.focus;

        if (focus === undefined) {
            return;
        }

        const commands: string[] = [];

        if (!utils.deepEqual(focus, this.gdbFocusedFrame?.focus)) {
            if (VariableObjectStore.isCudaFocus(focus)) {
                commands.push(utils.formatSetFocusCommand(focus));
            } else {
                commands.push(`thread ${focus}`);
            }

            if (frameId !== null) {
                commands.push(`frame ${frameId}`);
            }
        } else if (frameId !== null && !utils.deepEqual(frameId, this.gdbFocusedFrame?.frameId)) {
            commands.push(`frame ${frameId}`);
        }

        try {
            if (commands.length > 0) {
                await this.gdb.sendCommands(commands);
            }
            this.gdbFocusedFrame = { frameId, focus };
        } catch (error) {
            const { gdbFocusedFrame } = this;
            this.gdbFocusedFrame = undefined;
            await this.focusOnFrame(gdbFocusedFrame);
            throw error;
        }
    }

    public start(inStream: NodeJS.ReadableStream, outStream: NodeJS.WritableStream): void {
        // Defined for debugging
        super.start(inStream, outStream);
    }

    public shutdown(): void {
        // Defined for debugging
        super.shutdown();
    }

    public sendEvent(event: DebugProtocol.Event): void {
        // Defined for debugging
        super.sendEvent(event);
    }

    public sendRequest(command: string, args: any, timeout: number, cb: (response: DebugProtocol.Response) => void): void {
        // Defined for debugging
        super.sendRequest(command, args, timeout, cb);
    }

    public sendResponse(response: DebugProtocol.Response): void {
        // Defined for debugging
        super.sendResponse(response);
    }

    protected sendErrorResponse(response: DebugProtocol.Response, codeOrMessage: number | DebugProtocol.Message, format?: string, variables?: any, dest: ErrorDestination = ErrorDestination.User): void {
        // Defined for debugging
        super.sendErrorResponse(response, codeOrMessage, format, variables, dest);
    }

    protected dispatchRequest(request: DebugProtocol.Request): void {
        const anyRequest = request as any;
        if (anyRequest?.arguments?.threadId === this.cudaThread.id) {
            // The CUDA thread id is not real, it's a sentinel value to identify requests
            // that are intended for CUDA. We catch this here and remove it, otherwise cuda-gdb
            // MI commands that include a thread id are assumed to be CPU threads and will
            // change focus.

            delete anyRequest.arguments.threadId;
        }

        super.dispatchRequest(request);
    }

    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
        this.executionQueue.execute(async () => {
            switch (command) {
                case CudaDebugProtocol.Request.changeCudaFocus:
                    await this.changeCudaFocusRequest(response as CudaDebugProtocol.ChangeCudaFocusResponse, args);
                    break;

                case CudaDebugProtocol.Request.resetSelectedFocus:
                    await this.resetSelectedFocusRequest(response as CudaDebugProtocol.ResetFocusResponse, args);
                    break;

                default:
                    await super.customRequest(command, response, args);
                    break;
            }
        });
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: CudaLaunchRequestArguments): Promise<void> {
        logger.verbose('Executing launch request');

        let logFilePath = args.logFile;
        if (logFilePath && !isAbsolute(logFilePath)) {
            logFilePath = resolve(logFilePath);
        }

        // Logger setup is handled in the base class
        logger.init((outputEvent: OutputEvent) => this.sendEvent(outputEvent), logFilePath, true);
        logger.verbose('Logger successfully initialized');

        if (process.platform !== 'linux') {
            response.success = false;
            response.message = 'Unable to launch cuda-gdb on non-Linux system';
            logger.verbose(response.message);
            this.sendErrorResponse(response, 1, response.message);
            await super.launchRequest(response, args);

            return;
        }
        logger.verbose('Confirmed that we are on a Linux system');

        const cdtLaunchArgs: LaunchRequestArguments = { ...args };

        cdtLaunchArgs.gdb = args.miDebuggerPath || args.debuggerPath;

        this.cudaCoreDumpPath = args.cudaCoreDumpPath;

        // if (this.cudaCoreDumpPath) {
        //     this.gdb.setNonStopMode(false);
        //     const resultData = {
        //         'stopped-threads': 'all',
        //     }
        //     await this.handleGDBAsync('resultClass', resultData);
        // }

        try {
            CudaGdbSession.configureLaunch(args, cdtLaunchArgs);
        } catch (error) {
            response.success = false;
            response.message = (error as Error).message;
            logger.verbose(`Failed in configureLaunch() with error "${response.message}"`);
            this.sendErrorResponse(response, 1, response.message);
            await super.launchRequest(response, args);

            return;
        }

        let debuggerCmdLineArgs: string[] = [];

        if (args.args) {
            debuggerCmdLineArgs = debuggerCmdLineArgs.concat(args.args);
        }

        if (args.miDebuggerArgs) {
            debuggerCmdLineArgs = debuggerCmdLineArgs.concat(args.miDebuggerArgs);
        }

        if (debuggerCmdLineArgs.length > 0) {
            cdtLaunchArgs.arguments = debuggerCmdLineArgs.join(';');
        }

        const cudaGdbPath = await checkCudaGdb(cdtLaunchArgs.gdb);

        if (cudaGdbPath.kind === 'doesNotExist') {
            response.success = false;
            response.message = `Unable to find cuda-gdb in ${cdtLaunchArgs.gdb}`;
            logger.verbose(`Failed with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);

            return;
        }

        logger.verbose('cuda-gdb found and accessible');
        cdtLaunchArgs.gdb = cudaGdbPath.path;

        if ('stopAtEntry' in args && args.stopAtEntry) {
            this.stopAtEntry = true;
        }

        this.testMode = args.testMode ?? false;

        logger.verbose('Calling launch request in super class');
        await super.launchRequest(response, cdtLaunchArgs);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: CudaAttachRequestArguments): Promise<void> {
        logger.verbose('Executing attach request');
        this.isAttach = true;

        if (typeof args.processId === 'string') {
            logger.verbose(`Process ID ${args.processId} was given as a string`);
            let processExecName = args.processId;

            if (args.processId.includes(':')) {
                processExecName = args.processId.slice(args.processId.indexOf(':') + 1, args.processId.length);
                args.processId = args.processId.slice(0, args.processId.indexOf(':'));
            }

            const commandProgram = `readlink -e /proc/${args.processId}/exe`;
            const { error, stdout, stderr } = await exec(commandProgram.toString());
            const programPath = `${stdout}`.trim();

            // if the process id is invalid then the command would return null so accounting for that case
            if (!programPath) {
                response.success = false;
                response.message = `Unable to attach to ${processExecName}`;
                logger.verbose(`Failed in string PID setup with error ${response.message}`);
                this.sendErrorResponse(response, 1, response.message);
            }

            if (error) {
                response.success = false;
                response.message = `Unable to attach to  ${processExecName}, ${error}`;
                logger.verbose(`Failed in string PID setup with error ${response.message}`);
                this.sendErrorResponse(response, 1, response.message);
            }

            if (stderr) {
                response.success = false;
                response.message = `Unable to attach to  ${processExecName} ,${stderr}`;
                logger.verbose(`Failed in string PID setup with error  ${response.message}`);
                this.sendErrorResponse(response, 1, response.message);
            }

            args.program = programPath;

            logger.verbose('processed process ID as string');
        } else if (typeof args.processId === 'number') {
            logger.verbose('process ID was given as a number');
            // rare case that the process picker is not used and the user manually enters the pid

            const commandProgram = `readlink -e /proc/${args.processId}/exe`;
            const { error, stdout, stderr } = await exec(commandProgram.toString());
            const programPath = `${stdout}`.trim();

            // if the process id is invalid then the command would return null so accounting for that case
            if (!programPath) {
                response.success = false;
                response.message = `Unable to attach to process with pid ${args.processId}`;
                logger.verbose(`Failed in number PID setup with error  ${response.message}`);
                this.sendErrorResponse(response, 1, response.message);
            }

            if (error) {
                response.success = false;
                response.message = `Unable to attach to process with pid ${args.processId}, ${error}`;
                logger.verbose(`Failed in number PID setup with error  ${response.message}`);
                this.sendErrorResponse(response, 1, response.message);
            }

            if (stderr) {
                response.success = false;
                response.message = `Unable to attach to process with pid ${args.processId}, ${stderr}`;
                logger.verbose(`Failed in number PID setup with error  ${response.message}`);
                this.sendErrorResponse(response, 1, response.message);
            }

            args.processId = `${args.processId}`;
            args.program = programPath;

            logger.verbose('processed process ID as number');
        }

        let logFilePath = args.logFile;
        if (logFilePath && !isAbsolute(logFilePath)) {
            logFilePath = resolve(logFilePath);
        }

        // Logger setup is handled in the base class
        logger.init((outputEvent: OutputEvent) => this.sendEvent(outputEvent), logFilePath, true);
        logger.verbose('Logger successfully initialized');

        if (process.platform !== 'linux') {
            response.success = false;
            response.message = 'Unable to launch cuda-gdb on non-Linux system';
            logger.verbose(response.message);
            this.sendErrorResponse(response, 1, response.message);
            await super.attachRequest(response, args);

            return;
        }
        logger.verbose('Confirmed that we are on a Linux system');

        // 0 is requires for cuda-gdb to attach to non-children
        const ptraceScopeFile = '/proc/sys/kernel/yama/ptrace_scope';

        if (fs.existsSync(ptraceScopeFile)) {
            const ptraceScope = fs.readFileSync(ptraceScopeFile, 'ascii');
            const ptraceLocked = ptraceScope.trim() !== '0';

            if (ptraceLocked) {
                response.success = false;
                response.message = 'Please try running echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope ';
                logger.verbose(response.message);
                this.sendErrorResponse(response, 1, response.message);
            }
        }

        if (!args.port) {
            const defaultPort = 5858;
            args.port = defaultPort;
        }

        if (args.address === 'localhost') {
            const defaultAddress = '127.0.0.1';
            args.address = defaultAddress;
        }

        const cdtAttachArgs: AttachRequestArguments = { ...args };

        cdtAttachArgs.gdb = args.miDebuggerPath || args.debuggerPath;

        try {
            CudaGdbSession.configureLaunch(args, cdtAttachArgs);
        } catch (error) {
            response.success = false;
            response.message = (error as Error).message;
            logger.verbose(`Failed in configureLaunch() with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);
            await super.launchRequest(response, args);

            return;
        }

        const cudaGdbPath = await checkCudaGdb(cdtAttachArgs.gdb);
        logger.verbose('cuda-gdb found and accessible');

        if (cudaGdbPath.kind === 'doesNotExist') {
            response.success = false;
            response.message = `Unable to find cuda-gdb in ${cdtAttachArgs.gdb}`;
            logger.verbose(`Failed with error ${response.message}`);
            this.sendErrorResponse(response, 1, response.message);
        } else {
            cdtAttachArgs.gdb = cudaGdbPath.path;
        }

        logger.verbose('Attach request completed');
        await super.attachRequest(response, cdtAttachArgs);
    }

    protected static getLaunchEnvVars(pathToEnvFile: string): LaunchEnvVarSpec[] {
        if (!isAbsolute(pathToEnvFile)) {
            pathToEnvFile = resolve(pathToEnvFile);
        }

        let envFileContents = '';
        try {
            envFileContents = fs.readFileSync(pathToEnvFile, { encoding: 'utf8', flag: 'r' });
        } catch (error) {
            throw new Error(`Unable to read launch environment variables file:\n${(error as Error).message}`);
        }

        const unsetString = 'unset';

        const envVarSpecs: LaunchEnvVarSpec[] = [];
        const envFileLines = envFileContents.split(/\r?\n/);
        envFileLines.forEach((line) => {
            line = line.trim();
            if (line.length === 0 || line.startsWith('#')) {
                return;
            }

            const eqIdx = line.indexOf('=');
            if (eqIdx >= 0) {
                const name = line.slice(0, eqIdx).trim();
                if (name.length > 0) {
                    const value = line.slice(eqIdx + 1).trim();
                    envVarSpecs.push({ type: 'set', name, value });
                    return;
                }
            } else if (line.startsWith(unsetString) && line.length > unsetString.length) {
                if (line.slice(unsetString.length, unsetString.length + 1).trim().length === 0) {
                    const name = line.slice(unsetString.length + 1).trim();
                    if (name.length > 0) {
                        envVarSpecs.push({ type: 'unset', name });
                        return;
                    }
                }
            }

            logger.warn(`Invalid environment variable specification: ${line}`);
        });

        return envVarSpecs;
    }

    protected static configureLaunch(args: CudaAttachRequestArguments | CudaLaunchRequestArguments, cdtArgs: AttachRequestArguments | LaunchRequestArguments): void {
        if (args.verboseLogging !== undefined) {
            cdtArgs.verbose = args.verboseLogging;
        }

        if (args.verboseLogging !== undefined) {
            cdtArgs.verbose = args.verboseLogging;
        }

        if (!cdtArgs.initCommands) {
            cdtArgs.initCommands = [];
        }

        if ('envFile' in args && args.envFile) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const envVarSpecs = this.getLaunchEnvVars(args.envFile);
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            cdtArgs.initCommands!.unshift(...envVarSpecs.map((spec) => (spec.type === 'set' ? `set env ${spec.name}=${spec.value!}` : `unset env ${spec.name}`)));
        }

        if ('cwd' in args && args.cwd) {
            cdtArgs.initCommands.push(`set cwd ${args.cwd}`);
        }

        if (args.breakOnLaunch) {
            cdtArgs.initCommands.push('set cuda break_on_launch application');
        }

        if (args.onAPIError) {
            cdtArgs.initCommands.push(`set cuda api_failures ${args.onAPIError}`);
        }

        if (args.environment) {
            setEnvVars(args.environment);
        }
    }

    // This method has been borrowed from cdt-gdb-adapter's GDBDebugSession.ts (with modifications).
    protected async configurationDoneRequest(
        response: DebugProtocol.ConfigurationDoneResponse,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        args: DebugProtocol.ConfigurationDoneArguments
    ): Promise<void> {
        try {
            if (this.isAttach) {
                await sendExecContinue(this.gdb);
            } else if (this.cudaCoreDumpPath) {
                await this.gdb.sendCommand(`target cudacore ${this.cudaCoreDumpPath}`);
                await this.sendStoppedEvent('entry', undefined as any, true);
                // const myres = await this.gdb.sendCommand(`cuda device sm warp lane block thread`);
                const rawResult = await this.gdb.sendCommand(`-cuda-focus-query "device sm warp lane block thread"`, true);
                const data = rawResult.replace(/^done,"/, '');
                const blockIdx = utils.parseCudaDim(data, 'block');
                const threadIdx = utils.parseCudaDim(data, 'thread');

                const focus: types.CudaFocus = {
                    type: 'software',
                    blockIdx,
                    threadIdx
                };
                this.cudaThread.setFocus(focus);
                await this.resetCudaFocus();
                this.sendEvent(new ChangedCudaFocusEvent(this.cudaThread.focus));

                // const miResponse: string = JSON.stringify(myres);
                // console.log(miResponse);
                // // this.sendEvent(new OutputEvent(miResponse));
                // // this.sendResponse(response);
            } else if (this.stopAtEntry) {
                await this.gdb.sendCommand('start');
            } else {
                await sendExecRun(this.gdb);
            }
            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, 100, (error as Error).message);
        }
    }

    protected async handleGDBAsync(resultClass: string, resultData: any): Promise<void> {
        if (resultClass === 'stopped') {
            // If the event originated from CUDA there is a CudaFocus field with:
            //
            //     blockIdx:'(0,0,0)'
            //     device:'0'
            //     grid:'1'
            //     kernel:'0'
            //     lane:'0'
            //     sm:'0'
            //     threadIdx:'(0,0,0)'
            //     warp:'0'
            //
            // In this case we add our sentinel thread id to identify CUDA and save
            // off the focus sm, warp, and lane so we can switch back to the same
            // location if focus is switched to a CPU thread.

            if (resultData.CudaFocus) {
                resultData['thread-id'] = this.cudaThread.id.toString();

                // Currently only using software coordinates, use code below if hardware coordinates are needed.
                //
                // const sm: number | undefined = Number.parseInt(resultData.CudaFocus.sm);
                // const warp: number | undefined = Number.parseInt(resultData.CudaFocus.warp);
                // const lane: number | undefined = Number.parseInt(resultData.CudaFocus.lane);
                // const focus: types.CudaFocus = { type: 'hardware', sm, warp, lane };

                const blockIdx: types.CudaDim | undefined = utils.parseCudaDim(resultData.CudaFocus.blockIdx);
                const threadIdx: types.CudaDim | undefined = utils.parseCudaDim(resultData.CudaFocus.threadIdx);
                const focus: types.CudaFocus = { type: 'software', blockIdx, threadIdx };

                if (!utils.equalsCudaFocus(focus, this.cudaThread.focus)) {
                    this.cudaThread.setFocus(focus);
                    await this.resetCudaFocus();

                    this.sendEvent(new ChangedCudaFocusEvent(this.cudaThread.focus));
                }
            } else if (this.cudaThread.hasFocus) {
                this.cudaThread.clearFocus();

                this.sendEvent(new ChangedCudaFocusEvent());
            }

            this.varStore.execContext.resumed = true;
        }

        super.handleGDBAsync(resultClass, resultData);

        if (this.cudaThread.hasFocus && !this.telemetryInfoSent) {
            this.telemetryInfoSent = true;
            const systemInfo = await getSystemInfo(this.gdb);
            this.sendEvent(new SystemInfoEvent(systemInfo));
        }
    }

    protected async handleGDBNotify(notifyClass: string, notifyData: any): Promise<void> {
        if (notifyClass === 'breakpoint-modified') {
            const miBreakpoint: MIBreakpointInfo = notifyData.bkpt as MIBreakpointInfo;
            this.updateBreakpointLocation(miBreakpoint);
        } else {
            super.handleGDBNotify(notifyClass, notifyData);
        }
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
        this.clientInitArgs = args;
        this.forceBreakpointConditions = true;

        super.initializeRequest(response, args);
    }

    protected updateBreakpointLocation(miBreakpoint: MIBreakpointInfo): void {
        try {
            const breakpoint: DebugProtocol.Breakpoint = {
                id: Number.parseInt(miBreakpoint.number, 10),
                verified: true
            };
            if (miBreakpoint.line) {
                breakpoint.line = Number.parseInt(miBreakpoint.line, 10);
            }
            this.sendEvent(new BreakpointEvent('changed', breakpoint));
        } catch (error) {
            const message = `Failed to update breakpoint location: ${(error as Error).message}`;
            logger.error(message);
        }
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            await this.updateThreadList();

            // Create a copy of the thread list and add our fake CUDA thread to the end
            const augmentedThreads: DebugProtocol.Thread[] = [...this.threads, this.cudaThread];

            response.body = {
                threads: augmentedThreads
            };

            this.sendResponse(response);
        } catch (error) {
            this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error));
        }
    }

    protected preResume(): Promise<void> {
        return this.varStore.clearWatches();
    }

    protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
        await this.preResume();
        await super.nextRequest(response, args);
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): Promise<void> {
        await this.preResume();
        await super.stepInRequest(response, args);
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): Promise<void> {
        await this.preResume();
        try {
            await sendExecFinish(this.gdb, args.threadId);
            this.sendResponse(response);
        } catch (error) {
            /* In the case where stepping out results in "Error: "finish" not meaningful in the outermost frame."
            we do not throw an error because that might be misleading for users. */
            if (String(error).trim() !== 'Error: "finish" not meaningful in the outermost frame.') {
                this.sendErrorResponse(response, 1, error instanceof Error ? error.message : String(error));
            }
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
        await this.preResume();
        await super.continueRequest(response, args);
    }

    protected async trackFocus(func: () => Promise<void>): Promise<void> {
        const focus: types.CudaFocus | undefined = this.getCurrentFocus();
        try {
            await func();
        } finally {
            const newFocus: types.CudaFocus | undefined = this.getCurrentFocus();
            if (!utils.equalsCudaFocus(focus, newFocus)) {
                this.sendEvent(new ChangedCudaFocusEvent());
            }
        }
    }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {
        const execFlag = '-exec';
        const backtickFlag = '`';
        const miFlag = '-mi';

        let consoleCommand = '';

        const expression = args.expression.trimLeft();

        if (expression) {
            if (expression.startsWith(execFlag)) {
                consoleCommand = expression.slice(execFlag.length).trimLeft();
            } else if (expression.startsWith(backtickFlag)) {
                consoleCommand = expression.slice(backtickFlag.length).trimLeft();
            } else if (expression.startsWith(miFlag)) {
                consoleCommand = expression.slice(miFlag.length).trimLeft();
                const miResponse: string = JSON.stringify(await this.gdb.sendCommand(consoleCommand));
                this.sendEvent(new OutputEvent(miResponse));
                this.sendResponse(response);
                return;
            }
        }
        if (consoleCommand) {
            await this.trackFocus(async () => {
                await this.gdb.sendCommand(consoleCommand);
                this.sendResponse(response);
                this.invalidateState();
            });
        } else {
            if (args.frameId === undefined) {
                this.sendErrorResponse(response, 1, 'Missing frame number');
                return;
            }

            const frame = this.frameHandles.get(args.frameId);

            if (!frame) {
                this.sendResponse(response);
                return;
            }

            const varObj = await this.varStore.evaluate(args.expression);

            let variablesReference = 0;

            if (varObj && Number.parseInt(varObj.numchild) > 0) {
                const varObjReference: ContainerObjectReference = {
                    type: 'object',
                    frameHandle: args.frameId,
                    varobjName: varObj.varname
                };

                variablesReference = this.variableHandles.create(varObjReference);
            }

            const result = varObj?.value || '<Not available>';

            response.body = {
                result,
                variablesReference
            };

            if (varObj && this.clientInitArgs?.supportsVariableType === true) {
                response.body.type = varObj.type;
            }

            this.sendResponse(response);
        }
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
        const localReference: FrameVariableReference = {
            type: 'frame',
            frameHandle: args.frameId
        };

        const registerReference: RegistersVariableReference = {
            type: 'frame',
            scope: 'registers',
            isCUDA: this.frameHandles.get(args.frameId).threadId === undefined,
            frameHandle: args.frameId
        };

        const localScope = new Scope('Local', this.variableHandles.create(localReference), false);
        const registerScope: DebugProtocol.Scope = new Scope('Registers', this.variableHandles.create(registerReference), false);
        registerScope.presentationHint = 'registers';

        response.body = {
            scopes: [localScope, registerScope]
        };

        this.sendResponse(response);
    }

    protected getFrameFromHandle(frameHandle: number): FrameReference | undefined {
        const frame = this.frameHandles.get(frameHandle);
        return frame;
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {
        await this.executionQueue.execute(async () => {
            try {
                await this.focusOnThread(args.threadId ?? this.cudaThread.focus);
                await super.stackTraceRequest(response, args);

                if (this.cudaThread.hasFocus && args.threadId !== undefined) {
                    await this.resetCudaFocus();
                }

                await this.focusOnFrame(this.uiFocusedFrame);
                // await this.invalidationCompleteTrigger?.resolve('stacks');
            } catch (error) {
                this.sendErrorResponse(response, 1, (error as Error).message);
            }
        });
    }

    // This function has been borrowed from CDT's implementation with a slight
    // modification to check for child.value being nullish (null or undefined.)
    // eslint-disable-next-line class-methods-use-this
    protected isChildOfClass(child: MIVarChild): boolean {
        return child.type === undefined && (!child.value || child.value === '') && (child.exp === 'public' || child.exp === 'protected' || child.exp === 'private');
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): Promise<void> {
        try {
            await this.executionQueue.execute(async () => {
                const variables = new Array<DebugProtocol.Variable>();
                response.body = { variables };

                const frameOrObjectRef = this.variableHandles.get(args.variablesReference);

                if (!frameOrObjectRef) {
                    this.sendResponse(response);
                    return;
                }

                if (frameOrObjectRef.type === 'frame') {
                    const ref = frameOrObjectRef as RegistersVariableReference;
                    const frameRef: FrameReference = this.frameHandles.get(ref.frameHandle);
                    const realizedFrame = this.realizeFrameReference(frameRef);

                    await this.focusOnFrame(realizedFrame);

                    if (ref?.scope === 'registers') {
                        await this.registersRequest(response, args, ref);
                    } else {
                        await this.localsRequest(response, args, frameOrObjectRef);
                    }

                    await this.focusOnFrame(this.uiFocusedFrame);
                } else {
                    const ref = frameOrObjectRef as ContainerObjectReference;

                    await this.populateChildren(ref);

                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    response.body.variables = ref.children!.map((child) => {
                        const variableReference = typeof child.reference === 'number' ? child.reference : 0;
                        return new Variable(child.name, child.value, variableReference);
                    });

                    this.sendResponse(response);
                }
            });
            // await this.invalidationCompleteTrigger?.resolve('variables');
        } catch (error) {
            response.body = { variables: [] };
            this.sendErrorResponse(response, 1, (error as Error).message);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    protected async populateChildren(ref: ContainerObjectReference): Promise<void> {
        const listChildrenResp = await sendVarListChildren(this.gdb, {
            name: ref.varobjName,
            printValues: MIVarPrintValues.all
        });

        const rawChildVarObjects: MIVarChild[] = listChildrenResp.children;

        const flattenedChildVarObjects: MIVarChild[] = [];
        const displayNames = new Map<string, string>();

        // eslint-disable-next-line unicorn/no-for-loop
        for (let i = 0; i < rawChildVarObjects.length; i += 1) {
            const childVarObj = rawChildVarObjects[i];
            if (this.isChildOfClass(childVarObj)) {
                // eslint-disable-next-line no-await-in-loop
                const expandedChildrenResp: any = await sendVarListChildren(this.gdb, {
                    name: childVarObj.name,
                    printValues: MIVarPrintValues.all
                });

                const expandedChildren: MIVarChild[] = expandedChildrenResp.children;

                expandedChildren.forEach((expChild) => {
                    flattenedChildVarObjects.push(expChild);

                    let displayName = expChild.name;
                    if (displayName.startsWith(`${childVarObj.name}.`)) {
                        displayName = displayName.slice(childVarObj.name.length + 1);
                    }

                    displayNames.set(expChild.name, displayName);
                });
            } else {
                flattenedChildVarObjects.push(childVarObj);

                let displayName = childVarObj.name;
                if (displayName.startsWith(`${ref.varobjName}.`)) {
                    displayName = displayName.slice(ref.varobjName.length + 1);
                }

                displayNames.set(childVarObj.name, displayName);
            }
        }

        ref.children = flattenedChildVarObjects.map((child) => {
            return {
                // displayNames should always have a value for child.name.
                name: displayNames.get(child.name) ?? '<ERROR>',
                reference:
                    Number.parseInt(child.numchild) === 0
                        ? child.name
                        : this.variableHandles.create({
                              type: 'object',
                              frameHandle: ref.frameHandle,
                              varobjName: child.name
                          }),
                value: child.value ?? '',
                type: child.type
            };
        });
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): Promise<void> {
        const ref = this.variableHandles.get(args.variablesReference);

        if (ref === undefined) {
            this.sendErrorResponse(response, 1, 'Invalid variable reference');
        }

        let varObjName: string | undefined;

        let childEntry:
            | {
                  name: string;
                  reference: string | number;
                  value: string;
                  type: string;
              }
            | undefined;

        if (ref.type === 'frame') {
            if ((ref as RegistersVariableReference)?.scope !== 'registers') {
                varObjName = this.varStore.getLocalByName(args.name)?.varname;
            }
        } else {
            const objRef = ref as ContainerObjectReference;
            childEntry = objRef.children?.filter((child) => child.name === args.name)[0];
            if (childEntry !== undefined) {
                const childRef = childEntry.reference;
                if (typeof childRef === 'number') {
                    varObjName = (this.variableHandles.get(childRef) as ContainerObjectReference).varobjName;
                } else {
                    varObjName = childRef as string;
                }
            }
        }

        if (varObjName) {
            const assignResp = await sendVarAssign(this.gdb, { varname: varObjName, expression: args.value });

            if (assignResp.value === args.value) {
                const changes = await this.varStore.update();

                // If this assignment resulted in values in other variables changing
                // (usually because two members point to the same memory location),
                // send back an Invalidated event for variables.
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const shouldInvalidate = !changes.every((c) => c.name.startsWith(varObjName!));

                if (shouldInvalidate) {
                    this.sendResponse(response);
                    this.sendEvent(new InvalidatedEvent(['variables']));
                    return;
                }

                const update = changes.filter((c) => c.name === varObjName)[0];
                if (update) {
                    let variablesReference = 0;
                    let type: string | undefined;
                    if (ref.type === 'frame') {
                        const varObj = this.varStore.updateLocal(varObjName, update as VarUpdateChanges);

                        if (varObj) {
                            type = varObj.type;

                            if (Number.parseInt(varObj.numchild, 10) > 0) {
                                variablesReference = this.variableHandles.create({
                                    type: 'object',
                                    frameHandle: ref.frameHandle,
                                    varobjName: varObjName
                                });
                            }
                        }
                    } else {
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        const entry = childEntry!;

                        if ((update.type_changed && Number.parseInt(update.new_num_children, 10) > 0) || (!update.type_changed && typeof entry.reference === 'number')) {
                            // We don't delete the old handle here because handles
                            // are reset every time the program stops.
                            variablesReference = this.variableHandles.create({
                                type: 'object',
                                frameHandle: ref.frameHandle,
                                varobjName: varObjName
                            });

                            entry.reference = variablesReference > 0 ? variablesReference : varObjName;
                        }

                        if (update.type_changed) {
                            entry.type = update.new_type;
                        }

                        type = entry.type;
                    }

                    response.body = {
                        value: args.value,
                        type,
                        variablesReference
                    };
                }
            }
        }

        this.sendResponse(response);
    }

    protected async localsRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, ref: FrameVariableReference): Promise<void> {
        response.body.variables = [];

        const frameRef = this.frameHandles.get(ref.frameHandle);
        const realizedFrame = this.realizeFrameReference(frameRef);
        if (!realizedFrame) {
            return;
        }

        const stackVarObjects = await this.varStore.getLocals(realizedFrame.focus, frameRef.frameId);

        response.body.variables = stackVarObjects.map(
            (vo) =>
                new Variable(
                    vo.expression,
                    vo.value,
                    Number.parseInt(vo.numchild) === 0
                        ? 0
                        : this.variableHandles.create({
                              type: 'object',
                              frameHandle: frameRef.frameId,
                              varobjName: vo.varname
                          })
                )
        );

        this.sendResponse(response);
    }

    protected async registersRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, reference: RegistersVariableReference): Promise<void> {
        response.body.variables = [];

        if (reference.registerGroup !== undefined) {
            const group = reference.registerGroup;

            const registerValuesMap = new Map<number, string>();

            try {
                const registersToFetch = group.registers.map((r) => r.ordinal.toString());
                const registerValuesResp: any = await this.gdb.sendCommand(`-data-list-register-values x ${registersToFetch.join(' ')}`);

                const registerValues = registerValuesResp['register-values'] as RegisterNameValuePair[];

                registerValues.forEach((pair) => {
                    registerValuesMap.set(Number.parseInt(pair.number), pair.value);
                });
            } catch {
                // If there is an error in getting the value of a register localize the error so other registers are shown.
                for (let i = 0; i < group.registers.length; i += 1) {
                    const reg = group.registers[i];

                    try {
                        // eslint-disable-next-line no-await-in-loop
                        const registerValueResp: any = await this.gdb.sendCommand(`-data-list-register-values x ${reg.ordinal}`);

                        const registerValue = registerValueResp['register-values'] as RegisterNameValuePair[];

                        registerValue.forEach((pair) => {
                            registerValuesMap.set(Number.parseInt(pair.number), pair.value);
                        });
                    } catch {
                        registerValuesMap.set(reg.ordinal, 'N/A');
                    }
                }
            }

            group.registers.forEach((reg) => {
                const rawRegisterValue = registerValuesMap.get(reg.ordinal);

                if (rawRegisterValue) {
                    const numericalValue = Number.parseInt(rawRegisterValue);

                    if (Number.isNaN(numericalValue)) {
                        response.body.variables.push(new Variable(reg.name, rawRegisterValue));
                    }

                    if (group?.isPredicate === true) {
                        response.body.variables.push(new Variable(reg.name, numericalValue.toString()));
                    } else {
                        response.body.variables.push(new Variable(reg.name, formatRegister(numericalValue, group)));
                    }
                }
            });
        } else {
            let registerGroupDefinitions: any[] | undefined;
            if (reference.isCUDA) {
                registerGroupDefinitions = deviceRegisterGroups;
            }
            // else: We can add definitions here for machine registers and possibly allow reading the
            // register definitions for machine registers from a JSON file specified by the user.

            if (registerGroupDefinitions) {
                if (!reference.registerData) {
                    const parsedRegNamesAll: any = await this.gdb.sendCommand('-data-list-register-names');

                    const parsedRegNames: string[] = parsedRegNamesAll['register-names'];

                    const registerGroups: RegisterGroup[] = registerGroupDefinitions.map((def) => new RegisterGroup(def.groupName, def.groupPattern, def.isPredicate === true, def.isHidden === true));

                    const recordedRegisterNames = new Set<string>();

                    parsedRegNames.forEach((registerName, ordinal) => {
                        let matchingGroup;

                        // Ignore registers with an empty name
                        if (registerName.length === 0) {
                            return;
                        }

                        if (reference.isCUDA) {
                            if (recordedRegisterNames.has(registerName)) {
                                // If cuda-gdb returns repeated register names, that is a bug.
                                return;
                            }

                            recordedRegisterNames.add(registerName);
                        }

                        // eslint-disable-next-line unicorn/no-for-loop
                        for (let i = 0; i < registerGroups.length; i += 1) {
                            const group = registerGroups[i];

                            if (registerName.match(group.groupPattern)) {
                                matchingGroup = group;
                                break;
                            }
                        }

                        if (matchingGroup) {
                            const register = new Register(ordinal, registerName, matchingGroup);
                            matchingGroup.registers.push(register);
                        }
                    });

                    reference.registerData = new RegisterData(registerGroups);
                }

                reference.registerData.registerGroups.forEach((group) => {
                    if (group.registers.length > 0 && !group.isHidden) {
                        const groupRef: RegistersVariableReference = {
                            type: 'frame',
                            scope: 'registers',
                            isCUDA: reference.isCUDA,
                            frameHandle: reference.frameHandle,
                            registerData: reference.registerData,
                            registerGroup: group
                        };

                        const handle = this.variableHandles.create(groupRef);

                        response.body.variables.push(new Variable(group.groupName, '', handle, 0, group.registers.length));
                    }
                });
            } else {
                // If there no register definitions, just display the registers in a default flat format.
                const parsedRegNamesResp: any = await this.gdb.sendCommand('-data-list-register-names');
                const parsedRegNames: string[] = parsedRegNamesResp['register-names'];

                const registerValuesResp: any = await this.gdb.sendCommand('-data-list-register-values x');
                const registerValues = registerValuesResp['register-values'] as RegisterNameValuePair[];

                registerValues.forEach((pair) => {
                    const regNum = Number.parseInt(pair.number);
                    const regName = parsedRegNames[regNum];
                    response.body.variables.push(new Variable(regName, pair.value));
                });
            }
        }

        this.sendResponse(response);
    }

    private async invalidateAreas(areas: DebugProtocol.InvalidatedAreas[]): Promise<void> {
        this.sendEvent(new InvalidatedEvent(areas, this.cudaThread.id));
    }

    // disassemble-request implementation
    //
    // The response returned by disassembleRequest must (_exactly_) meet the requested the args.instructionOffset and
    // args.instructionCount. As such, we disassemble backward and forward until the count of both the preceding and
    // following instructions are met. If these instructions do not exist, the instructions array is prepended/appended
    // with instances of a "dummy" instruction to meet these counts.
    //
    // To easier understand the the code, ponder the following 3 scenarios (These scenarios are merely examples. They
    // are based on the requests VS code sends at the time of this writing, but the code makes no assumption limiting
    // incoming requests to these scenarios (and nor should the reader)):
    //
    // - Initial request: args.instructionOffset is -200, args.instructionCount is 400, which means get the current
    //   instruction, 200 instructions before it and 199 instructions after.
    //
    // - Scroll down: args.instructionOffset is 1, instructionCount is 50, which means give me 50 instructions after
    //   args.memoryReference (the address of the last instruction in the array backing the graphical view) excluding
    //   the instruction at args.memoryReference (because args.instructionOffset is 1).
    //
    // - Scroll up: args.instructionOffset is -50, args.instructionCount is 50, which means give me 50 instructions
    //   before args.memoryReference (the address of the first instruction in the array backing the graphical view).

    protected async getSassInstructionSize(): Promise<number | undefined> {
        // We intentionally do not cache this as we could switch GPUs in between stop events.

        const gpuInfo = await getDevicesInfo(this.gdb);
        const currentDevice = gpuInfo.find((d) => d?.current?.includes('*'));
        if (!currentDevice?.smType?.startsWith('sm_')) {
            return;
        }

        const majorArch = Number.parseInt(currentDevice.smType.slice('sm_'.length, -1));
        // eslint-disable-next-line consistent-return
        return majorArch >= 7 ? 16 : 8;
    }

    static readonly invalidAddress = '??';

    static readonly dummyInstruction: DebugProtocol.DisassembledInstruction = {
        address: this.invalidAddress,
        instruction: '??'
    } as DebugProtocol.DisassembledInstruction;

    protected getInstructionSizeEstimate(): Promise<number | undefined> {
        if (this.cudaThread.hasFocus) {
            return this.getSassInstructionSize();
        }

        // TODO: (Tracked in internal bug) We need to set the correct estimate for other architectures (esp. AArch64) here.
        const instructionSizeEstimate = 4;
        return Promise.resolve(instructionSizeEstimate);
    }

    // Disassemble-backward relies on "-data-disassemble -a". It iteratively goes back until it finds an address belonging to
    // a known function (i.e. a function with debug information). Once we have this address, we use "-data-disassemble -a" to
    // disassemble the function.
    //
    // - The number of bytes disassemble-backward walks back every iteration is called the "step size" and is determined by
    //   <#instructions to rewind> * <bytes per instruction>. This is calculated by getBackwardDisassembleStepSize() below.
    //
    // - The number of iterations is determined by numberOfBackwardDisassembleSteps below.

    protected async getBackwardDisassembleStepSize(): Promise<number | undefined> {
        if (this.cudaThread.hasFocus) {
            const instructionsToRewind = 16;
            const sassInstructionSize = await this.getSassInstructionSize();
            return sassInstructionSize ? sassInstructionSize * instructionsToRewind : undefined;
        }

        // TODO: (Tracked in internal bug) We need to adjust instructionsToRewind for other architectures (than x86_64) here.
        const instructionsToRewind = 16;
        const instructionSizeEstimate = await this.getInstructionSizeEstimate();
        return instructionSizeEstimate ? instructionsToRewind * instructionSizeEstimate : undefined;
    }

    static readonly numberOfBackwardDisassembleSteps = 16;

    protected async disassembleBackward(instructions: DebugProtocol.DisassembledInstruction[], address: string, backwardDisassembleStepSize: number): Promise<void> {
        let result: MIDataDisassembleResponse | undefined;
        for (let i = 1; i <= CudaGdbSession.numberOfBackwardDisassembleSteps; i += 1) {
            const addressToTry = `(${address})-${i * backwardDisassembleStepSize}`;
            try {
                // eslint-disable-next-line no-await-in-loop
                result = await sendDataDisassemble(this.gdb, addressToTry);
                logger.verbose(`[Disassemble backward] Succeeded with address ${addressToTry}`);
                break;
            } catch (error) {
                const errorString = error instanceof Error ? error.message : String(error);
                logger.verbose(`[Disassemble backward] Failed at address: ${addressToTry}, Error: ${errorString}`);
            }
        }

        if (result) {
            this.flattenDisassembledInstructions(result.asm_insns, instructions, 0);

            const lastInstructionFetched = instructions.at(-1)?.address;

            if (lastInstructionFetched !== undefined) {
                try {
                    logger.verbose(`[Disassemble backward] Attempting to retrieve instructions in the interim range [${lastInstructionFetched}, ${address}).`);
                    result = await sendDataDisassemble(this.gdb, { startAddress: lastInstructionFetched, endAddress: address });
                } catch (error) {
                    const errorString = error instanceof Error ? error.message : String(error);
                    logger.verbose(`[Disassemble backward] Failed to fetch the disassembly between ${lastInstructionFetched} and ${address}, Error: ${errorString}`);
                    result = undefined;
                }

                if (result) {
                    this.flattenDisassembledInstructions(result.asm_insns, instructions, 1);
                }
            }
        } else {
            logger.verbose('[Disassemble backward] Failed.');
        }
    }

    protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: CDTDisassembleArguments): Promise<void> {
        logger.verbose(`[Disassemble request] Parameters: ${JSON.stringify(args)}`);

        if (this.cudaThread.hasFocus) {
            args.excludeRawOpcodes = true;
        }

        if (args.offset) {
            this.sendErrorResponse(response, 1, 'Unsupported argument "Offset"');
            return;
        }

        if (args.memoryReference === CudaGdbSession.invalidAddress) {
            logger.verbose(`[Disassemble request] Invalid initial address. Returning ${args.instructionCount} dummy instructions.`);

            response.body = { instructions: new Array(args.instructionCount).fill(CudaGdbSession.dummyInstruction) };
            this.sendResponse(response);
            return;
        }

        let currentInstruction: DebugProtocol.DisassembledInstruction;

        try {
            const startAddress = `(${args.memoryReference})+${args.offset ?? 0}`;
            const endAddress = `(${args.memoryReference})+${(args.offset ?? 0) + 1}`;

            const result = await sendDataDisassemble(this.gdb, { startAddress, endAddress });

            const instructions: DebugProtocol.DisassembledInstruction[] = [];
            this.flattenDisassembledInstructions(result.asm_insns, instructions, 0);

            [currentInstruction] = instructions;
        } catch (error) {
            const errorString = error instanceof Error ? error.message : String(error);

            logger.error(`[Disassemble request] Disassembly at the initial address failed: ${errorString}`);

            this.sendErrorResponse(response, 1, errorString);
            return;
        }

        let instructions: DebugProtocol.DisassembledInstruction[] = [];

        try {
            const result = await sendDataDisassemble(this.gdb, currentInstruction.address);
            this.flattenDisassembledInstructions(result.asm_insns, instructions, 0);

            logger.verbose(`[Disassemble request] "-data-disassemble -a ${currentInstruction.address}" succeeded.`);
        } catch {
            logger.error(`[Disassemble request] "-data-disassemble -a ${currentInstruction.address}" failed. Falling back to disassembling from current instruction.`);
            instructions = [currentInstruction];
        }

        const indexOfCurrentInsn = instructions.findIndex((i) => i.address === currentInstruction.address);

        if (indexOfCurrentInsn < 0) {
            logger.error(`[Disassemble request] Unable to locate the initial memory reference in the disassembled instructions.`);

            this.sendErrorResponse(response, 1, 'Reference address not found.');
            return;
        }

        const instructionOffset = args.instructionOffset ?? 0;
        const indexOfSplice = indexOfCurrentInsn + instructionOffset;

        let lastAddressRead = instructions[instructions.length - 1].address;

        let instructionsToSkip = 0;

        if (indexOfSplice < 0) {
            let instructionDeficit = -indexOfSplice;

            logger.verbose(`[Disassemble request] Need ${instructionDeficit} instructions at the beginning.`);

            const backwardDisassembleStepSize = await this.getBackwardDisassembleStepSize();

            if (!backwardDisassembleStepSize) {
                logger.error(`[Disassemble request] Backward disassemble step size: ${backwardDisassembleStepSize}`);

                this.sendErrorResponse(response, 1, 'Unable to determine the machine instruction size.');
                return;
            }

            logger.verbose(`[Disassemble request] Backward disassemble step size: ${backwardDisassembleStepSize}`);

            while (instructionDeficit > 0) {
                logger.verbose(`[Disassemble request] Attempting to disassemble backward. Instruction deficit: ${instructionDeficit}`);

                const priorInstructions: DebugProtocol.DisassembledInstruction[] = [];
                // eslint-disable-next-line no-await-in-loop
                await this.disassembleBackward(priorInstructions, instructions[0].address, backwardDisassembleStepSize);
                if (priorInstructions.length === 0) {
                    logger.verbose(`[Disassemble request] Disassemble backward failed. Prepending ${instructionDeficit} dummy instruction(s) to the instructions array.`);

                    instructions = new Array(instructionDeficit).fill(CudaGdbSession.dummyInstruction).concat(instructions);
                    break;
                }
                if (priorInstructions.length <= instructionDeficit) {
                    instructions = priorInstructions.concat(instructions);
                    instructionDeficit -= priorInstructions.length;

                    logger.verbose(`[Disassemble request] Disassemble backward returned ${priorInstructions.length} instruction(s). New instruction deficit: ${instructionDeficit}.`);
                } else {
                    logger.verbose(`[Disassemble request] Disassemble backward returned ${priorInstructions.length} > ${instructionDeficit} instruction(s).`);

                    instructions = priorInstructions.slice(-instructionDeficit).concat(instructions);
                    break;
                }
            }

            logger.verbose('[Disassemble request] Finished disassembling backward.');
        } else {
            logger.verbose(`[Disassemble request] Dropping ${indexOfSplice} instructions from the beginning. Requested instruction offset: ${instructionOffset}, Actual instruction offset: ${indexOfCurrentInsn}`);

            if (indexOfSplice < instructions.length) {
                instructions.splice(0, indexOfSplice);
            } else {
                instructionsToSkip = indexOfSplice - instructions.length;
                instructions = [];
            }
        }

        if (instructions.length > args.instructionCount) {
            logger.verbose(`[Disassemble request] Dropping ${instructions.length - args.instructionCount} instructions from the end. Requested #instructions: ${args.instructionCount}`);

            instructions.splice(args.instructionCount);
        } else if (instructions.length < args.instructionCount) {
            logger.verbose(`[Disassemble request] Need more instructions to meet the requested instruction count (${args.instructionCount}).`);

            const machineInstructionSize = await this.getInstructionSizeEstimate();
            if (!machineInstructionSize) {
                logger.verbose(`[Disassemble request] Unable to determine the machine instruction size.`);

                this.sendErrorResponse(response, 1, 'Unable to determine the machine instruction size.');
                return;
            }

            // eslint-disable-next-line no-constant-condition
            while (true) {
                let result2: MIDataDisassembleResponse | undefined;

                // Never take too few instructions
                const instructionsToFetch = Math.max(args.instructionCount - instructions.length, 8);
                const fetchSize = machineInstructionSize * instructionsToFetch;

                const startAddress = lastAddressRead;
                const endAddress = `(${startAddress})+${fetchSize}`;

                logger.verbose(`[Disassemble request] Disassemble forward. Instruction deficit: ${args.instructionCount - instructions.length}, Start address: ${startAddress}, End address: ${endAddress}`);

                try {
                    // eslint-disable-next-line no-await-in-loop
                    result2 = await sendDataDisassemble(this.gdb, { startAddress, endAddress });
                } catch (error) {
                    const errorString = error instanceof Error ? error.message : String(error);
                    logger.error(`[Disassemble request] Disassemble forward: Error while trying to retrieve instructions following address ${startAddress}. Fetch size: ${fetchSize}, Error: ${errorString}`);

                    logger.verbose(`[Disassemble request] Disassemble forward: Appending the instructions array with ${args.instructionCount - instructions.length} dummy instruction(s).`);
                    instructions = instructions.concat(new Array(args.instructionCount - instructions.length).fill(CudaGdbSession.dummyInstruction));
                    break;
                }

                const skippedInstructions: DebugProtocol.DisassembledInstruction[] = [];
                const { instructionsSkipped, instructionsWritten } = this.flattenDisassembledInstructions(result2.asm_insns, instructions, instructionsToSkip + 1, args.instructionCount - instructions.length, skippedInstructions);
                instructionsToSkip -= instructionsSkipped - 1;

                if (!instructionsWritten && !instructionsSkipped) {
                    logger.error(`[Disassemble request] Disassemble forward: No instructions returned while trying to retrieve instructions following address ${startAddress}. Fetch size: ${fetchSize}`);
                    logger.verbose(`[Disassemble request] Disassemble forward: Appending the instructions array with ${args.instructionCount - instructions.length} dummy instruction(s).`);
                    instructions = instructions.concat(new Array(args.instructionCount - instructions.length).fill(CudaGdbSession.dummyInstruction));
                    break;
                }

                if (instructions.length >= args.instructionCount) {
                    logger.verbose(`[Disassemble request] Disassemble forward: Instruction count is now at ${instructions.length}. Stopping and splicing at ${args.instructionCount}`);
                    instructions.splice(args.instructionCount);
                    break;
                } else {
                    lastAddressRead = instructions.at(-1)?.address ?? skippedInstructions[skippedInstructions.length - 1].address;
                }
            }

            logger.verbose('[Disassemble request] Disassemble forward completed.');
        }

        const performDisassembleSanityChecks = this.testMode;

        if (performDisassembleSanityChecks) {
            const assert = (cond: boolean, msg?: string): void => {
                if (!cond) {
                    throw new Error(msg ? `Assertion failed: ${msg}` : 'Assertion failed.');
                }
            };

            const instructionLength = (inst: DebugProtocol.DisassembledInstruction): number => (inst.instructionBytes?.replace(/\s/g, '') ?? '').length / 2;

            const follows = (inst1: DebugProtocol.DisassembledInstruction, inst2: DebugProtocol.DisassembledInstruction): boolean => {
                // Javascript's "number" is double-precision floating point so it can't handle 64-bit address arithmetic with precision.
                // However, it does support 32-bit bitwise arithmetic, which we use below.
                const hexDigitsIn32Bits = 8;
                let addr1 = Number.parseInt(inst1.address.slice(-hexDigitsIn32Bits), 16);
                const addr2 = Number.parseInt(inst2.address.slice(-hexDigitsIn32Bits), 16);
                assert(!Number.isNaN(addr1), `Invalid address: ${inst1.address}`);
                assert(!Number.isNaN(addr2), `Invalid address: ${inst2.address}`);

                addr1 += instructionLength(inst1);

                // Truncate addr1 to 32 bits and compare.

                // eslint-disable-next-line no-bitwise
                return addr1 >>> 0 === addr2;
            };

            if (args.instructionOffset === 1 && instructions.length > 0 && instructions[0].address !== CudaGdbSession.invalidAddress) {
                assert(follows(currentInstruction, instructions[0]), 'Scroll down condition not met.');
            }

            if (args.instructionOffset && args.instructionOffset < 0 && args.instructionCount === -args.instructionOffset && instructions.length > 0 && instructions[instructions.length - 1].address !== CudaGdbSession.invalidAddress) {
                assert(follows(instructions[instructions.length - 1], currentInstruction), 'Scroll up condition not met.');
            }

            for (let i = 0; i < instructions.length - 1; i += 1) {
                if (instructions[i].address !== CudaGdbSession.invalidAddress && instructions[i + 1].address !== CudaGdbSession.invalidAddress) {
                    assert(follows(instructions[i], instructions[i + 1]), `${instructions[i].address}+${instructionLength(instructions[i])} != ${instructions[i + 1].address}`);
                }
            }
        }

        if (args.excludeRawOpcodes) {
            instructions.forEach((i) => {
                i.instructionBytes = undefined;
            });
        }

        response.body = { instructions };
        this.sendResponse(response);

        logger.verbose(`[Disassemble request] Response sent with ${instructions.length} instruction(s).`);
    }

    private async changeCudaFocusRequest(response: CudaDebugProtocol.ChangeCudaFocusResponse, args: any): Promise<void> {
        try {
            const typedArgs: CudaDebugProtocol.ChangeCudaFocusArguments = args as CudaDebugProtocol.ChangeCudaFocusArguments;
            const focus: types.CudaFocus = typedArgs.focus as types.CudaFocus;

            await this.focusOnThread(focus);

            if (!response.body) {
                response.body = {};
            }

            let newFocus: types.CudaFocus | undefined;

            // TODO: Verify that the set focus command succeeded, find a way to get current focus
            if (focus.type === 'software' && this.cudaThread.focus?.type === 'software') {
                const coerceDim = (dim1?: types.CudaDim, dim2?: types.CudaDim): types.CudaDim => {
                    const x: number = dim1?.x ?? dim2?.x ?? 0;
                    const y: number = dim1?.y ?? dim2?.y ?? 0;
                    const z: number = dim1?.z ?? dim2?.z ?? 0;

                    return { x, y, z };
                };

                const blockIdx: types.CudaDim = coerceDim(focus.blockIdx, this.cudaThread.focus?.blockIdx);
                const threadIdx: types.CudaDim = coerceDim(focus.threadIdx, this.cudaThread.focus?.threadIdx);
                newFocus = { type: 'software', blockIdx, threadIdx };
            } else if (focus.type === 'hardware' && this.cudaThread.focus?.type === 'hardware') {
                const sm: number = focus.sm ?? this.cudaThread.focus?.sm ?? 0;
                const warp: number = focus.warp ?? this.cudaThread.focus?.warp ?? 0;
                const lane: number = focus.lane ?? this.cudaThread.focus?.lane ?? 0;
                newFocus = { type: 'hardware', sm, warp, lane };
            } else {
                this.sendErrorResponse(response, 1, 'Mixing hardware and software coordinates to change focus is not supported.');
            }

            if (newFocus) {
                this.cudaThread.setFocus(newFocus);
                if (this.uiFocusedFrame && VariableObjectStore.isCudaFocus(this.uiFocusedFrame?.focus)) {
                    this.uiFocusedFrame = { focus: newFocus, frameId: 0 };
                }

                response.body.focus = newFocus;
                this.sendResponse(response);

                this.sendEvent(new ChangedCudaFocusEvent(newFocus));
                await this.invalidateAreas(['stacks', 'variables']);
                this.invalidateState();
            }
        } catch (error) {
            this.sendErrorResponse(response, 1, (error as Error).message);
            await this.focusOnFrame(this.uiFocusedFrame);
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private async resetSelectedFocusRequest(response: CudaDebugProtocol.ResetFocusResponse, args: any): Promise<void> {
        try {
            await this.focusOnFrame(this.uiFocusedFrame);
        } catch (error) {
            this.sendErrorResponse(response, 1, (error as Error).message);
        }
    }

    private async resetCudaFocus(): Promise<void> {
        if (!this.cudaThread.hasFocus) {
            return;
        }

        const setFocusCommand: string = utils.formatSetFocusCommand(this.cudaThread.focus);
        await this.gdb.sendCommand(setFocusCommand);
    }

    private invalidateState(): void {
        this.sendStoppedEvent('Refreshing State', this.cudaThread.id);
    }
}

// This function is simple for the time being and merely
// serves as a note that we can read the format (esp.
// decimal or hex) from the user preferences at some
// point down the road.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function formatRegister(value: number, registerGroup: RegisterGroup): string {
    return toFixedHex(value, 8);
}

function toFixedHex(value: number, width: number): string {
    const hexStr: string = value.toString(16);

    if (hexStr === 'NaN') {
        return hexStr;
    }

    const paddingSize = Math.max(0, width - hexStr.length);

    return `0x${'0'.repeat(paddingSize)}${hexStr}`;
}

export async function checkCudaGdb(path: string | undefined, isQNX = false): Promise<CudaGdbExists> {
    const binaryName = isQNX ? 'cuda-qnx-gdb' : 'cuda-gdb';

    if (path === undefined) {
        const res = which(binaryName)
            .then((cudaGdbPath: string) => {
                return { kind: 'exists', path: cudaGdbPath } as CudaGdbPathResult;
            })
            .catch((error: Error) => {
                // checks if cuda-gdb exists in the default location
                const defaultLocation = isQNX ? '/usr/local/cuda/bin/cuda-qnx-gdb' : '/usr/local/cuda/bin/cuda-gdb';

                if (existsSync(defaultLocation)) {
                    return { kind: 'exists', path: defaultLocation } as CudaGdbPathResult;
                }
                logger.error(`Unable to find cuda-gdb, ${error}`);
                return { kind: 'doesNotExist' } as NoCudaGdbResult;
            });
        return res;
    }

    // the path.endsWith check is for the scenario that the user enters a valid path but one that does not contain cuda-gdb
    // checks that path is valid and path contains cuda-gdb
    const isCudaGdbPathValid = existsSync(path) && path.endsWith(binaryName);
    if (isCudaGdbPathValid) {
        return { kind: 'exists', path } as CudaGdbPathResult;
    }

    return { kind: 'doesNotExist' } as NoCudaGdbResult;
}

export function setEnvVars(envVars: Environment[]): void {
    envVars.forEach((envVarVal) => {
        process.env[envVarVal.name] = envVarVal.value;
    });
}

async function getDevicesInfo(gdb: GDBBackend): Promise<types.GpuInfo[]> {
    const devicesResponse = await gdb.sendCommand<MICudaInfoDevicesResponse>('-cuda-info-devices');
    const gpuInfo: types.GpuInfo[] = devicesResponse.InfoCudaDevicesTable?.body?.map((value) => {
        return {
            current: value?.current,
            name: value?.name,
            description: value?.description,
            smType: value?.sm_type
        };
    });

    return gpuInfo;
}

async function getSystemInfo(gdb: GDBBackend): Promise<types.SystemInfo> {
    const osInfo: types.OsInfo = await utils.readOsInfo();
    const gpuInfo = await getDevicesInfo(gdb);

    const systemInfo: types.SystemInfo = {
        os: osInfo,
        gpus: gpuInfo
    };

    return systemInfo;
}

/* eslint-enable max-classes-per-file */
/* eslint-enable no-param-reassign */
