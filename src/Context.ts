import { FunctionInfo } from './FunctionInfo';
import { fromRpcHttp, fromTypedData, getNormalizedBindingData, getBindingDefinitions, fromRpcTraceContext } from './converters';
import { AzureFunctionsRpcMessages as rpc } from '../azure-functions-language-worker-protobuf/src/rpc';
import { Request, RequestProperties } from './http/Request';
import { Response } from './http/Response';
import LogLevel = rpc.RpcLog.Level;
import LogCategory = rpc.RpcLog.RpcLogCategory;
import { Context, ExecutionContext, Logger, BindingDefinition, HttpRequest, TraceContext } from './public/Interfaces' 

export function CreateContextAndInputs(info: FunctionInfo, request: rpc.IInvocationRequest, logCallback: LogCallback, callback: ResultCallback) {
    let context = new InvocationContext(info, request, logCallback, callback);

    let bindings: Dict<any> = {};
    let inputs: InputTypes[] = [];
    let httpInput: RequestProperties | undefined;
    for (let binding of <rpc.IParameterBinding[]>request.inputData) {
        if (binding.data && binding.name) {
            let input: InputTypes;
            if (binding.data && binding.data.http) {
                input = httpInput = fromRpcHttp(binding.data.http);
            } else {
                input = fromTypedData(binding.data);
            }
            bindings[binding.name] = input;
            inputs.push(input);
        }
    }

    context.bindings = bindings;
    if (httpInput) {
        context.req = new Request(httpInput);
        context.res = new Response(context.done);
    }
    return {
        context: <Context>context,
        inputs: inputs
    }
}

class InvocationContext implements Context {
    invocationId: string;
    executionContext: ExecutionContext;
    bindings: Dict<any>;
    bindingData: Dict<any>;
    traceContext: TraceContext;
    bindingDefinitions: BindingDefinition[];
    log: Logger;
    req?: Request;
    res?: Response;
    done: DoneCallback;

    constructor(info: FunctionInfo, request: rpc.IInvocationRequest, logCallback: LogCallback, callback: ResultCallback) {
        this.invocationId = <string>request.invocationId;
        this.traceContext = fromRpcTraceContext(request.traceContext);
        const executionContext = {
            invocationId: this.invocationId,
            functionName: <string>info.name,
            functionDirectory: <string>info.directory
        };
        this.executionContext = executionContext;
        this.bindings = {};
        let _done = false;
        let _promise = false;

        // Log message that is tied to function invocation
        this.log = Object.assign(
            <ILog>(...args: any[]) => logWithAsyncCheck(_done, logCallback, LogLevel.Information, executionContext, ...args),
            {
                error: <ILog>(...args: any[]) => logWithAsyncCheck(_done, logCallback, LogLevel.Error, executionContext, ...args),
                warn: <ILog>(...args: any[]) => logWithAsyncCheck(_done, logCallback, LogLevel.Warning, executionContext, ...args),
                info: <ILog>(...args: any[]) => logWithAsyncCheck(_done, logCallback, LogLevel.Information, executionContext, ...args),
                verbose: <ILog>(...args: any[]) => logWithAsyncCheck(_done, logCallback, LogLevel.Trace, executionContext, ...args)
            }
        );

        this.bindingData = getNormalizedBindingData(request);
        this.bindingDefinitions = getBindingDefinitions(info);

        // isPromise is a hidden parameter that we set to true in the event of a returned promise
        this.done = (err?: any, result?: any, isPromise?: boolean) => {
            _promise = isPromise === true;
            if (_done) {
                if (_promise) {
                    logCallback(LogLevel.Error, LogCategory.User, "Error: Choose either to return a promise or call 'done'.  Do not use both in your script.");
                } else {
                    logCallback(LogLevel.Error, LogCategory.User, "Error: 'done' has already been called. Please check your script for extraneous calls to 'done'.");
                }
                return;
            }
            _done = true;

            // Allow HTTP response from context.res if HTTP response is not defined from the context.bindings object
            if (info.httpOutputName && this.res && this.bindings[info.httpOutputName] === undefined) {
                this.bindings[info.httpOutputName] = this.res;
            }

            callback(err, {
                return: result,
                bindings: this.bindings
            });
        };
    }
}

// Emit warning if trying to log after function execution is done.
function logWithAsyncCheck(done: boolean, log: LogCallback, level: LogLevel, executionContext: ExecutionContext, ...args: any[]) {
    if (done) {
        let badAsyncMsg = "Warning: Unexpected call to 'log' on the context object after function execution has completed. Please check for asynchronous calls that are not awaited or calls to 'done' made before function execution completes. ";
        badAsyncMsg += `Function name: ${executionContext.functionName}. Invocation Id: ${executionContext.invocationId}. `;
        badAsyncMsg += `Learn more: https://go.microsoft.com/fwlink/?linkid=2097909 `;
        log(LogLevel.Warning, LogCategory.System, badAsyncMsg);
    }
    return log(level, LogCategory.User, ...args);
}

export interface InvocationResult {
    return: any;
    bindings: Dict<any>;
}

export type DoneCallback = (err?: Error | string, result?: any) => void;

export type LogCallback = (level: LogLevel, category: rpc.RpcLog.RpcLogCategory, ...args: any[]) => void;

export type ResultCallback = (err?: any, result?: InvocationResult) => void;

export interface Dict<T> {
    [key: string]: T
}

// Allowed input types
export type InputTypes = HttpRequest | string | Buffer | null | undefined;
