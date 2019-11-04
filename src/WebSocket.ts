import { now } from 'fp-ts/lib/Date';
import { Either, isLeft, isRight, left, right } from 'fp-ts/lib/Either';
import { constant, Lazy } from 'fp-ts/lib/function';
import { IO } from 'fp-ts/lib/IO';
import { IOEither } from 'fp-ts/lib/IOEither';
import { exists, fold, fromNullable, isSome, Option } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import { chain, fromIO } from 'fp-ts/lib/Task';
import { TaskEither, fromIOEither } from 'fp-ts/lib/TaskEither';
import { capDelay, exponentialBackoff, limitRetries, monoidRetryPolicy, RetryPolicy, RetryStatus } from 'retry-ts';
import { retrying } from 'retry-ts/lib/Task';
import { GQL_CONNECTION_ACK, GQL_CONNECTION_ERROR } from './GQLMessage';
import {
  DEFAULT_EVENT_LISTENERS,
  extractTypeFromParsedMessage,
  getConnectionInitMessage,
  lazyIOVoid,
  parseReceivedMessage
} from './shared';

export interface ConnectionError {
  readonly type:
    | 'Connection timed out'
    | 'Invalid url'
    | 'The server responded with a connection error'
    | 'Connection has been closed';
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

const DEFAULT_RETRY_POLICY = capDelay(5000, monoidRetryPolicy.concat(exponentialBackoff(200), limitRetries(5)));

const DEFAULT_CONNECTION_TIMEOUT = 5000;

const LIVE_WEB_SOCKETS: Map<string, Promise<Either<ConnectionError, WebSocket>>> = new Map();

function getOpenWebSocket(url: string): IO<Option<Promise<Either<ConnectionError, WebSocket>>>> {
  return () => {
    return fromNullable(LIVE_WEB_SOCKETS.get(url));
  };
}

function setNewWebSocket(url: string, ws: Either<ConnectionError, WebSocket>): IOEither<ConnectionError, WebSocket> {
  return () => {
    LIVE_WEB_SOCKETS.set(url, Promise.resolve(ws));
    return ws;
  };
}

function setPendingWebSocket(url: string, ws: Promise<Either<ConnectionError, WebSocket>>): IO<void> {
  return () => {
    LIVE_WEB_SOCKETS.set(url, ws);
  };
}

function attachListeners(
  ws: Either<ConnectionError, WebSocket>,
  { close = [], error = [], message = [] }: Partial<Omit<WebSocketEventListeners, 'open'>>
): IO<Either<ConnectionError, WebSocket>> {
  return () => {
    if (isRight(ws)) {
      close.forEach(listener => ws.right.addEventListener('close', listener));
      message.forEach(listener => ws.right.addEventListener('message', listener));
      error.forEach(listener => ws.right.addEventListener('error', listener));
    }
    return ws;
  };
}

export function getWebSocket<WS extends typeof WebSocket>({
  webSocketConstructor,
  url,
  retryPolicy = DEFAULT_RETRY_POLICY,
  connectionTimeout = DEFAULT_CONNECTION_TIMEOUT,
  protocols = 'graphql-ws',
  eventListeners = DEFAULT_EVENT_LISTENERS,
  connectionParams
}: WebSocketConfig<WS>): TaskEither<ConnectionError, WebSocket> {
  return pipe(
    fromIO(getOpenWebSocket(url)),
    chain(ws =>
      isSome(ws)
        ? constant(ws.value)
        : pipe(
            retrying<Either<ConnectionError, WebSocket>>(
              retryPolicy,
              attemptConnection(
                webSocketConstructor,
                url,
                protocols,
                connectionTimeout,
                eventListeners.open,
                connectionParams
              ),
              isLeft
            ),
            chain(newWs => fromIOEither(attachListeners(newWs, eventListeners))),
            chain(newWS => fromIOEither(setNewWebSocket(url, newWS)))
          )
    )
  );
}

function attemptConnection<WS extends typeof WebSocket>(
  Constructor: WS,
  url: string,
  protocols: string | string[] = 'graphql',
  connectionTimeout: number = DEFAULT_CONNECTION_TIMEOUT,
  openListeners: Array<(ev: Event) => void> = [],
  connectionParams?: any | Lazy<any>
): (status: RetryStatus) => TaskEither<ConnectionError, WebSocket> {
  return status => () => {
    const p: Promise<Either<ConnectionError, WebSocket>> = new Promise(resolve => {
      const ws = new Constructor(url, protocols);
      const timeout = setTimeout(() => {
        ws.close();
        resolve(
          left({
            type: 'Connection timed out',
            timestamp: now()
          })
        );
      }, connectionTimeout);
      const initListener = sendInitMessage(ws, connectionParams);
      [initListener, ...openListeners].forEach(listener => ws.addEventListener('open', listener));
      const ackListener = (message: MessageEvent) => {
        if (isAckMessage(message)) {
          clearTimeout(timeout);
          ws.removeEventListener('message', ackListener);
          ws.removeEventListener('open', initListener);
          resolve(right(ws));
        }
      };
      const connectionErrorListener = (message: MessageEvent) => {
        if (isConnectionErrorMessage(message)) {
          clearTimeout(timeout);
          ws.removeEventListener('message', connectionErrorListener);
          ws.removeEventListener('open', initListener);
          resolve(
            left({
              type: 'The server responded with a connection error',
              timestamp: now()
            })
          );
        }
      };
      ws.addEventListener('message', ackListener);
      ws.addEventListener('message', connectionErrorListener);
    });
    setPendingWebSocket(url, p)();
    return p;
  };
}

function sendInitMessage(ws: WebSocket, connectionParams?: any | Lazy<any>): IO<void> {
  return pipe(
    getConnectionInitMessage(typeof connectionParams === 'function' ? connectionParams() : connectionParams),
    fold(lazyIOVoid, message => () => ws.send(message))
  );
}

function isAckMessage(message: MessageEvent): boolean {
  return pipe(
    parseReceivedMessage(message.data),
    extractTypeFromParsedMessage,
    exists(type => type === GQL_CONNECTION_ACK)
  );
}

function isConnectionErrorMessage(message: MessageEvent): boolean {
  return pipe(
    parseReceivedMessage(message.data),
    extractTypeFromParsedMessage,
    exists(type => type === GQL_CONNECTION_ERROR)
  );
}
