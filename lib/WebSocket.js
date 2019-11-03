import { now } from 'fp-ts/lib/Date';
import { isLeft, isRight, left, right } from 'fp-ts/lib/Either';
import { exists, fold, fromNullable, isSome } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import { chain, fromIO, of } from 'fp-ts/lib/Task';
import { fromIOEither } from 'fp-ts/lib/TaskEither';
import { capDelay, exponentialBackoff, limitRetries, monoidRetryPolicy } from 'retry-ts';
import { retrying } from 'retry-ts/lib/Task';
import { GQL_CONNECTION_ACK, GQL_CONNECTION_ERROR } from './GQLMessage';
import { DEFAULT_EVENT_LISTENERS, extractTypeFromParsedMessage, getConnectionInitMessage, lazyIOVoid, parseReceivedMessage } from './shared';
const DEFAULT_RETRY_POLICY = capDelay(5000, monoidRetryPolicy.concat(exponentialBackoff(200), limitRetries(5)));
const DEFAULT_CONNECTION_TIMEOUT = 1000;
const LIVE_WEB_SOCKETS = new Map();
function getOpenWebSocket(url) {
    return () => {
        return fromNullable(LIVE_WEB_SOCKETS.get(url));
    };
}
function setNewWebSocket(url, ws) {
    return () => {
        LIVE_WEB_SOCKETS.set(url, ws);
        return ws;
    };
}
function attachListeners(ws, { close = [], error = [], message = [] }) {
    return () => {
        if (isRight(ws)) {
            close.forEach(listener => ws.right.addEventListener('close', listener));
            message.forEach(listener => ws.right.addEventListener('message', listener));
            error.forEach(listener => ws.right.addEventListener('error', listener));
        }
        return ws;
    };
}
export function getWebSocket({ webSocketConstructor, url, retryPolicy = DEFAULT_RETRY_POLICY, connectionTimeout = DEFAULT_CONNECTION_TIMEOUT, protocols = 'graphql-ws', eventListeners = DEFAULT_EVENT_LISTENERS, connectionParams }) {
    return pipe(fromIO(getOpenWebSocket(url)), chain(ws => isSome(ws)
        ? of(ws.value)
        : pipe(retrying(retryPolicy, attemptConnection(webSocketConstructor, url, protocols, connectionTimeout, eventListeners.open, connectionParams), isLeft), chain(newWs => fromIOEither(attachListeners(newWs, eventListeners))), chain(newWS => fromIOEither(setNewWebSocket(url, newWS))))));
}
function attemptConnection(Constructor, url, protocols = 'graphql', connectionTimeout = DEFAULT_CONNECTION_TIMEOUT, openListeners = [], connectionParams) {
    return status => () => {
        return new Promise(resolve => {
            const ws = new Constructor(url, protocols);
            const timeout = setTimeout(() => {
                ws.close();
                clearTimeout(timeout);
                resolve(left({
                    type: 'Connection timed out',
                    timestamp: now()
                }));
            }, connectionTimeout);
            const initListener = sendInitMessage(ws, connectionParams);
            [initListener, ...openListeners].forEach(listener => ws.addEventListener('open', listener));
            const ackListener = (message) => {
                if (isAckMessage(message)) {
                    ws.removeEventListener('message', ackListener);
                    ws.removeEventListener('open', initListener);
                    resolve(right(ws));
                }
            };
            const connectionErrorListener = (message) => {
                if (isConnectionErrorMessage(message)) {
                    ws.removeEventListener('message', connectionErrorListener);
                    ws.removeEventListener('open', initListener);
                    resolve(left({
                        type: 'The server responded with a connection error',
                        timestamp: now()
                    }));
                }
            };
            ws.addEventListener('message', ackListener);
        });
    };
}
function sendInitMessage(ws, connectionParams) {
    return pipe(getConnectionInitMessage(typeof connectionParams === 'function' ? connectionParams() : connectionParams), fold(lazyIOVoid, message => () => ws.send(message)));
}
function isAckMessage(message) {
    return pipe(parseReceivedMessage(message.data), extractTypeFromParsedMessage, exists(type => type === GQL_CONNECTION_ACK));
}
function isConnectionErrorMessage(message) {
    return pipe(parseReceivedMessage(message.data), extractTypeFromParsedMessage, exists(type => type === GQL_CONNECTION_ERROR));
}
