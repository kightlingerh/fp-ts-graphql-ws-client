import { Lazy } from 'fp-ts/lib/function';
import { TaskEither } from 'fp-ts/lib/TaskEither';
import { RetryPolicy } from 'retry-ts';
export interface ConnectionError {
    readonly type: 'Connection timed out' | 'Invalid url' | 'The server responded with a connection error' | 'Connection has been closed';
    readonly timestamp: number;
}
export interface WebSocketEventListeners {
    close: Array<(ev: CloseEvent) => void>;
    error: Array<(ev: Event) => void>;
    message: Array<(message: MessageEvent) => void>;
    open: Array<(ev: Event) => void>;
}
/** Provides the API for creating and managing a WebSocket connection to a server, as well as for sending and receiving data on the connection. */
export interface WebSocketConfig<WS extends typeof WebSocket> {
    webSocketConstructor: WS;
    url: string;
    connectionTimeout?: number;
    retryPolicy?: RetryPolicy;
    protocols?: string | [];
    eventListeners?: Partial<WebSocketEventListeners>;
    connectionParams?: any | Lazy<any>;
}
export declare function getWebSocket<WS extends typeof WebSocket>({ webSocketConstructor, url, retryPolicy, connectionTimeout, protocols, eventListeners, connectionParams }: WebSocketConfig<WS>): TaskEither<ConnectionError, WebSocket>;
