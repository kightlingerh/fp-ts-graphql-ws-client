import { tryCatch as tryCatchE } from 'fp-ts/lib/Either';
import { constant, constVoid } from 'fp-ts/lib/function';
import { chain, fromEither, fromPredicate, mapNullable, none, tryCatch } from 'fp-ts/lib/Option';
import { pipe } from 'fp-ts/lib/pipeable';
import { GQL_CONNECTION_INIT, isGQLServerMessage } from './GQLMessage';
export function isObject(obj) {
    return obj !== null && typeof obj === 'object';
}
export function parseReceivedMessage(payload) {
    return tryCatchE(() => {
        const result = JSON.parse(payload);
        if (isObject(result)) {
            return result;
        }
        else {
            throw new Error();
        }
    }, () => getClientError({
        otherErrors: [new Error(`Message must be a JSON-parsable object. Got: ${payload}`)]
    }));
}
export function getClientError({ connectionError = none, graphqlErrors = [], otherErrors = [] }) {
    return {
        connectionError,
        graphqlErrors,
        otherErrors
    };
}
export function constructMessage(id, type, payload) {
    return tryCatch(() => JSON.stringify({
        id,
        type,
        payload
    }));
}
export function getConnectionInitMessage(connectionParams) {
    return constructMessage(undefined, GQL_CONNECTION_INIT, connectionParams);
}
export function sendRawMessage(ws) {
    return (message) => () => ws.send(message);
}
export function extractTypeFromParsedMessage(parsedMessage) {
    return pipe(fromEither(parsedMessage), mapNullable(message => message.type), chain(fromPredicate(isGQLServerMessage)));
}
export const lazyIOVoid = constant(constVoid);
export const DEFAULT_EVENT_LISTENERS = {
    open: [],
    close: [],
    message: [],
    error: []
};
